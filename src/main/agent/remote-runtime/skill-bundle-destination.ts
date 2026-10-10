import { posix } from 'node:path'

import type { WorkspaceHost } from '../workspace-host/types'

interface BundleDestination {
  absoluteDir: string
}

export async function assertSafeBundleDestination(
  host: WorkspaceHost,
  bundle: BundleDestination,
  signal?: AbortSignal
): Promise<void> {
  const script = [
    'set -eu',
    'phi_parent=$1',
    'phi_target=$2',
    'if [ ! -e "$phi_parent" ] && [ ! -L "$phi_parent" ]; then',
    '  mkdir -m 700 "$phi_parent" 2>/dev/null || true',
    'fi',
    '[ ! -L "$phi_parent" ] || exit 42',
    '[ -d "$phi_parent" ] || exit 43',
    'chmod 700 "$phi_parent" || exit 43',
    '[ ! -L "$phi_target" ] || exit 42',
    'if [ -d "$phi_target" ]; then',
    '  phi_link=$(find "$phi_target" -type l -print -quit)',
    '  [ -z "$phi_link" ] || exit 42',
    'fi'
  ].join('\n')
  const result = await host.exec.run(
    [
      'sh',
      '-c',
      script,
      'phi-skill-destination',
      posix.dirname(bundle.absoluteDir),
      bundle.absoluteDir
    ],
    { cwd: '.', signal, timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }
  )
  if (result.code === 42) throw new Error('远程 Skill bundle 目标包含不安全的符号链接')
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim()
    throw new Error(`远程 Skill bundle 目录无法安全准备：${detail || `exit code ${result.code}`}`)
  }
}

export async function removeRemoteSkillBundle(
  host: WorkspaceHost,
  bundle: BundleDestination,
  signal?: AbortSignal
): Promise<void> {
  const result = await host.exec.run(['rm', '-rf', '--', bundle.absoluteDir], {
    cwd: '.',
    signal,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0) throw new Error(`无法清理远程 Skill bundle：${result.stderr.trim()}`)
}
