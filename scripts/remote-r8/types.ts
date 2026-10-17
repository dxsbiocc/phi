import { isAbsolute } from 'node:path'

/** Per-case budget, copied unchanged from the frozen operators. */
export const CASE_MS = 120_000
/** Overall watchdog for one acceptance run. */
export const TOTAL_MS = 15 * 60_000
/** The one private read-only agent the child case delegates to. */
export const INSPECTOR_AGENT = 'R8Inspector'
export const SCRATCH_DIRECTORY = '.phi-acceptance'
/** Name of the per-run directory below the runtime root; the run id is the only child. */
export const REMOTE_WORK_PARENT = 'r8-acceptance'
export const CASE_NAMES = [
  'native-search-read-edit-bash',
  'one-actual-blocking-child',
  'ssh-loss-reconnect-explicit-original-journal'
] as const
export const RUN_ID_PATTERN = /^r8-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** Everything the isolated child process needs; written as a private JSON file. */
export interface R8Input {
  readonly runId: string
  readonly repoRoot: string
  readonly localRoot: string
  readonly host: string
  readonly profile: {
    readonly hostAlias: string
    readonly user?: string
    readonly port?: number
    readonly identityFile?: string
  }
  /** Configured runtime root as the application sees it: absolute path or `~/...`. */
  readonly runtimeRoot: string
  /** True when the operator named the root; a named root must be exactly mode 0700. */
  readonly runtimeRootExplicit: boolean
  readonly bundleHash: string
  readonly commit: string
  readonly realBun: string
}

export function assertInput(input: R8Input): void {
  const invalid =
    !RUN_ID_PATTERN.test(input.runId) ||
    ![input.repoRoot, input.localRoot, input.realBun].every(isAbsolute) ||
    !input.localRoot.startsWith(`${input.repoRoot}/${SCRATCH_DIRECTORY}/runs/${input.runId}`) ||
    input.profile.hostAlias !== input.host ||
    !/^[a-f0-9]{64}$/.test(input.bundleHash) ||
    !/^[a-f0-9]{40}$/.test(input.commit)
  if (invalid) throw new Error('Invalid isolated R8 input')
}

export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`R8 deadline: ${label}`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
