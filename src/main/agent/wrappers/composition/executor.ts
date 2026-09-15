import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** Execution profile a wrapper can run under — see each `wrapper/nextflow.config`'s `profiles {}` block. */
export const WRAPPER_EXECUTION_PROFILES = ['docker', 'singularity', 'conda'] as const
export type WrapperExecutionProfile = (typeof WRAPPER_EXECUTION_PROFILES)[number]

/**
 * Runs the fixed smoke command from
 * docs/design/phi-wrapper-agent-composition-design.md section 5/7:
 * `nextflow run wrapper/main.nf -params-file wrapper/params.json`, with
 * agent-supplied overrides merged into the wrapper's own default params.
 */

function findExecutable(dir: string, name: string): string | undefined {
  const candidate = join(dir, name)
  return existsSync(candidate) ? candidate : undefined
}

function condaEnvBinCandidates(name: string): string[] {
  const envRoots = ['miniconda3', 'anaconda3', 'miniforge3'].map((d) => join(homedir(), d, 'envs'))
  const found: string[] = []
  for (const root of envRoots) {
    if (!existsSync(root)) continue
    let envNames: string[]
    try {
      envNames = readdirSync(root)
    } catch {
      continue
    }
    for (const envName of envNames) {
      const bin = findExecutable(join(root, envName, 'bin'), name)
      if (bin) found.push(bin)
    }
  }
  return found
}

/**
 * Electron apps don't reliably inherit a dev shell's PATH (conda-activated
 * envs in particular), so beyond `process.env.PATH` this also checks common
 * conda env locations. Set `NEXTFLOW_BIN` to skip the search entirely.
 */
export function findNextflowBinary(): string {
  if (process.env.NEXTFLOW_BIN && existsSync(process.env.NEXTFLOW_BIN)) {
    return process.env.NEXTFLOW_BIN
  }
  try {
    const found = execFileSync('which', ['nextflow'], { encoding: 'utf-8' }).trim()
    if (found) return found
  } catch {
    // fall through to conda env search
  }
  const candidates = condaEnvBinCandidates('nextflow')
  if (candidates.length > 0) return candidates[0]
  throw new Error(
    'Could not locate a nextflow binary. Set the NEXTFLOW_BIN environment variable to its absolute path.'
  )
}

/**
 * If `binPath` lives inside a conda env (`.../<condaRoot>/envs/<name>/bin/<exe>`),
 * returns `<condaRoot>` — so callers can also put `<condaRoot>/condabin` and
 * `<condaRoot>/bin` on PATH. The `conda` executable itself lives there, not
 * inside the env's own `bin/`, which is where `-profile conda` needs it:
 * Nextflow shells out to `conda`/`mamba` to build/reuse each process's
 * `conda "${moduleDir}/environment.yml"` environment.
 */
function condaRootFromEnvBin(binPath: string): string | undefined {
  const parts = binPath.split(sep)
  const binIndex = parts.lastIndexOf('bin')
  if (binIndex >= 2 && parts[binIndex - 2] === 'envs') {
    return parts.slice(0, binIndex - 2).join(sep)
  }
  return undefined
}

export interface WrapperRunResult {
  success: boolean
  exitCode: number
  /** Combined, tail-truncated stdout+stderr — enough to explain success/failure, not the full log. */
  output: string
}

/**
 * `wrapperDir` is the `wrapper/` adapter directory (containing
 * wrapper.yaml/main.nf/params.json); Nextflow itself is launched with cwd
 * set to its parent (the module/subworkflow root), matching the fixed
 * command's own relative path (`wrapper/main.nf`).
 */
export async function runWrapperComposition(
  wrapperDir: string,
  overrides: Record<string, unknown>,
  profile: WrapperExecutionProfile = 'docker'
): Promise<WrapperRunResult> {
  if (!WRAPPER_EXECUTION_PROFILES.includes(profile)) {
    throw new Error(
      `Unknown execution profile: ${profile}. Must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}.`
    )
  }

  const nextflowBin = findNextflowBinary()
  const defaultParams = JSON.parse(
    readFileSync(join(wrapperDir, 'params.json'), 'utf-8')
  ) as Record<string, unknown>
  const mergedParams = { ...defaultParams, ...overrides }

  const tmpDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-run-'))
  const paramsFilePath = join(tmpDir, 'params.json')
  writeFileSync(paramsFilePath, JSON.stringify(mergedParams, null, 2))

  const componentDir = dirname(wrapperDir)
  const condaRoot = condaRootFromEnvBin(nextflowBin)
  const pathDirs = [
    dirname(nextflowBin),
    ...(condaRoot ? [join(condaRoot, 'condabin'), join(condaRoot, 'bin')] : [])
  ]
  const env = { ...process.env, PATH: `${pathDirs.join(':')}:${process.env.PATH ?? ''}` }

  const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
    (resolve) => {
      const child = spawn(
        nextflowBin,
        ['run', 'wrapper/main.nf', '-params-file', paramsFilePath, '-profile', profile],
        { cwd: componentDir, env }
      )
      let combined = ''
      child.stdout.on('data', (chunk: Buffer) => {
        combined += chunk.toString('utf-8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        combined += chunk.toString('utf-8')
      })
      child.on('close', (code) => resolve({ exitCode: code ?? -1, output: combined }))
      child.on('error', (error) => resolve({ exitCode: -1, output: String(error) }))
    }
  )

  return {
    success: exitCode === 0,
    exitCode,
    output: output.length > 4000 ? output.slice(-4000) : output
  }
}
