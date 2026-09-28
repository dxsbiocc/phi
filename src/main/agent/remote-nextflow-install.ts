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
  if (!profile) throw new Error('SSH 服务器档案不存在，请重新选择服务器')
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
        '自动安装 Nextflow 需要服务器先提供 Java 17 或更新版本；请手动安装或加载环境模块'
      )
    }
    const curl = await session.exec(
      `bash -lc ${shellQuote('test -x "$HOME/.local/bin/nextflow" || command -v nextflow >/dev/null 2>&1 || command -v curl >/dev/null 2>&1')}`
    )
    if (curl.code !== 0) {
      throw new Error('服务器缺少 curl；请手动安装 Nextflow 或联系管理员')
    }

    const script = buildRemoteNextflowInstallScript()
    const result = await session.exec(`bash -lc ${shellQuote(script)}`)
    const line = result.stdout
      .split(/\r?\n/)
      .filter((entry) => /^__PHI_NEXTFLOW_(EXISTING|INSTALLED)__:\//.test(entry))
      .at(-1)
    if (result.code !== 0 || !line) {
      throw new Error('Nextflow 自动安装未完成；请检查服务器网络、个人目录权限，或改为手动安装')
    }
    const [kind, path] = line.split(':', 2)
    if (!path || !path.startsWith('/') || /[\r\n\0]/.test(path)) {
      throw new Error('服务器未返回有效的 Nextflow 路径，请改为手动配置')
    }
    return { path, alreadyInstalled: kind === '__PHI_NEXTFLOW_EXISTING__' }
  } finally {
    await session.close().catch(() => undefined)
  }
}
