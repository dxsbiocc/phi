import type { OpenSshHost, RemoteHostProfile } from '../../../types'
import { sshConfigHostId } from '../../../../../shared/remoteHostProfile'
import { remoteHostDoctorTarget, type RemoteDoctorTarget } from './remoteDoctorUi'

export interface RemoteHostRow {
  alias: string
  saved: RemoteHostProfile
  discovered?: OpenSshHost
}

export function remoteHostRows(
  hosts: RemoteHostProfile[],
  openSshHosts: OpenSshHost[]
): RemoteHostRow[] {
  const savedByAlias = new Map(hosts.map((host) => [host.hostAlias, host]))
  const discoveredAliases = new Set(openSshHosts.map((host) => host.alias))
  return [
    ...openSshHosts.map((host) => ({
      alias: host.alias,
      saved: savedByAlias.get(host.alias) ?? {
        id: sshConfigHostId(host.alias),
        label: host.alias,
        hostAlias: host.alias,
        source: 'ssh-config' as const
      },
      discovered: host
    })),
    ...hosts
      .filter((host) => !discoveredAliases.has(host.hostAlias))
      .map((host) => ({ alias: host.hostAlias, saved: host }))
  ]
}

/** Automatic probes stay non-interactive so opening the list does not prompt for a password. */
export function remoteHostProbeTargets(
  hosts: RemoteHostProfile[],
  openSshHosts: OpenSshHost[]
): RemoteDoctorTarget[] {
  return remoteHostRows(hosts, openSshHosts).map((row) => {
    const target = remoteHostDoctorTarget(row.saved.id, row.saved.hostAlias)
    return { ...target, options: { ...target.options, userInitiated: false } }
  })
}
