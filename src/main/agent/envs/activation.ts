import { micromambaEnvironment, runMicromamba } from './runtime'

/** Same minimal PATH assigned by `micromambaEnvironment`. */
const MINIMAL_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

const EXCLUDED_NAMES = new Set([
  'PATH',
  'SHLVL',
  'PWD',
  'OLDPWD',
  '_',
  'CONDA_SHLVL',
  'CONDA_PROMPT_MODIFIER',
  'CONDA_EXE',
  'PS1'
])

export interface ActivationSnapshot {
  set: Record<string, string>
  pathPrepend: string[]
}

function excludedName(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.startsWith('MAMBA_')
}

/** PATH entries that appear before `/usr/bin:/bin:/usr/sbin:/sbin`, in order. */
function pathEntriesBeforeMinimal(pathValue: string): string[] {
  const entries = pathValue.split(':')
  const width = MINIMAL_SYSTEM_PATH.length
  for (let index = 0; index <= entries.length - width; index += 1) {
    const matches = MINIMAL_SYSTEM_PATH.every((entry, offset) => entries[index + offset] === entry)
    if (matches) return entries.slice(0, index).filter((entry) => entry.length > 0)
  }
  return []
}

/**
 * Diff an activated environment against the sanitised base `runMicromamba` passes.
 * `set` contains variables that are new or changed. `PATH` and shell/conda noise are dropped.
 * `CONDA_PREFIX` and `activate.d` variables such as `JAVA_HOME` are kept.
 */
export function diffActivation(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): ActivationSnapshot {
  const set: Record<string, string> = {}
  for (const [name, value] of Object.entries(after)) {
    if (excludedName(name) || before[name] === value) continue
    set[name] = value
  }
  return {
    set,
    pathPrepend: pathEntriesBeforeMinimal(after.PATH ?? '')
  }
}

function parseNulEnvironment(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return env
}

export async function captureActivation(
  root: string,
  prefix: string,
  signal?: AbortSignal
): Promise<ActivationSnapshot> {
  const before = micromambaEnvironment(root)
  const result = await runMicromamba(['run', '-p', prefix, '/usr/bin/env', '-0'], {
    root,
    signal
  })
  if (signal?.aborted || result.code === null) throw new Error('environment build aborted')
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      detail
        ? `failed to capture activation (${result.code}): ${detail.split('\n')[0]}`
        : `failed to capture activation (${result.code})`
    )
  }
  const snapshot = diffActivation(before, parseNulEnvironment(result.stdout))
  if (!snapshot.set.CONDA_PREFIX) {
    throw new Error('activation snapshot is missing CONDA_PREFIX')
  }
  return snapshot
}
