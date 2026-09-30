import { basename } from 'node:path'

import { getRuntimeRoot, type PhiPlatform } from '../envs'
import { estimateBuild, type BuildEstimate } from '../envs/estimate'
import type { ScriptTool, ValidatedSkill } from './skill'
import type { EnvironmentBuilds } from './environment-builds'
import {
  EnvironmentNotReadyError,
  describeEnvironment,
  readyEnvironment,
  resolveSkillEnvironment,
  runScriptTool,
  runSkillScript,
  scriptToolApproval,
  scriptToolsOf,
  validateSkill,
  type ScriptToolResult,
  type SkillRunResult,
  type SkillValidationResult
} from './index'
import type { ScriptToolDescriptor } from './skill-tool-types'

export interface SkillNotReady {
  notReady: {
    ref: string
    envId: string
    message: string
  }
}

export interface ConfirmBuildRequest {
  runtimeSessionId: string
  ref: string
  skill: string
  estimate: BuildEstimate
}

export interface SkillHost {
  scriptTools(params: unknown): Promise<{ tools: ScriptToolDescriptor[]; problems: string[] }>
  run(params: unknown): Promise<SkillRunResult | SkillNotReady>
  scriptTool(params: unknown): Promise<ScriptToolResult>
  cancel(params: unknown): void
  approvalFor(toolName: string, input: unknown): 'exec' | 'read' | 'write' | undefined
}

interface RememberedTool {
  skill: ValidatedSkill
  tool: ScriptTool
}

type EnvironmentGate =
  | { action: 'continue'; warnings: string[] }
  | { action: 'notReady'; notReady: SkillNotReady['notReady']; warnings: string[] }
  | { action: 'aborted'; envId: string; warnings: string[] }

/**
 * Main-process handlers for `skills.*`. A missing environment is not replaced by the host.
 * With a `runtimeSessionId`, the user can confirm a build; otherwise the call stays not-ready.
 */
export function createSkillHost({
  runtimeRoot = getRuntimeRoot(),
  listSkillDirs,
  environmentsDir,
  platform,
  builds,
  confirmBuild
}: {
  runtimeRoot?: string
  listSkillDirs: (cwd: string) => Promise<string[]>
  environmentsDir?: string
  platform?: PhiPlatform
  builds?: EnvironmentBuilds
  confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
}): SkillHost {
  const remembered = new Map<string, RememberedTool>()
  const runs = new Map<string, AbortController>()
  const cancelled = new Set<string>()

  function begin(requestId: string): AbortController {
    const controller = new AbortController()
    if (cancelled.delete(requestId)) controller.abort()
    const previous = runs.get(requestId)
    runs.set(requestId, controller)
    previous?.abort()
    return controller
  }

  function end(requestId: string, controller: AbortController): void {
    if (runs.get(requestId) === controller) runs.delete(requestId)
  }

  async function resolveSkill(cwd: string, name: string): Promise<ValidatedSkill> {
    const dirs = await listSkillDirs(cwd)
    const dir = dirs.find((candidate) => basename(candidate) === name)
    if (!dir) throw new Error(`unknown skill '${name}'`)
    let validation: SkillValidationResult
    try {
      validation = validateSkill(dir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`invalid skill '${name}': ${message}`)
    }
    if (!validation.ok || !validation.skill) {
      const detail = validation.errors
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join('; ')
      throw new Error(`invalid skill '${name}': ${detail || 'validation failed'}`)
    }
    return validation.skill
  }

  function building(envId: string): boolean {
    return builds?.list().some((item) => item.envId === envId && item.state === 'building') ?? false
  }

  function failureReason(envId: string, error: unknown): string {
    const entry = builds?.list().find((item) => item.envId === envId)
    if (entry?.state === 'cancelled' || entry?.state === 'failed') {
      return entry.error ?? (entry.state === 'cancelled' ? 'build cancelled' : 'build failed')
    }
    return error instanceof Error ? error.message : String(error)
  }

  async function gateEnvironment(input: {
    skill: ValidatedSkill
    sessionEnvironment?: string
    runtimeSessionId?: string
    signal: AbortSignal
  }): Promise<EnvironmentGate> {
    const choice = resolveSkillEnvironment(input.skill, input.sessionEnvironment)
    const warnings = choice.warnings
    let descriptor: ReturnType<typeof describeEnvironment>
    try {
      descriptor = describeEnvironment(choice.ref, {
        skill: input.skill,
        ...(environmentsDir ? { environmentsDir } : {}),
        ...(platform ? { platform } : {})
      })
    } catch {
      // An unusable reference is reported by the executor in its own result shape.
      return { action: 'continue', warnings }
    }
    try {
      readyEnvironment(runtimeRoot, descriptor)
      return { action: 'continue', warnings }
    } catch (error) {
      if (!(error instanceof EnvironmentNotReadyError)) throw error
      if (input.signal.aborted) return { action: 'aborted', envId: error.envId, warnings }
      const join = building(error.envId)
      const sessionId = input.runtimeSessionId
      if (!join && (!sessionId || !confirmBuild || !builds)) {
        return { action: 'continue', warnings }
      }
      if (!builds) return { action: 'continue', warnings }
      try {
        if (!join && sessionId && confirmBuild) {
          const estimate = estimateBuild(runtimeRoot, descriptor.lockText)
          const accepted = await untilAbort(
            confirmBuild({
              runtimeSessionId: sessionId,
              ref: error.ref,
              skill: input.skill.name,
              estimate
            }),
            input.signal
          )
          if (!accepted) {
            return {
              action: 'notReady',
              warnings,
              notReady: {
                ref: error.ref,
                envId: error.envId,
                message: `environment ${error.ref} is not built; the user declined to build it now`
              }
            }
          }
        }
        await untilAbort(
          builds.start(descriptor, {
            ref: error.ref,
            requestedBy: { skill: input.skill.name }
          }),
          input.signal
        )
        return { action: 'continue', warnings }
      } catch (waitError) {
        if (input.signal.aborted || isAbortError(waitError)) {
          return { action: 'aborted', envId: error.envId, warnings }
        }
        return {
          action: 'notReady',
          warnings,
          notReady: {
            ref: error.ref,
            envId: error.envId,
            message: `environment ${error.ref} is not ready; ${failureReason(error.envId, waitError)}`
          }
        }
      }
    }
  }

  return {
    async scriptTools(params) {
      const cwd = requireString(requireRecord(params), 'cwd')
      const dirs = await listSkillDirs(cwd)
      const tools: ScriptToolDescriptor[] = []
      const problems: string[] = []
      const seenNames = new Set<string>()

      for (const dir of dirs) {
        let validation: SkillValidationResult
        try {
          validation = validateSkill(dir)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          problems.push(`invalid skill '${basename(dir)}': ${message}`)
          continue
        }
        if (!validation.ok || !validation.skill) {
          const error = validation.errors[0]
          problems.push(
            error
              ? `invalid skill '${basename(dir)}': ${error.path}: ${error.message}`
              : `invalid skill '${basename(dir)}'`
          )
          continue
        }

        const skill = validation.skill
        const prefix = skill.phi?.toolPrefix
        if (!prefix) continue
        for (const tool of scriptToolsOf(skill, { prefix })) {
          if (seenNames.has(tool.name)) {
            problems.push(`duplicate script tool name '${tool.name}'`)
            continue
          }
          seenNames.add(tool.name)
          tools.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.args,
            attachTo: [...tool.attachTo],
            skill: skill.name,
            approval: tool.approval
          })
          remembered.set(tool.name, { skill, tool })
        }
      }

      return { tools, problems }
    },

    async run(params) {
      const record = requireRecord(params)
      const requestId = requireString(record, 'requestId')
      const cwd = requireString(record, 'cwd')
      const skillName = requireString(record, 'skill')
      const script = requireString(record, 'script')
      const args = optionalStringArray(record, 'args')
      const runCwd = optionalString(record, 'runCwd')
      const sessionEnvironment = optionalString(record, 'sessionEnvironment')
      const runtimeSessionId = optionalSessionId(record)
      const skill = await resolveSkill(cwd, skillName)
      const controller = begin(requestId)
      try {
        const gate = await gateEnvironment({
          skill,
          ...(sessionEnvironment !== undefined ? { sessionEnvironment } : {}),
          ...(runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
          signal: controller.signal
        })
        if (gate.action === 'aborted') return abortedRun(gate.envId, gate.warnings)
        if (gate.action === 'notReady') return { notReady: gate.notReady }
        return await runSkillScript({
          root: runtimeRoot,
          projectDir: cwd,
          skill,
          script,
          ...(args ? { args } : {}),
          ...(runCwd !== undefined ? { cwd: runCwd } : {}),
          ...(sessionEnvironment !== undefined ? { sessionEnvironment } : {}),
          ...(environmentsDir ? { environmentsDir } : {}),
          ...(platform ? { platform } : {}),
          signal: controller.signal
        })
      } catch (error) {
        if (error instanceof EnvironmentNotReadyError) {
          return {
            notReady: {
              ref: error.ref,
              envId: error.envId,
              message: `environment ${error.ref} is not ready; the user must build it first`
            }
          }
        }
        if (controller.signal.aborted || isAbortError(error)) {
          return abortedRun('', [])
        }
        throw error
      } finally {
        end(requestId, controller)
      }
    },

    async scriptTool(params) {
      const record = requireRecord(params)
      const requestId = requireString(record, 'requestId')
      const cwd = requireString(record, 'cwd')
      const toolName = requireString(record, 'tool')
      if (!Object.hasOwn(record, 'args')) throw new Error('args is required')
      const entry = remembered.get(toolName)
      if (!entry) throw new Error(`unknown script tool '${toolName}'`)
      const sessionEnvironment = optionalString(record, 'sessionEnvironment')
      const runtimeSessionId = optionalSessionId(record)
      const controller = begin(requestId)
      try {
        const gate = await gateEnvironment({
          skill: entry.skill,
          ...(sessionEnvironment !== undefined ? { sessionEnvironment } : {}),
          ...(runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
          signal: controller.signal
        })
        if (gate.action === 'aborted') {
          return { ok: false, error: 'aborted', envId: gate.envId, warnings: gate.warnings }
        }
        if (gate.action === 'notReady') {
          return {
            ok: false,
            error: gate.notReady.message,
            envId: gate.notReady.envId,
            warnings: gate.warnings
          }
        }
        return await runScriptTool({
          root: runtimeRoot,
          projectDir: cwd,
          skill: entry.skill,
          tool: entry.tool,
          args: record.args,
          ...(sessionEnvironment !== undefined ? { sessionEnvironment } : {}),
          ...(environmentsDir ? { environmentsDir } : {}),
          ...(platform ? { platform } : {}),
          signal: controller.signal
        })
      } finally {
        end(requestId, controller)
      }
    },

    cancel(params) {
      const requestId = requireString(requireRecord(params), 'requestId')
      const controller = runs.get(requestId)
      if (controller) {
        controller.abort()
        return
      }
      cancelled.add(requestId)
    },

    approvalFor(toolName, input) {
      if (toolName === 'skill_run') return 'exec'
      const entry = remembered.get(toolName)
      if (!entry) return undefined
      return scriptToolApproval(entry.tool, input)
    }
  }
}

function abortedRun(envId: string, warnings: string[]): SkillRunResult {
  return {
    envId,
    resolvedCommand: '',
    exitCode: null,
    terminated: 'aborted',
    stdout: '',
    stderr: '',
    truncated: { stdout: false, stderr: false },
    durationMs: 0,
    warnings
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else reject(error)
      }
    )
  })
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined
  if (typeof record[key] !== 'string') throw new Error(`${key} must be a string`)
  return record[key]
}

function optionalSessionId(record: Record<string, unknown>): string | undefined {
  const value = optionalString(record, 'runtimeSessionId')
  return value && value.length > 0 ? value : undefined
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (record[key] === undefined) return undefined
  const value = record[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}
