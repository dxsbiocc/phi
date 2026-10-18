import { connectorCopyZh } from './connectorCopy.zh-CN'
import { defineCopy } from '../../../lib/i18n'

/** Bilingual management copy; author content and protocol values stay unchanged. */
const connectorCopyEn = {
  apiKeyLabel: 'API key',
  resizeSidebar: 'Resize sidebar',
  searchConnectors: 'Search Connectors',
  noConfiguredMatches: 'No matching configured Connectors',
  noConfigured: 'No Connectors configured. Select Discover to browse the catalog.',
  customLocal: 'Custom · Local',
  serpApiDisclosure:
    'SerpApi requires the key to be sent once in an HTTPS query parameter for verification. Phi does not save that URL; the provider or a network proxy may log it.',
  existingKeyHint:
    'A verified key is already saved. Add directly, or enter a new key to replace it.',
  verifying: 'Verifying…',
  verifyUpdate: 'Verify and update',
  verifySave: 'Verify and save',
  verifyAdd: 'Verify and add',
  addConnector: 'Add Connector',
  addCustomMenu: 'Add custom Connector…',
  importGithubMenu: 'Import from GitHub…',
  manageSourcesMenu: 'Manage sources…',
  localStartFailed: 'Local service failed to start',
  keyApiMissing: 'The local key interface is not loaded',
  cannotRemove: 'This Connector cannot be removed from Phi',
  authApiMissing: 'The authorization interface is not loaded. Restart Phi and try again.',
  connectorApiMissing:
    'The Connector interface is not loaded. Reload the Phi window and try again.',
  runtimeRefreshNeeded: 'The runtime has not loaded the new Connector. Restart Phi and try again.',
  toolsApiMissing: 'The tool query interface is not loaded. Restart Phi and try again.',
  searchResults: 'Search results',
  backTo: '← Back to',
  closeCatalog: 'Close Connector catalog',
  connectorGroups: 'Connector groups',
  loadingConnectors: 'Loading Connectors…',
  noMatches: 'No matching Connectors',
  emptyGroup: 'No Connectors in this group',
  defaultSort: 'Default',
  configuredFirst: 'Configured first',
  filter: 'Filter',
  sort: 'Sort:',
  signInMethod: 'Sign-in method',
  configuredState: 'Configuration status',
  configured: 'Configured',
  notConfigured: 'Not configured',
  firstStartDownload:
    'The first start may download required files. Keep your network connection active.',
  customEmpty:
    'No custom Connectors yet. Use + in the upper right to add a local or remote Connector.',
  addFailed: 'Add failed',
  needsSetup: 'Setup required',
  viewProgress: 'View progress',
  commandNotConfigured: 'No command configured',
  confirmRemove: 'Confirm removal',
  removeLocalConfirm: 'Remove this local stdio Connector?',
  removeRemoteConfirm: 'Remove this remote HTTPS Connector?',
  mcpUrl: 'MCP URL',
  command: 'Command',
  environmentNames: 'Environment variable names',
  addCustomConnector: 'Add custom Connector',
  connectorType: 'Connector type',
  remoteHttps: 'Remote (HTTPS)',
  localStdio: 'Local (stdio)',
  bunMissing: "Phi's bundled Bun was not found. Check the application installation.",
  chooseReadyRuntime: 'Choose a ready Phi runtime',
  remoteNameHint: 'Use letters, numbers, underscores or hyphens',
  serverUrl: 'Server URL',
  advancedSettings: 'Advanced settings',
  optionalClientId: 'OAuth Client ID (optional)',
  clientIdRequired: 'Client ID is required when using a Client Secret',
  optionalClientSecret: 'OAuth Client Secret (optional)',
  cancelAuthorization: 'Cancel authorization',
  starting: 'Starting…',
  add: 'Add',
  authorizing: 'Authorizing…',
  adding: 'Adding…',
  localConfiguration: 'Local configuration',
  serverProject: 'Server project',
  noServer: 'No MCP server found',
  configuredAuthUnverified: 'Configured · Authorization unverified',
  authorizationUnavailable: 'Authorization unavailable',
  waitingAuthorization: 'Waiting for authorization',
  verified: 'Verified',
  signedIn: 'Signed in',
  checking: 'Checking',
  configuredStatusUnavailable: 'Configured · Status unavailable',
  statusUnavailable: 'Status unavailable',
  configuredKeyUnverified: 'Configured · API key unverified',
  apiKeyRequired: 'API key required',
  configuredSignInRequired: 'Configured · Sign-in required',
  signInRequired: 'Sign-in required',
  newerPhiRequired: 'Newer Phi required',
  environmentNotBuilt: 'Environment not built',
  buildEnvironment: 'Build environment',
  updateNewerPhiRequired: 'Update requires a newer Phi',
  retryConnection: 'Retry connection',
  replaceKey: 'Replace key',
  verifyApiKey: 'Verify API key',
  reauthorize: 'Authorize again',
  authorizeSignIn: 'Sign in',
  signInUnavailable: 'Sign-in unavailable',
  gmailAuthUnavailable:
    'Gmail MCP requires the service to be enabled in Google Cloud and an OAuth client configured for Phi. This setup is not available in Phi yet, so the Connector cannot be authorized or added from the catalog.',
  slackAuthUnavailable:
    'Slack MCP requires a registered Slack app and an OAuth client. This setup is not available in Phi yet, so the Connector cannot be authorized or added from the catalog.',
  oauthUnavailable:
    'This service requires OAuth sign-in. Phi does not support its authorization flow yet, so it cannot be added from the catalog.',
  composioAuthHint:
    'After signing in to Composio, authorize individual apps as needed. Composio manages third-party accounts.',
  serviceOverview: 'Service overview',
  verifiedKeyReplaceHint:
    'The API key is verified and saved encrypted on this device. Select Replace key in the upper right to change it.',
  verifiedKeyAddHint:
    'The API key is verified and saved encrypted on this device. You can add the Connector directly.',
  checkingKey: 'Checking API key verification…',
  keyStatusUnavailable: 'API key status is unavailable. Try verifying again later.',
  unverifiedKeyHint:
    'Configuration is saved, but the API key is unverified. Select Verify API key in the upper right before using this Connector.',
  keyNeededHint:
    'This Connector requires an API key. Select Add Connector in the upper right to verify and save it.',
  localStartHint:
    'Adding this Connector prepares its environment and starts the local service. The first start may download required files.',
  toolsAfterKey: 'Verify the API key to read server tools.',
  toolsAfterSignIn: 'Sign in to read server tools.',
  publisher: 'Publisher',
  launchCommand: 'Launch command',
  category: 'Category',
  signIn: 'Sign-in',
  apiKeyVerified: 'API key verified',
  apiKeyUnverified: 'API key unverified',
  configurationLocation: 'Configuration location',
  moreInformation: 'More information',
  connectorDocs: 'Connector documentation ↗',
  previewing: 'Previewing…',
  preview: 'Preview',
  importing: 'Importing…',
  import: 'Import',
  addLocalStdio: 'Add as local stdio…',
  importSource: 'Import source',
  importSourceHint:
    'Connectors from this repository will appear in the catalog. Installation still requires approval.',
  repositoryUrl: 'Repository URL',
  commit: 'Commit',
  unsignedImportHint: 'Unsigned · User import. Commands run only when the Connector is installed.',
  confirmUnsignedInstall: 'Confirm unsigned Connector installation',
  unsignedInstallHint:
    'This Connector comes from a user-imported source. After installation, it may run commands on this device.',
  unsignedSuffix: '· Unsigned',
  confirmContinue: 'Confirm and continue',
  bundledBun: 'Phi bundled Bun',
  hostRuntime: 'Host command (not isolated)',
  confirmLocalAdd: 'Confirm local Connector',
  runtimeLocation: 'Runtime',
  launchArguments: 'Launch arguments',
  environmentVariables: 'Environment variables',
  none: 'None',
  workingDirectory: 'Working directory',
  hostWarning: 'Runs directly on this device without a Phi isolated environment',
  bunWarning:
    "Runs with Phi's bundled Bun in Node compatibility mode; some dependencies may be incompatible. The x command resolves dependencies online at every start without locking versions.",
  backgroundStartHint:
    'After confirmation, startup and verification run in the background. You can continue working and view progress in Background tasks. The first run downloads dependencies and may take a few minutes.',
  submitting: 'Submitting…',
  confirmBackgroundAdd: 'Confirm and add in background',
  localNameHint: 'Use 2–64 letters, numbers, underscores or hyphens, starting with a letter',
  chooseRuntime: 'Choose a runtime',
  loadingRuntimes: 'Loading available runtimes…',
  noReadyRuntime: 'No Phi runtime is ready. You can use a host command.',
  readyRuntimesHint: 'Only built and ready Phi runtimes are listed',
  bunX: 'x (run npm package)',
  bunRun: 'run (run script)',
  bunCommandHint: 'x runs an npm package; run runs a script',
  absoluteCommandExample: '/absolute/path/to/mcp-server',
  absoluteCommandHint: "Enter the executable's absolute path",
  environmentCommandHint: "Enter a command name from the environment's PATH",
  arguments: 'Arguments',
  scriptArgsHint: 'Absolute script path, with one argument per line',
  bunXArgsHint: 'For example, --bun and package@version, one per line',
  argsHint: 'One argument per line. Blank lines are ignored; arguments are not parsed by a shell.',
  addVariable: 'Add variable',
  nonSensitiveVariablesHint: 'Use only for non-sensitive configuration. Do not enter secrets here.',
  optionalWorkingDirectory: 'Working directory (optional)',
  workingDirectoryHint: 'Must be an absolute path to an existing directory',
  commandPreview: 'Command preview',
  commandPreviewHint: 'Enter a command to see the full argv',
  buildRequired: 'Build required',
  publishedNpm: 'Published on npm',
  viewReadme: 'View README ↗',
  verifyNpmPublisher: 'Verify publisher on npmjs.com ↗',
  sourceUpdated: 'Source updated',
  sourceRemoved: 'Source removed. Installed Connectors are kept.',
  manageSources: 'Manage sources',
  noGithubSources: 'No GitHub sources added',
  done: 'Done',
  confirmSourceUpdate: 'Confirm source update',
  confirmUpdate: 'Confirm update',
  removeSource: 'Remove source?',
  removeSourceHint: 'The source will be removed from the catalog. Installed Connectors are kept.',
  serverTools: 'Server tools',
  refreshTools: 'Refresh tools',
  unverifiedToolsHint:
    'Authorization is unverified. The tools currently offered by this service cannot be read yet.',
  loadingTools: 'Loading server tools…',
  toolsUnread: 'Server tools have not been loaded.',
  noServerTools: 'The server currently exposes no tools.',
  collapse: 'Show less',
  showAll: 'Show all',
  environmentVariableName: 'Environment variable name',
  httpsUrl: 'HTTPS URL',
  trustServerConfig: 'Trust server project MCP configuration',
  remoteCommandWarning:
    'stdio Connectors can run arbitrary commands on the server. Review the complete command, every argument and each environment variable name.',
  confirmTrust: 'Confirm and trust',
  serverProjectMcp: 'Server project MCP',
  revokeTrust: 'Revoke trust',
  trustAgain: 'Trust again',
  trust: 'Trust',
  setupDownloading: 'Downloading Connector files',
  setupInstalling: 'Installing Connector',
  setupEnvironment: 'Preparing the runtime',
  setupStarting: 'Starting and checking the local service',
  connectionVerified: 'Connection verified',
  notInstalled: 'Not installed',
  setupFailed: 'Setup failed',
  toolsPreparing: 'Preparing the local service. Tools will load when it is ready.',
  toolsAfterAdd: 'Add the Connector and prepare its local service to read server tools.',
  toolsAfterEnvironment: 'Prepare the runtime to start the local service and read tools.',
  unknownError: 'Unknown error',
  setupIntent: 'complete initialization and configuration for',
  debugIntent: 'troubleshoot startup for',
  setupPromptInstructions:
    "Read this service's documentation first, identify the required initialization and configuration, and tell me what I need to provide. Draft any initialization commands in the terminal using terminal drafts, with authorization codes, keys and other secrets marked as required inputs for me to confirm and enter directly in the terminal. Do not ask me to paste secrets into chat or write them to files, logs or command-line arguments. When finished, tell me to return to Background tasks and select Retry.",
  customRemote: 'Custom · Remote',
  authTimeout:
    'Sign-in was not completed within two minutes, so authorization was cancelled. You can try again.',
  authBackendMissing: 'The authorization interface is not loaded. Restart Phi and try again.',
  enterGithubUrl: 'Enter a GitHub repository URL',
  githubEncodedPath: 'GitHub repository URLs must not contain encoded paths',
  githubInvalidUrl: 'Invalid GitHub repository URL',
  githubUrlConstraints:
    'Use an https://github.com repository URL without credentials, a port or query parameters',
  githubInvalidRepo: 'Invalid GitHub repository name',
  githubInvalidPath: 'Invalid GitHub repository path',
  githubInvalidRef: 'Invalid GitHub branch or commit reference',
  envLimit: 'Use at most 32 environment variables',
  localNameInvalid:
    'Connector names must contain 2–64 letters, numbers, underscores or hyphens, starting with a letter',
  validCommandRequired: 'Enter a valid command',
  environmentCommandInvalid: 'Environment commands must be command names without a path',
  bunCommandInvalid: 'Phi bundled Bun commands must be x or run',
  hostCommandInvalid: 'Host commands must use an absolute path',
  argsLimit: 'Use at most 64 arguments',
  argLengthLimit: 'Each argument must be at most 4096 characters',
  argNullInvalid: 'Arguments must not contain NUL',
  workingDirectoryInvalid: 'Working directory must use an absolute path',
  viewBackgroundTasks: 'View Background tasks',
  resolveSetup: 'Resolve setup',
  noSignIn: 'No sign-in',
  localService: 'Local service',
  configure: 'Configure',
  configuredTooltip: (name: string, enabled: boolean) =>
    `${name} · Configured · ${enabled ? 'Enabled' : 'Disabled'}`,
  connectorCount: (count: number) => `${count} ${count === 1 ? 'Connector' : 'Connectors'}`,
  addNamed: (name: string) => `Add ${name}`,
  addedNamed: (name: string) => `Added ${name}`,
  cancelAuthorizationNamed: (name: string) => `Cancel authorization for ${name}`,
  updateNamed: (name: string) => `Update ${name}`,
  buildNamedEnvironment: (name: string) => `Build ${name} environment`,
  enableNamed: (name: string) => `Enable ${name}`,
  verifyNamedKey: (name: string) => `Verify API key for ${name}`,
  updateNamedKey: (name: string) => `Update ${name} API key`,
  configureNamed: (name: string) => `Configure ${name}`,
  signInNamed: (name: string) => `Sign in to ${name}`,
  checkNamedConnection: (name: string, retry: boolean) =>
    `${retry ? 'Retry' : 'Check'} connection to ${name}`,
  unverifiedNamedAuthorization: (name: string) =>
    `Configured, authorization unverified for ${name}`,
  unavailableNamedAuthorization: (name: string) => `Authorization unavailable for ${name}`,
  variableName: (index: number) => `Variable ${index + 1} name`,
  variableValue: (index: number) => `Variable ${index + 1} value`,
  removeVariable: (index: number) => `Remove environment variable ${index + 1}`,
  argumentNumber: (index: number) => `Argument ${index + 1}`,
  sourceImported: (repo: string, sha: string) =>
    `Imported GitHub source ${repo}@${sha.slice(0, 7)}`,
  sourceAddedPackage: (id: string, version: string) => `Add ${id}@${version}`,
  sourceRemovedPackage: (id: string, version: string) => `Remove ${id}@${version}`,
  sourceUpdatedPackage: (id: string, from: string, to: string) => `Update ${id}: ${from} → ${to}`,
  sourceCurrent: (repo: string) => `${repo} is up to date`,
  entryPoint: (entry: string) => `Entry point ${entry}`,
  gitRef: (ref: string) => `Ref ${ref} · `,
  packageTransport: (publisher: string, transport: string) =>
    `${publisher} · ${transport === 'stdio' ? 'Local' : 'Remote'}`,
  invalidVariableName: (name: string) => `Invalid environment variable name: ${name || '(empty)'}`,
  reservedVariable: (name: string) => `Cannot set reserved variable ${name}`,
  duplicateVariable: (name: string) => `Duplicate environment variable ${name}`,
  variableLengthLimit: (name: string) =>
    `Environment variable ${name} must be at most 4096 characters`,
  variableControlInvalid: (name: string) =>
    `Environment variable ${name} must not contain newlines or NUL`,
  setupPromptTitle: (intent: string, title: string) =>
    `Help me ${intent} this local MCP Connector: ${title}.`,
  setupPromptSummary: (summary: string) => `Launch: ${summary}`,
  setupPromptKind: (kind: string) => `Runtime type: ${kind}`,
  setupPromptError: (error: string) => `Failure: ${error}`,
  setupPromptReason: (reason: string) => `Detected reason: ${reason}`,
  setupPromptOutput: (detail: string) => `Process output (tail):\n${detail}`,
  setupPromptReadme: (url: string) => `README: ${url}`,
  setupPromptCommands: (commands: readonly string[]) =>
    `Suggested commands (review only; do not run automatically):\n${commands.join('\n')}`,
  addStarted: (title: string) =>
    `Adding ${title}: starting and verifying in the background. The first run may take a few minutes.`,
  addReady: (title: string, count?: number) =>
    `Connector ${title} added${count === undefined ? '' : `, ${count} tools found`}`,
  addCancelled: (title: string) => `Cancelled adding ${title}`,
  addNeedsSetup: (title: string) => `${title} needs configuration. View the setup instructions.`,
  addFailure: (title: string, error: string, hasDetail: boolean) =>
    `Could not add ${title}: ${error}${hasDetail ? ' (see Background tasks for details)' : ''}`,
  apiKeyIntro: (name: string) =>
    `Enter your API key. Phi verifies it with ${name} before saving it encrypted on this device.`,
  obtainKey: (name: string) => `Get an API key from ${name} ↗`,
  backToGroup: (group: string) => `← Back to ${group}`,
  sortBy: (label: string) => `Sort: ${label}`,
  readToolsFailure: (error: string) => `Could not read the current tool list: ${error}`
} as const

export const connectorCopy = defineCopy(connectorCopyEn, connectorCopyZh)

/** Protocol values are retained for filtering; this function is for presentation only. */
export function connectorSignInLabel(value: string): string {
  switch (value) {
    case '需要登录':
      return connectorCopy.signInRequired
    case '无需登录':
      return connectorCopy.noSignIn
    case '需要 API key':
      return connectorCopy.apiKeyRequired
    case '本地服务':
      return connectorCopy.localService
    default:
      return value
  }
}

/** Keep both sign-in labels searchable without translating the raw authentication value. */
export function connectorSignInSearchTerms(value: string): string[] {
  switch (value) {
    case '需要登录':
      return [value, connectorCopyEn.signInRequired, connectorCopyZh.signInRequired]
    case '无需登录':
      return [value, connectorCopyEn.noSignIn, connectorCopyZh.noSignIn]
    case '需要 API key':
      return [value, connectorCopyEn.apiKeyRequired, connectorCopyZh.apiKeyRequired]
    case '本地服务':
      return [value, connectorCopyEn.localService, connectorCopyZh.localService]
    default:
      return [value]
  }
}
