/** Public English messages for SSH setup. Never include credential-bearing command output. */
export const sshBootstrapCopy = {
  operationExpired: 'The SSH setup operation does not exist or has ended',
  credentialsInvalid: 'Invalid SSH credential format',
  askpassAttemptsInvalid: 'Invalid SSH askpass attempt count',
  configWriteFailed: 'Could not update the SSH configuration during setup',
  operationFailed: 'SSH setup failed',
  knownHostsNotFile: 'known_hosts is not a regular file',
  commandTimeoutInvalid: 'Invalid command timeout',
  outputLimitInvalid: 'Invalid command output limit',
  commandStartFailed: 'Could not start the command',
  commandTimedOut: 'Command timed out',
  hostnameInvalid: 'The server address must be a single hostname or IP address',
  userAndPortRequired: 'An SSH username and port are required'
} as const
