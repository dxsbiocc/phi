import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import { shellQuote } from '../wrappers/remote-ssh-session'
import type { RemoteRuntimeWorkspace } from './types'

const PROBE_TIMEOUT_MS = 10_000
const MUTATION_TIMEOUT_MS = 30_000
const MAX_METADATA_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024

export interface RemoteEnvironmentState {
  alias: string
  marker: string
}

interface ProbeReply {
  status: 'ready' | 'missing'
  alias?: string
  marker?: string
}

export async function probeEnvironmentAlias(
  workspace: RemoteRuntimeWorkspace,
  relativeAlias: string,
  signal?: AbortSignal
): Promise<RemoteEnvironmentState | undefined> {
  const result = await workspace.execWithInput(aliasProbeScript(workspace, relativeAlias), {
    signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  })
  signal?.throwIfAborted()
  const reply = probeReply(result.stdout, result.code)
  if (reply.status === 'missing' || !reply.alias || !reply.marker) return undefined
  return { alias: decode(reply.alias), marker: decode(reply.marker) }
}

export async function probeEnvironmentMarker(
  workspace: RemoteRuntimeWorkspace,
  envId: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const result = await workspace.execWithInput(markerProbeScript(workspace, envId), {
    signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  })
  signal?.throwIfAborted()
  const reply = probeReply(result.stdout, result.code)
  return reply.status === 'ready' && reply.marker ? decode(reply.marker) : undefined
}

export async function publishEnvironmentMarker(
  workspace: RemoteRuntimeWorkspace,
  envId: string,
  content: string,
  signal: AbortSignal
): Promise<void> {
  const target = posix.join(workspace.runtimeRoot, 'envs', envId, '.phi-remote-env.json')
  await runMutation(workspace, atomicWriteScript(target, content), signal, '完成标记')
}

export async function ensureEnvironmentAliases(
  workspace: RemoteRuntimeWorkspace,
  aliases: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<void> {
  const entries = Object.entries(aliases).map(([relative, content]) => ({
    path: posix.join(workspace.runtimeRoot, relative),
    content
  }))
  await runMutation(workspace, aliasScript(workspace.runtimeRoot, entries), signal, '环境别名')
}

async function runMutation(
  workspace: RemoteRuntimeWorkspace,
  script: string,
  signal: AbortSignal,
  label: string
): Promise<void> {
  const result = await workspace.execWithInput(script, {
    signal,
    timeoutMs: MUTATION_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024
  })
  signal.throwIfAborted()
  if (result.code === 42) throw new Error(`远程${label}路径包含不安全的符号链接`)
  if (result.code !== 0) {
    throw new Error(`远程${label}写入失败：${result.stderr.trim() || `exit code ${result.code}`}`)
  }
}

function aliasProbeScript(workspace: RemoteRuntimeWorkspace, relativeAlias: string): string {
  const alias = posix.join(workspace.runtimeRoot, relativeAlias)
  const lines = [
    'set -u',
    `phi_root=${shellQuote(workspace.runtimeRoot)}`,
    `phi_alias=${shellQuote(alias)}`,
    ...probeFunctions(),
    'phi_regular "$phi_alias" || phi_missing',
    'phi_small "$phi_alias" || phi_missing',
    'phi_env_id=$(sed -n \'s/.*"envId":"\\([a-f0-9]\\{64\\}\\)".*/\\1/p\' "$phi_alias")',
    'case "$phi_env_id" in [a-f0-9][a-f0-9]*) [ "${#phi_env_id}" = 64 ] || phi_missing ;; *) phi_missing ;; esac',
    'phi_marker="$phi_root/envs/$phi_env_id/.phi-remote-env.json"',
    'phi_history="$phi_root/envs/$phi_env_id/conda-meta/history"',
    'phi_regular "$phi_marker" && phi_small "$phi_marker" || phi_missing',
    'phi_regular "$phi_history" || phi_missing',
    'phi_alias_b64=$(phi_b64 < "$phi_alias") || exit 44',
    'phi_marker_b64=$(phi_b64 < "$phi_marker") || exit 44',
    'printf \'{"status":"ready","alias":"%s","marker":"%s"}\\n\' "$phi_alias_b64" "$phi_marker_b64"'
  ]
  return `${lines.join('\n')}\n`
}

function markerProbeScript(workspace: RemoteRuntimeWorkspace, envId: string): string {
  const marker = posix.join(workspace.runtimeRoot, 'envs', envId, '.phi-remote-env.json')
  const history = posix.join(workspace.runtimeRoot, 'envs', envId, 'conda-meta', 'history')
  const lines = [
    'set -u',
    `phi_marker=${shellQuote(marker)}`,
    `phi_history=${shellQuote(history)}`,
    ...probeFunctions(),
    'phi_regular "$phi_marker" && phi_small "$phi_marker" || phi_missing',
    'phi_regular "$phi_history" || phi_missing',
    'phi_marker_b64=$(phi_b64 < "$phi_marker") || exit 44',
    'printf \'{"status":"ready","marker":"%s"}\\n\' "$phi_marker_b64"'
  ]
  return `${lines.join('\n')}\n`
}

function probeFunctions(): string[] {
  return [
    'phi_missing() { printf \'{"status":"missing"}\\n\'; exit 0; }',
    'phi_regular() { [ -f "$1" ] && [ ! -L "$1" ]; }',
    `phi_small() { [ "$(wc -c < "$1" | tr -d ' ')" -le ${MAX_METADATA_BYTES} ]; }`,
    'phi_b64() {',
    "  if command -v base64 >/dev/null 2>&1; then base64 | tr -d '\\n';",
    '  elif command -v openssl >/dev/null 2>&1; then openssl base64 -A;',
    '  else return 44; fi',
    '}'
  ]
}

function aliasScript(
  runtimeRoot: string,
  entries: readonly { path: string; content: string }[]
): string {
  const lines = ['set -eu', 'umask 077', ...hashFunction()]
  entries.forEach((entry, index) => {
    const expected = contentHash(entry.content)
    const path = shellQuote(entry.path)
    lines.push(`phi_path=${path}`)
    lines.push(`phi_expected=${expected}`)
    lines.push('if [ -L "$phi_path" ]; then exit 42; fi')
    lines.push(
      'if [ -f "$phi_path" ] && [ "$(phi_sha "$phi_path")" = "$phi_expected" ]; then :; else'
    )
    lines.push(...indentedAtomicWrite(runtimeRoot, entry.path, entry.content, index), 'fi')
  })
  return `${lines.join('\n')}\n`
}

function atomicWriteScript(target: string, content: string): string {
  const lines = [
    'set -eu',
    'umask 077',
    ...safeExistingDirectoryLines(posix.dirname(target)),
    ...atomicWriteLines(target, content, randomUUID())
  ]
  return `${lines.join('\n')}\n`
}

function indentedAtomicWrite(
  runtimeRoot: string,
  target: string,
  content: string,
  index: number
): string[] {
  return [
    ...safeDirectoryLines(runtimeRoot, posix.dirname(target)),
    ...atomicWriteLines(target, content, `${index}-${randomUUID()}`)
  ].map((line) => `  ${line}`)
}

function atomicWriteLines(target: string, content: string, suffix: string): string[] {
  const temporary = `${target}.phi-${suffix}`
  return [
    `[ ! -L ${shellQuote(target)} ] || exit 42`,
    `printf %s ${shellQuote(content)} > ${shellQuote(temporary)}`,
    `chmod 600 ${shellQuote(temporary)}`,
    `mv -f ${shellQuote(temporary)} ${shellQuote(target)}`
  ]
}

function safeDirectoryLines(root: string, directory: string): string[] {
  const lines = safeExistingDirectoryLines(root)
  let current = root
  for (const part of posix.relative(root, directory).split('/').filter(Boolean)) {
    current = posix.join(current, part)
    const path = shellQuote(current)
    lines.push(`if [ ! -e ${path} ] && [ ! -L ${path} ]; then mkdir -m 700 ${path}; fi`)
    lines.push(`[ ! -L ${path} ] && [ -d ${path} ] || exit 42`)
  }
  return lines
}

function safeExistingDirectoryLines(directory: string): string[] {
  const path = shellQuote(directory)
  return [`[ ! -L ${path} ] || exit 42`, `[ -d ${path} ] || exit 43`]
}

function hashFunction(): string[] {
  return [
    'phi_sha() {',
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk \'{print $1}\';',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk \'{print $1}\';',
    '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed \'s/^.*= //\';',
    '  else return 44; fi',
    '}'
  ]
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function probeReply(stdout: string, code: number | null): ProbeReply {
  if (code !== 0) throw new Error(`远程环境校验失败：exit code ${code}`)
  const value = JSON.parse(stdout.trim()) as Partial<ProbeReply>
  if (value.status !== 'ready' && value.status !== 'missing') {
    throw new Error('远程环境校验返回无效状态')
  }
  return value as ProbeReply
}

function decode(value: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'))
}
