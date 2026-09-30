import { basename } from 'node:path'

import { getRuntimeRoot, type PhiPlatform } from '../envs'
import type { ScriptTool, ValidatedSkill } from './skill'
import {
  EnvironmentNotReadyError,
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

/**
 * Main-process handlers for `skills.*`. Does not build environments: a missing one
 * is returned as `notReady` so the user can build it.
 */
export function createSkillHost({
  runtimeRoot = getRuntimeRoot(),
  listSkillDirs,
  environmentsDir,
  platform
}: {
  runtimeRoot?: string
  listSkillDirs: (cwd: string) => Promise<string[]>
  environmentsDir?: string
  platform?: PhiPlatform
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
      const skill = await resolveSkill(cwd, skillName)
      const controller = begin(requestId)
      try {
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
      const controller = begin(requestId)
      try {
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

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (record[key] === undefined) return undefined
  const value = record[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}
