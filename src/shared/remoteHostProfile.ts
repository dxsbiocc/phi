export const SSH_CONFIG_HOST_ID_PREFIX = 'ssh-config:'

/** Stable Phi identity for an OpenSSH Host alias; does not persist a second host record. */
export function sshConfigHostId(alias: string): string {
  return `${SSH_CONFIG_HOST_ID_PREFIX}${alias}`
}

export interface OpenSshHostInput {
  /** Present only when editing an existing Host entry; aliases are stable project identities. */
  originalAlias?: string
  alias: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}
