import chalk from 'chalk'
import {Command} from 'clipanion'

import {DATADOG_SITE_GOV} from '../../constants'
import {ApiKeyValidator, newApiKeyValidator} from '../../helpers/apikey'
import {InvalidConfigurationError} from '../../helpers/errors'
import {ICONS} from '../../helpers/formatting'
import {RequestBuilder} from '../../helpers/interfaces'
import {Logger, LogLevel} from '../../helpers/logger'
import {MetricsLogger, getMetricsLogger} from '../../helpers/metrics'
import {UploadStatus} from '../../helpers/upload'
import {getRequestBuilder, timedExecAsync} from '../../helpers/utils'

import {apiHost, datadogSite, getBaseIntakeUrl} from './api'
import {getCommitInfo, newSimpleGit} from './git'
import {uploadToGitDB} from './gitdb'
import {CommitInfo} from './interfaces'
import {uploadRepository} from './library'
import {
  renderCommandInfo,
  renderConfigurationError,
  renderDryRunWarning,
  renderFailedUpload,
  renderRetriedUpload,
  renderSuccessfulCommand,
} from './renderer'

export class UploadCommand extends Command {
  public static usage = Command.Usage({
    description: 'Report the current commit details to Datadog.',
    details: `
      This command will upload the commit details to Datadog in order to create links to your repositories inside Datadog's UI.\n
      See README for details.

      Option --git-sync is DEPRECATED and will be removed in a future version.
    `,
    examples: [['Upload the current commit details', 'datadog-ci report-commits upload']],
  })

  public repositoryURL?: string

  private cliVersion: string
  private config = {
    apiKey: process.env.DATADOG_API_KEY,
  }
  private dryRun = false
  private verbose = false
  private gitSync = false
  private noGitSync = false
  private directory = ''
  private logger: Logger = new Logger((s: string) => {
    this.context.stdout.write(s)
  }, LogLevel.INFO)

  constructor() {
    super()
    this.cliVersion = require('../../../package.json').version
  }

  public async execute() {
    const initialTime = Date.now()
    if (this.verbose) {
      this.logger = new Logger((s: string) => {
        this.context.stdout.write(s)
      }, LogLevel.DEBUG)
    }
    if (this.dryRun) {
      this.logger.warn(renderDryRunWarning())
    }

    if (this.directory) {
      // change working dir
      process.chdir(this.directory)
    }

    if (!this.config.apiKey) {
      this.logger.error(
        renderConfigurationError(
          new InvalidConfigurationError(`Missing ${chalk.bold('DATADOG_API_KEY')} in your environment`)
        )
      )

      return 1
    }

    if (this.gitSync) {
      this.logger.warn('Option --git-sync is deprecated as it is now the default behavior')
    }

    const metricsLogger = getMetricsLogger({
      datadogSite: process.env.DATADOG_SITE,
      defaultTags: [`cli_version:${this.cliVersion}`],
      prefix: 'datadog.ci.report_commits.',
    })
    const apiKeyValidator = newApiKeyValidator({
      apiKey: this.config.apiKey,
      datadogSite,
      metricsLogger: metricsLogger.logger,
    })

    const apiRequestBuilder = this.getApiRequestBuilder(this.config.apiKey)
    const srcmapRequestBuilder = this.getSrcmapRequestBuilder(this.config.apiKey)

    let inError = false
    try {
      this.logger.info('Uploading list of tracked files...')
      const elapsed = await timedExecAsync(this.uploadToSrcmapTrack.bind(this), {
        requestBuilder: srcmapRequestBuilder,
        apiKeyValidator,
        metricsLogger,
      })
      metricsLogger.logger.increment('sci.success', 1)
      this.logger.info(`${this.dryRun ? '[DRYRUN] ' : ''}Successfully uploaded tracked files in ${elapsed} seconds.`)
    } catch (err) {
      this.logger.error(`Failed upload of tracked files: ${err}`)
      inError = true
    }

    if (!this.noGitSync) {
      try {
        this.logger.info('Syncing GitDB...')
        const elapsed = await timedExecAsync(this.uploadToGitDB.bind(this), {
          requestBuilder: apiRequestBuilder,
        })
        metricsLogger.logger.increment('gitdb.success', 1)
        this.logger.info(`${this.dryRun ? '[DRYRUN] ' : ''}Successfully synced git DB in ${elapsed} seconds.`)
      } catch (err) {
        if (!this.isTargetingGov()) {
          this.logger.warn(`Could not write to GitDB: ${err}`)
        } else {
          // Skip the warning for Gov DC since git sync is not available there yet.
          this.logger.warn(`Not writing to GitDB: not available for gov`)
        }
      }
    }

    try {
      await metricsLogger.flush()
    } catch (err) {
      this.logger.warn(`WARN: ${err}`)
    }
    if (inError) {
      this.logger.error('Command failed. See messages above for more details.')

      return 1
    }
    this.logger.info(renderSuccessfulCommand((Date.now() - initialTime) / 1000, this.dryRun))

    return 0
  }

  private async uploadToGitDB(opts: {requestBuilder: RequestBuilder}) {
    await uploadToGitDB(this.logger, opts.requestBuilder, await newSimpleGit(), this.dryRun, this.repositoryURL)
  }

  private async uploadToSrcmapTrack(opts: {
    requestBuilder: RequestBuilder
    apiKeyValidator: ApiKeyValidator
    metricsLogger: MetricsLogger
  }) {
    const generatePayload = async () => {
      try {
        return await getCommitInfo(await newSimpleGit(), this.repositoryURL)
      } catch (e) {
        if (e instanceof Error) {
          this.logger.error(renderFailedUpload(e.message))
        }
        throw e
      }
    }

    const sendPayload = async (commit: CommitInfo) => {
      let status
      if (this.dryRun) {
        status = UploadStatus.Success
      } else {
        status = await uploadRepository(opts.requestBuilder, this.cliVersion)(commit, {
          apiKeyValidator: opts.apiKeyValidator,
          onError: (e) => {
            this.logger.error(renderFailedUpload(e.message))
            opts.metricsLogger.logger.increment('sci.failed', 1)
          },
          onRetry: (e, attempt) => {
            this.logger.warn(renderRetriedUpload(e.message, attempt))
            opts.metricsLogger.logger.increment('sci.retries', 1)
          },
          onUpload: () => {
            return
          },
          retries: 5,
        })
      }
      if (status !== UploadStatus.Success) {
        this.logger.error(`${ICONS.FAILED} Error uploading commit information.`)
        throw new Error('Could not upload commit information')
      }
    }

    const payload = await generatePayload()
    this.logger.info(renderCommandInfo(payload))
    await sendPayload(payload)
  }

  private getSrcmapRequestBuilder(apiKey: string): RequestBuilder {
    return getRequestBuilder({
      apiKey,
      baseUrl: getBaseIntakeUrl(),
      headers: new Map([
        ['DD-EVP-ORIGIN', 'datadog-ci git-metadata'],
        ['DD-EVP-ORIGIN-VERSION', this.cliVersion],
      ]),
      overrideUrl: 'api/v2/srcmap',
    })
  }

  private getApiRequestBuilder(apiKey: string): RequestBuilder {
    return getRequestBuilder({
      apiKey,
      baseUrl: 'https://' + apiHost,
    })
  }

  private isTargetingGov(): boolean {
    return process.env.DATADOG_SITE === DATADOG_SITE_GOV
  }
}

UploadCommand.addPath('git-metadata', 'upload')
UploadCommand.addOption('dryRun', Command.Boolean('--dry-run'))
UploadCommand.addOption('verbose', Command.Boolean('--verbose'))
UploadCommand.addOption('gitSync', Command.Boolean('--git-sync'))
UploadCommand.addOption('noGitSync', Command.Boolean('--no-gitsync'))
UploadCommand.addOption('directory', Command.String('--directory'))
UploadCommand.addOption('repositoryURL', Command.String('--repository-url'))
