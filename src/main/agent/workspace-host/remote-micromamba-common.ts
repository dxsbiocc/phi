import type { RemoteMicromambaPlatform } from '../../../shared/remoteMicromambaTypes'
import type { RemoteExecResult, RemoteSshSession } from '../wrappers/remote-ssh-session'

export function expectedRemoteMicromambaInfoPlatform(platform: RemoteMicromambaPlatform): string {
  return platform === 'linux-x64' ? 'linux-64' : 'linux-aarch64'
}

export function remoteMicromambaBinaryVersion(releaseVersion: string): string {
  return releaseVersion.replace(/-\d+$/, '')
}

export async function runRemoteMicromambaScript(
  session: RemoteSshSession,
  script: string
): Promise<RemoteExecResult> {
  if (!session.execWithInput) throw new Error('Secure script channel is unavailable')
  return session.execWithInput('sh -s', script)
}
