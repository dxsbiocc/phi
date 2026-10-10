import type { ScriptTool, ValidatedSkill } from '../content/skill'
import { scriptToolsOf, validateSkill } from '../content/skill'
import { scriptToolApproval } from '../content/script-tools'
import { resolveSkillEnvironment } from '../content/environment-refs'
import type { SkillNotReady } from '../content/skill-host'
import type { SkillRunResult } from '../content/skill-run'
import type { ScriptToolResult } from '../content/script-tools'
import type { ScriptToolDescriptor } from '../content/skill-tool-types'
import type { CommandResult } from '../workspace-host/types'
import { RemoteEnvironmentService } from './environment-service'
import { remoteScriptArguments } from './script-arguments'
import { prepareRemoteSkillBundle } from './skill-bundle'
import {
  checkedRawArgs,
  checkedScript,
  abortedSkillResult,
  descriptor,
  errorText,
  interpreter,
  missingToolEnvironment,
  notReady,
  projectCwd,
  requiredRequestId,
  scriptToolResult,
  skillResult,
  translatedRun,
  validRunRequest,
  validScriptToolRequest,
  type RemoteScriptToolRequest
} from './skill-service-helpers'
import type {
  OpenRemoteRuntimeWorkspace,
  RemoteEnvironmentHandle,
  RemoteRuntimeWorkspace,
  RemoteSkillSource
} from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_OUTPUT_BYTES = 1024 * 1024
interface RememberedTool {
  skill: ValidatedSkill
  tool: ScriptTool
}

export interface RemoteSkillServiceOptions {
  openWorkspace: OpenRemoteRuntimeWorkspace
  environments: RemoteEnvironmentService
  listSkills: () => Promise<readonly RemoteSkillSource[]>
  timeoutMs?: number
  maxOutputBytes?: number
}

export class RemoteSkillService {
  private readonly remembered = new Map<string, RememberedTool>()
  private readonly runs = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly options: RemoteSkillServiceOptions) {}

  async scriptTools(): Promise<{ tools: ScriptToolDescriptor[]; problems: string[] }> {
    const tools: ScriptToolDescriptor[] = []
    const problems: string[] = []
    const seen = new Set<string>()
    for (const source of await this.options.listSkills()) {
      const skill = this.validateSource(source, problems)
      const prefix = source.toolPrefix ?? skill?.phi?.toolPrefix
      if (!skill || !prefix) continue
      for (const tool of scriptToolsOf(skill, { prefix })) {
        if (seen.has(tool.name)) {
          problems.push(`duplicate script tool name '${tool.name}'`)
          continue
        }
        seen.add(tool.name)
        this.remembered.set(tool.name, { skill, tool })
        tools.push(descriptor(tool, skill.name))
      }
    }
    return { tools, problems }
  }

  async run(params: unknown): Promise<SkillRunResult | SkillNotReady> {
    const input = validRunRequest(params)
    const controller = this.begin(input.requestId)
    let workspace: RemoteRuntimeWorkspace | undefined
    try {
      const skill = await this.resolveSkill(input.skill, input.allowedSkills)
      workspace = await this.options.openWorkspace(input.runtimeSessionId, controller.signal)
      const bundle = await prepareRemoteSkillBundle(skill.dir, workspace, controller.signal)
      const script = checkedScript(bundle, input.script)
      const cwd = await projectCwd(workspace, input.runCwd)
      const selected = await this.environmentFor(workspace, skill, input.sessionEnvironment)
      if (!selected.environment) return notReady(selected.ref)
      const args = checkedRawArgs(input.args, workspace, bundle)
      const command = [
        this.options.environments.micromambaPath(workspace),
        'run',
        '-p',
        selected.environment.prefix,
        interpreter(input.script),
        script,
        ...args
      ]
      const startedAt = performance.now()
      const result = await this.execute(workspace, command, cwd, controller.signal)
      return skillResult(
        result,
        selected.environment,
        command,
        controller.signal,
        performance.now() - startedAt,
        selected.warnings
      )
    } catch (error) {
      if (controller.signal.aborted) return abortedSkillResult()
      throw error
    } finally {
      await workspace?.close?.().catch(() => undefined)
      this.end(input.requestId, controller)
    }
  }

  async scriptTool(params: unknown): Promise<ScriptToolResult> {
    const input = validScriptToolRequest(params)
    const controller = this.begin(input.requestId)
    let workspace: RemoteRuntimeWorkspace | undefined
    try {
      const remembered = this.remembered.get(input.tool)
      if (!remembered) throw new Error(`unknown script tool '${input.tool}'`)
      workspace = await this.options.openWorkspace(input.runtimeSessionId, controller.signal)
      return await this.executeScriptTool(workspace, remembered, input, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: 'aborted', warnings: [] }
      return { ok: false, error: errorText(error), warnings: [] }
    } finally {
      await workspace?.close?.().catch(() => undefined)
      this.end(input.requestId, controller)
    }
  }

  cancel(params: unknown): void {
    const requestId = requiredRequestId(params)
    const controller = this.runs.get(requestId)
    if (controller) controller.abort()
    else this.cancelled.add(requestId)
  }

  approvalFor(toolName: string, input: unknown): 'exec' | 'read' | 'write' | undefined {
    if (toolName === 'skill_run') return 'exec'
    const remembered = this.remembered.get(toolName)
    return remembered ? scriptToolApproval(remembered.tool, input) : undefined
  }

  private validateSource(
    source: RemoteSkillSource,
    problems: string[]
  ): ValidatedSkill | undefined {
    if (source.remoteUnsupportedReason) {
      problems.push(`${source.name}: ${source.remoteUnsupportedReason}`)
      return undefined
    }
    try {
      const result = validateSkill(source.dir, {
        insidePlugin: source.insidePlugin,
        expectedName: source.name
      })
      if (result.ok && result.skill) {
        if (result.skill.phi?.environment === './environment.yml') {
          problems.push(
            `${source.name}: 远程 Skill 暂不构建 ./environment.yml；请改用 phi: 基础环境，或先在可联网机器预构建并迁移。没有回退到本机。`
          )
          return undefined
        }
        return result.skill
      }
      const problem = result.errors[0]
      problems.push(
        problem
          ? `invalid skill '${source.name}': ${problem.path}: ${problem.message}`
          : `invalid skill '${source.name}'`
      )
    } catch (error) {
      problems.push(`invalid skill '${source.name}': ${errorText(error)}`)
    }
    return undefined
  }

  private async resolveSkill(name: string, allowed?: readonly string[]): Promise<ValidatedSkill> {
    if (allowed && !allowed.includes(name)) throw new Error(`skill '${name}' is disabled`)
    const source = (await this.options.listSkills()).find((candidate) => candidate.name === name)
    if (!source) throw new Error(`unknown skill '${name}'`)
    if (source.remoteUnsupportedReason) throw new Error(source.remoteUnsupportedReason)
    const problems: string[] = []
    const skill = this.validateSource(source, problems)
    if (!skill) throw new Error(problems[0] ?? `invalid skill '${name}'`)
    return skill
  }

  private async environmentFor(
    workspace: RemoteRuntimeWorkspace,
    skill: ValidatedSkill,
    sessionEnvironment?: string
  ): Promise<{
    environment?: RemoteEnvironmentHandle
    ref: string
    warnings: string[]
  }> {
    const choice = resolveSkillEnvironment(skill, sessionEnvironment)
    const environment = await this.options.environments.resolveInWorkspace(choice.ref, workspace)
    return { ref: choice.ref, warnings: choice.warnings, ...(environment ? { environment } : {}) }
  }

  private execute(
    workspace: RemoteRuntimeWorkspace,
    command: string[],
    cwd: string,
    signal: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  ): Promise<CommandResult> {
    return workspace.projectHost.exec.run(command as [string, ...string[]], {
      cwd,
      env: { MAMBA_ROOT_PREFIX: workspace.runtimeRoot },
      signal,
      timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
    })
  }

  private async executeScriptTool(
    workspace: RemoteRuntimeWorkspace,
    remembered: RememberedTool,
    input: RemoteScriptToolRequest,
    signal: AbortSignal
  ): Promise<ScriptToolResult> {
    const bundle = await prepareRemoteSkillBundle(remembered.skill.dir, workspace, signal)
    const selected = await this.environmentFor(
      workspace,
      remembered.skill,
      input.sessionEnvironment
    )
    if (!selected.environment)
      return missingToolEnvironment(remembered.skill, input.sessionEnvironment)
    const { flags } = await remoteScriptArguments(workspace, remembered.tool.args, input.args)
    const run = translatedRun(remembered.skill, remembered.tool, bundle)
    const command = [
      this.options.environments.micromambaPath(workspace),
      'run',
      '-p',
      selected.environment.prefix,
      ...run,
      ...flags
    ]
    const timeout = (remembered.tool.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000
    const result = await this.execute(workspace, command, workspace.projectRoot, signal, timeout)
    return scriptToolResult(
      result,
      remembered.tool,
      selected.environment,
      signal,
      selected.warnings
    )
  }

  private begin(requestId: string): AbortController {
    const controller = new AbortController()
    if (this.cancelled.delete(requestId)) controller.abort()
    this.runs.get(requestId)?.abort()
    this.runs.set(requestId, controller)
    return controller
  }

  private end(requestId: string, controller: AbortController): void {
    if (this.runs.get(requestId) === controller) this.runs.delete(requestId)
  }
}
