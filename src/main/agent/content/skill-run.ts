import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runInEnvironment, type PhiPlatform, type RunResult } from '../envs'
import { applyOverrides } from '../envs/project-environments'
import type { ValidatedSkill } from './skill'
import { describeEnvironment, readyEnvironment, resolveSkillEnvironment } from './environment-refs'

const INTERPRETERS: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.R': 'Rscript',
  '.r': 'Rscript',
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.pl': 'perl'
}

export interface SkillRunResult {
  envId: string
  resolvedCommand: string
  exitCode: number | null
  terminated?: 'timeout' | 'aborted'
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  durationMs: number
  warnings: string[]
}

export interface RunSkillScriptInput {
  root: string
  projectDir: string
  skill: ValidatedSkill
  script: string
  args?: string[]
  cwd?: string
  sessionEnvironment?: string
  pluginId?: string
  agentDir?: string
  environmentsDir?: string
  platform?: PhiPlatform
  signal?: AbortSignal
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  timeoutMs?: number
}

export async function runSkillScript(input: RunSkillScriptInput): Promise<SkillRunResult> {
  const scriptPath = resolveSkillScript(input.skill.dir, input.script)
  const interpreter = interpreterFor(input.script)
  const cwd = resolveProjectCwd(input.projectDir, input.cwd)
  const choice = resolveSkillEnvironment(input.skill, input.sessionEnvironment)
  const applied = applyOverrides(choice.ref, input.projectDir)
  const descriptor = describeEnvironment(applied.ref, {
    skill: input.skill,
    projectDir: input.projectDir,
    pluginId: input.pluginId,
    agentDir: input.agentDir,
    environmentsDir: input.environmentsDir,
    platform: input.platform
  })
  const env = readyEnvironment(input.root, descriptor)
  const run = await runInEnvironment(env, [interpreter, scriptPath, ...(input.args ?? [])], {
    cwd,
    signal: input.signal,
    onOutput: input.onOutput,
    timeoutMs: input.timeoutMs
  })
  return toSkillRunResult(run, [...choice.warnings, ...applied.warnings])
}

function interpreterFor(script: string): string {
  const interpreter = INTERPRETERS[extname(script)]
  if (!interpreter) throw new Error(`unsupported script extension for '${script}'`)
  return interpreter
}

function resolveSkillScript(skillDir: string, script: string): string {
  if (script.length === 0 || isAbsolute(script)) {
    throw new Error(`script path must be relative to scripts/: '${script}'`)
  }
  if (script.split('/').includes('..')) {
    throw new Error(`script path must stay inside scripts/: '${script}'`)
  }
  const scriptsDir = join(skillDir, 'scripts')
  const absolute = resolve(scriptsDir, script)
  if (!isInside(resolve(scriptsDir), absolute)) {
    throw new Error(`script path must stay inside scripts/: '${script}'`)
  }
  let realFile: string
  let realScripts: string
  let realSkill: string
  try {
    realFile = realpathSync(absolute)
    realScripts = realpathSync(scriptsDir)
    realSkill = realpathSync(skillDir)
  } catch {
    throw new Error(`script '${script}' does not exist`)
  }
  if (!isInside(realScripts, realFile) || !isInside(realSkill, realFile)) {
    throw new Error(`script '${script}' resolves outside scripts/`)
  }
  if (!statSync(realFile).isFile()) {
    throw new Error(`script '${script}' is not a file`)
  }
  return realFile
}

function resolveProjectCwd(projectDir: string, cwd: string | undefined): string {
  const requested = cwd === undefined || cwd === '' ? '.' : cwd
  if (isAbsolute(requested)) {
    throw new Error(`cwd must be project-relative: '${requested}'`)
  }
  const absolute = resolve(projectDir, requested)
  if (!isInside(resolve(projectDir), absolute)) {
    throw new Error(`cwd must stay inside the project: '${requested}'`)
  }
  let real: string
  let realRoot: string
  try {
    real = realpathSync(absolute)
    realRoot = realpathSync(projectDir)
  } catch {
    throw new Error(`cwd does not exist: '${requested}'`)
  }
  if (!isInside(realRoot, real)) {
    throw new Error(`cwd must stay inside the project: '${requested}'`)
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`cwd is not a directory: '${requested}'`)
  }
  return real
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function toSkillRunResult(run: RunResult, warnings: string[]): SkillRunResult {
  const result: SkillRunResult = {
    envId: run.envId,
    resolvedCommand: run.resolvedCommand,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: run.durationMs,
    warnings
  }
  if (run.terminated) result.terminated = run.terminated
  return result
}
