import { posix } from 'node:path'

import type { WrapperInputResolution } from './types'
import { isWithinRemoteRoot } from './path-mapping'
import { shellQuote, type RemoteSshSession } from './remote-ssh-session'

const GLOB_CHARACTER = /[*?{[]/
const REMOTE_URL = /^(https?|s3|gs):\/\//i

export interface RemoteInputCheckResult {
  errors: string[]
  warnings: string[]
}

type ProbeResult =
  | { kind: 'found'; canonicalPath: string }
  | { kind: 'missing' | 'permission' | 'other' | 'unavailable' }

/** Like T02's remote path resolution, this asks the server to stat and realpath the path. */
export function buildRemoteInputProbeCommand(path: string, directoryOnly = false): string {
  const perl = [
    'use strict; use warnings;',
    'use Cwd qw(realpath);',
    'my $path = $ARGV[0];',
    'my @stat = stat($path);',
    'if (!@stat) { exit($!{EACCES} ? 42 : ($!{ENOENT} || $!{ENOTDIR} ? 41 : 43)); }',
    directoryOnly
      ? '-d $path or exit 44; -r $path && -x $path or exit 42;'
      : '(-f $path || -d $path) or exit 44; -r $path or exit 42; -d $path && !-x $path and exit 42;',
    'my $real = realpath($path);',
    'defined($real) or exit($!{EACCES} ? 42 : 43);',
    'print $real, "\\0";'
  ].join('\n')
  return `bash -c ${shellQuote(`command -v perl >/dev/null 2>&1 || exit 45; perl -e ${shellQuote(perl)} -- ${shellQuote(path)}`)}`
}

async function probe(
  session: RemoteSshSession,
  path: string,
  directoryOnly: boolean
): Promise<ProbeResult> {
  const result = await session.exec(buildRemoteInputProbeCommand(path, directoryOnly))
  if (result.code === 41) return { kind: 'missing' }
  if (result.code === 42) return { kind: 'permission' }
  if (result.code === 44) return { kind: 'other' }
  if (result.code !== 0) return { kind: 'unavailable' }
  const nul = result.stdout.indexOf('\0')
  if (nul < 1 || nul !== result.stdout.length - 1) return { kind: 'unavailable' }
  const canonicalPath = result.stdout.slice(0, nul)
  if (!posix.isAbsolute(canonicalPath) || canonicalPath.includes('\0')) {
    return { kind: 'unavailable' }
  }
  return { kind: 'found', canonicalPath }
}

function fixedGlobPrefix(path: string): string {
  const first = path.search(GLOB_CHARACTER)
  if (first < 0) return path
  const slash = path.lastIndexOf('/', first)
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function failure(
  inputId: string,
  path: string,
  kind: Exclude<ProbeResult['kind'], 'found'>
): string {
  const labels = {
    missing: '服务器路径不存在',
    permission: '服务器路径无读取或进入权限',
    other: '服务器目标不是普通文件或目录',
    unavailable: '服务器无法安全核验路径（可能缺少 Perl 或连接已中断）'
  }
  return `输入 "${inputId}" ${labels[kind]}: ${path}`
}

/** Never consults this machine's filesystem; no warning can be mistaken for a verified glob match. */
export async function checkRemoteWrapperInputs(
  session: RemoteSshSession,
  inputs: readonly WrapperInputResolution[],
  options: { relativeBase?: string } = {}
): Promise<RemoteInputCheckResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const roots = new Map<string, ProbeResult>()
  for (const input of inputs) {
    if (!input.remotePaths?.length) {
      errors.push(`输入 "${input.id}" 缺少最终服务器路径: ${input.userValue}`)
      continue
    }
    for (const rawPath of input.remotePaths ?? []) {
      if (REMOTE_URL.test(rawPath)) {
        warnings.push(`输入 "${input.id}" 是远端 URL，未检查其可用性: ${rawPath}`)
        continue
      }
      if (rawPath.includes('${')) {
        errors.push(`输入 "${input.id}" 含有无法在提交前核验的动态服务器路径: ${rawPath}`)
        continue
      }
      const path = posix.isAbsolute(rawPath)
        ? rawPath
        : options.relativeBase
          ? posix.resolve(options.relativeBase, rawPath)
          : ''
      if (!path || Buffer.byteLength(path, 'utf8') > 4096 || path.includes('\0')) {
        errors.push(`输入 "${input.id}" 的服务器路径无效: ${rawPath}`)
        continue
      }
      const glob = GLOB_CHARACTER.test(path)
      const target = glob ? fixedGlobPrefix(path) : path
      const observation = await probe(session, target, glob)
      if (observation.kind !== 'found') {
        errors.push(failure(input.id, target, observation.kind))
        continue
      }
      const root = input.allowedRemoteRoot
      if (root) {
        let rootObservation = roots.get(root)
        if (!rootObservation) {
          rootObservation = await probe(session, root, true)
          roots.set(root, rootObservation)
        }
        if (rootObservation.kind !== 'found') {
          errors.push(failure(input.id, root, rootObservation.kind))
          continue
        }
        if (!isWithinRemoteRoot(rootObservation.canonicalPath, observation.canonicalPath)) {
          errors.push(`输入 "${input.id}" 的符号链接目标超出服务器授权目录: ${rawPath}`)
          continue
        }
      }
      if (glob) {
        warnings.push(`输入 "${input.id}" 的 glob 仅核验固定目录前缀，尚未确认匹配文件: ${rawPath}`)
      }
    }
  }
  return { errors, warnings }
}
