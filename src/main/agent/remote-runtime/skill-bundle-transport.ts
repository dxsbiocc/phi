import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import { shellQuote } from '../wrappers/remote-ssh-session'
import type { RemoteRuntimeWorkspace } from './types'
import type { RemoteSkillBundle, RemoteSkillBundleFile } from './skill-bundle'

const SCRIPT_TIMEOUT_MS = 10 * 60_000
const SCRIPT_OUTPUT_BYTES = 16 * 1024
const MARKER = '.phi-skill-bundle'

interface ValidationReply {
  status: 'reusable' | 'repair' | 'unsafe'
  reason?: string
}

export async function validateRemoteSkillBundle(
  workspace: RemoteRuntimeWorkspace,
  bundle: RemoteSkillBundle,
  files: readonly RemoteSkillBundleFile[],
  signal?: AbortSignal
): Promise<ValidationReply> {
  const result = await workspace.execWithInput(buildValidationScript(bundle, files), {
    signal,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxOutputBytes: SCRIPT_OUTPUT_BYTES
  })
  signal?.throwIfAborted()
  if (result.terminationReason === 'timeout') throw new Error('远程 Skill bundle 校验超时')
  if (result.code !== 0) {
    throw new Error(
      `远程 Skill bundle 校验失败：${result.stderr.trim() || `exit code ${result.code}`}`
    )
  }
  return validationReply(result.stdout)
}

export async function publishRemoteSkillBundle(
  workspace: RemoteRuntimeWorkspace,
  bundle: RemoteSkillBundle,
  files: readonly RemoteSkillBundleFile[],
  signal?: AbortSignal
): Promise<void> {
  const result = await workspace.execWithInput(buildPublishScript(bundle, files), {
    signal,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxOutputBytes: SCRIPT_OUTPUT_BYTES
  })
  signal?.throwIfAborted()
  if (result.terminationReason === 'timeout') throw new Error('远程 Skill bundle 上传超时')
  if (result.code === 42) throw new Error('远程 Skill bundle 目标包含不安全的符号链接')
  if (result.code !== 0) {
    throw new Error(
      `远程 Skill bundle 上传失败：${result.stderr.trim() || `exit code ${result.code}`}`
    )
  }
}

function buildValidationScript(
  bundle: RemoteSkillBundle,
  files: readonly RemoteSkillBundleFile[]
): string {
  const directories = nestedDirectories(files)
  const parent = posix.dirname(bundle.absoluteDir)
  const lines = [
    'set -u',
    `phi_parent=${shellQuote(parent)}`,
    `phi_target=${shellQuote(bundle.absoluteDir)}`,
    `phi_hash=${shellQuote(bundle.hash)}`,
    'phi_repair() { printf \'{"status":"repair","reason":"%s"}\\n\' "$1"; exit 0; }',
    'phi_unsafe() { printf \'{"status":"unsafe","reason":"%s"}\\n\' "$1"; exit 0; }',
    ...hashAndModeFunctions(),
    '[ -e "$phi_parent" ] || phi_repair missing-parent',
    '[ ! -L "$phi_parent" ] || phi_unsafe parent-symlink',
    '[ -d "$phi_parent" ] || phi_unsafe parent-type',
    '[ "$(phi_mode "$phi_parent")" = 700 ] || phi_repair parent-mode',
    '[ -e "$phi_target" ] || phi_repair missing-target',
    '[ ! -L "$phi_target" ] || phi_unsafe target-symlink',
    '[ -d "$phi_target" ] || phi_repair target-type',
    "phi_links=$(find \"$phi_target\" -type l -exec sh -c 'for phi_path do printf x; done' sh {} + | wc -c | tr -d ' ')",
    '[ "$phi_links" = 0 ] || phi_unsafe nested-symlink',
    `[ "$(phi_mode "$phi_target")" = 700 ] || phi_repair root-mode`,
    ...validationEntryLines(bundle, directories, files),
    `phi_expected=${directories.length + files.length + 1}`,
    "phi_actual=$(find \"$phi_target\" -mindepth 1 -exec sh -c 'for phi_path do printf x; done' sh {} + | wc -c | tr -d ' ')",
    '[ "$phi_actual" = "$phi_expected" ] || phi_repair file-set',
    'printf \'{"status":"reusable"}\\n\''
  ]
  return `${lines.join('\n')}\n`
}

function validationEntryLines(
  bundle: RemoteSkillBundle,
  directories: readonly string[],
  files: readonly RemoteSkillBundleFile[]
): string[] {
  const marker = posix.join(bundle.absoluteDir, MARKER)
  const lines = [
    `phi_marker=${shellQuote(marker)}`,
    '[ -f "$phi_marker" ] && [ ! -L "$phi_marker" ] || phi_repair marker-type',
    '[ "$(wc -c < "$phi_marker" | tr -d \' \')" = 65 ] || phi_repair marker-size',
    '[ "$(cat "$phi_marker")" = "$phi_hash" ] || phi_repair marker-content',
    '[ "$(phi_mode "$phi_marker")" = 600 ] || phi_repair marker-mode'
  ]
  for (const directory of directories) {
    const path = shellQuote(posix.join(bundle.absoluteDir, directory))
    lines.push(`[ -d ${path} ] && [ ! -L ${path} ] || phi_repair directory-type`)
    lines.push(`[ "$(phi_mode ${path})" = 700 ] || phi_repair directory-mode`)
  }
  for (const file of files) lines.push(...fileValidationLines(bundle, file))
  return lines
}

function fileValidationLines(bundle: RemoteSkillBundle, file: RemoteSkillBundleFile): string[] {
  const path = shellQuote(posix.join(bundle.absoluteDir, file.relativePath))
  const mode = file.executable ? '755' : '600'
  return [
    `[ -f ${path} ] && [ ! -L ${path} ] || phi_repair file-type`,
    `[ "$(wc -c < ${path} | tr -d ' ')" = ${file.content.length} ] || phi_repair file-size`,
    `[ "$(phi_sha ${path})" = ${file.contentHash} ] || phi_repair file-content`,
    `[ "$(phi_mode ${path})" = ${mode} ] || phi_repair file-mode`
  ]
}

function buildPublishScript(
  bundle: RemoteSkillBundle,
  files: readonly RemoteSkillBundleFile[]
): string {
  const directories = nestedDirectories(files)
  const parent = posix.dirname(bundle.absoluteDir)
  const stage = posix.join(parent, `.${bundle.hash}.phi-upload-${randomUUID()}`)
  const lines = [
    'set -eu',
    'umask 077',
    `phi_parent=${shellQuote(parent)}`,
    `phi_target=${shellQuote(bundle.absoluteDir)}`,
    `phi_stage=${shellQuote(stage)}`,
    ...hashAndModeFunctions(),
    ...decodeFunction(),
    'if [ ! -e "$phi_parent" ] && [ ! -L "$phi_parent" ]; then mkdir -m 700 "$phi_parent" 2>/dev/null || true; fi',
    '[ ! -L "$phi_parent" ] || exit 42',
    '[ -d "$phi_parent" ] || exit 43',
    'chmod 700 "$phi_parent"',
    '[ ! -e "$phi_stage" ] && [ ! -L "$phi_stage" ] || exit 43',
    'mkdir -m 700 "$phi_stage"',
    'phi_cleanup() { rm -rf -- "$phi_stage"; }',
    'phi_abort() { phi_cleanup; exit 130; }',
    'trap phi_cleanup EXIT',
    'trap phi_abort HUP INT TERM'
  ]
  appendDirectories(lines, stage, directories)
  files.forEach((file, index) => appendFile(lines, stage, file, index))
  lines.push(...publishTail(bundle, stage))
  return `${lines.join('\n')}\n`
}

function hashAndModeFunctions(): string[] {
  return [
    'phi_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }',
    'phi_sha() {',
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk \'{print $1}\';',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk \'{print $1}\';',
    '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed \'s/^.*= //\';',
    '  else return 44; fi',
    '}'
  ]
}

function decodeFunction(): string[] {
  return [
    'phi_decode() {',
    '  if command -v base64 >/dev/null 2>&1; then',
    '    if printf Zg== | base64 -d >/dev/null 2>&1; then base64 -d > "$1"; else base64 -D > "$1"; fi',
    '  elif command -v openssl >/dev/null 2>&1; then openssl base64 -d > "$1";',
    '  else return 44; fi',
    '}'
  ]
}

function appendDirectories(lines: string[], stage: string, directories: readonly string[]): void {
  for (const directory of directories) {
    const path = shellQuote(posix.join(stage, directory))
    lines.push(`mkdir -m 700 ${path}`)
  }
}

function appendFile(
  lines: string[],
  stage: string,
  file: RemoteSkillBundleFile,
  index: number
): void {
  const path = shellQuote(posix.join(stage, file.relativePath))
  const delimiter = `PHI_SKILL_FILE_${index}`
  const encoded = wrappedBase64(file.content)
  lines.push(`phi_decode ${path} <<'${delimiter}'`, encoded, delimiter)
  lines.push(`chmod ${file.executable ? '755' : '600'} ${path}`)
  lines.push(`[ "$(phi_sha ${path})" = ${file.contentHash} ] || exit 45`)
}

function publishTail(bundle: RemoteSkillBundle, stage: string): string[] {
  const marker = shellQuote(posix.join(stage, MARKER))
  return [
    `printf '%s\\n' ${shellQuote(bundle.hash)} > ${marker}`,
    `chmod 600 ${marker}`,
    '[ ! -L "$phi_target" ] || exit 42',
    'if [ -d "$phi_target" ]; then',
    "  phi_links=$(find \"$phi_target\" -type l -exec sh -c 'for phi_path do printf x; done' sh {} + | wc -c | tr -d ' ')",
    '  [ "$phi_links" = 0 ] || exit 42',
    'fi',
    'rm -rf -- "$phi_target"',
    'mv "$phi_stage" "$phi_target"',
    'trap - EXIT HUP INT TERM',
    'printf \'{"status":"published"}\\n\''
  ]
}

function nestedDirectories(files: readonly RemoteSkillBundleFile[]): string[] {
  const directories = new Set<string>()
  for (const file of files) {
    let current = posix.dirname(file.relativePath)
    while (current !== '.') {
      directories.add(current)
      current = posix.dirname(current)
    }
  }
  return [...directories].sort((left, right) => left.split('/').length - right.split('/').length)
}

function wrappedBase64(content: Buffer): string {
  return content
    .toString('base64')
    .replace(/.{1,76}/gu, '$&\n')
    .replace(/\n$/u, '')
}

function validationReply(stdout: string): ValidationReply {
  const value = JSON.parse(stdout.trim()) as Partial<ValidationReply>
  if (!['reusable', 'repair', 'unsafe'].includes(value.status ?? '')) {
    throw new Error('远程 Skill bundle 校验返回无效状态')
  }
  return value as ValidationReply
}
