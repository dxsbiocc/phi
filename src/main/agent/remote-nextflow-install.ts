// Transitional: replace this file after roadmap step 2 uploads Linux micromamba and builds phi-nextflow.
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import type { RemoteNextflowInstallResult } from '../../shared/remoteDoctorTypes'
import { getPhiAgentDir } from './runtime-paths'
import type { ConnectImpl } from './wrappers/executor-remote'
import { connectRemoteSshSession, shellQuote } from './wrappers/remote-ssh-session'

const INSTALL_TIMEOUT_MS = 5 * 60_000
const OFFICIAL_INSTALL_URL = 'https://get.nextflow.io'

export interface RemoteNextflowInstallDependencies {
  agentDir?: string
  connectImpl?: ConnectImpl
}

function javaMajor(output: string): number | null {
  const match = output.match(/(?:openjdk|java) version\s+"?(?:1\.)?(\d+)/i)
  return match ? Number(match[1]) : null
}

/** The reviewed, fixed-scope official self-install sequence. */
export function buildRemoteNextflowInstallScript(): string {
  return [
    'set -eu',
    'target="$HOME/.local/bin/nextflow"',
    'if [ -x "$target" ]; then',
    '  "$target" -version >/dev/null 2>&1',
    '  printf "__PHI_NEXTFLOW_EXISTING__:%s\\n" "$target"',
    '  exit 0',
    'fi',
    'if [ -e "$target" ]; then',
    '  echo "Nextflow target already exists but is not executable" >&2',
    '  exit 1',
    'fi',
    'if command -v nextflow >/dev/null 2>&1; then',
    '  existing="$(command -v nextflow)"',
    '  printf "__PHI_NEXTFLOW_EXISTING__:%s\\n" "$existing"',
    '  exit 0',
    'fi',
    'tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/phi-nextflow.XXXXXX")"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    'cd "$tmp_dir"',
    `curl --fail --silent --show-error --location ${shellQuote(OFFICIAL_INSTALL_URL)} --output installer.sh`,
    'bash installer.sh',
    'test -f nextflow',
    'mkdir -p "$HOME/.local/bin"',
    'cp -n nextflow "$target"',
    'chmod 755 "$target"',
    '"$target" -version >/dev/null 2>&1',
    'printf "__PHI_NEXTFLOW_INSTALLED__:%s\\n" "$target"'
  ].join('\n')
}

/** Install only Nextflow into the SSH account's own ~/.local/bin, never with sudo. */
export async function installRemoteNextflow(
  hostProfileId: string,
  dependencies: RemoteNextflowInstallDependencies = {}
): Promise<RemoteNextflowInstallResult> {
  const profile = getRemoteHostProfile(hostProfileId, dependencies.agentDir ?? getPhiAgentDir())
  if (!profile) throw new Error('SSH server profile not found. Select the server again.')
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  const session = await connect({
    ...remoteConnectionConfigForProfile(profile),
    execTimeoutMs: INSTALL_TIMEOUT_MS
  })
  try {
    const java = await session.exec(`bash -lc ${shellQuote('java -version')}`)
    const major = java.code === 0 ? javaMajor(`${java.stdout}\n${java.stderr}`) : null
    if (major === null || major < 17) {
      throw new Error(
        'Automatic Nextflow installation requires Java 17 or newer on the server. Install Java manually or load an environment module.'
      )
    }
    const curl = await session.exec(
      `bash -lc ${shellQuote('test -x "$HOME/.local/bin/nextflow" || command -v nextflow >/dev/null 2>&1 || command -v curl >/dev/null 2>&1')}`
    )
    if (curl.code !== 0) {
      throw new Error(
        'curl is missing on the server. Install Nextflow manually or contact the administrator.'
      )
    }

    const script = buildRemoteNextflowInstallScript()
    const result = await session.exec(`bash -lc ${shellQuote(script)}`)
    const line = result.stdout
      .split(/\r?\n/)
      .filter((entry) => /^__PHI_NEXTFLOW_(EXISTING|INSTALLED)__:\//.test(entry))
      .at(-1)
    if (result.code !== 0 || !line) {
      throw new Error(
        'Automatic Nextflow installation did not complete. Check the server network and home directory permissions, or install manually.'
      )
    }
    const [kind, path] = line.split(':', 2)
    if (!path || !path.startsWith('/') || /[\r\n\0]/.test(path)) {
      throw new Error('The server did not return a valid Nextflow path. Configure it manually.')
    }
    return { path, alreadyInstalled: kind === '__PHI_NEXTFLOW_EXISTING__' }
  } finally {
    await session.close().catch(() => undefined)
  }
}
