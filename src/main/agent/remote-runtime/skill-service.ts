import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ScriptTool, ValidatedSkill } from '../content/skill'
import { scriptToolsOf, validateSkill } from '../content/skill'
import { scriptToolApproval } from '../content/script-tools'
import { resolveSkillEnvironment } from '../content/environment-refs'
import type { SkillNotReady } from '../content/skill-host'
import type { SkillRunResult } from '../content/skill-run'
import type { ScriptToolResult } from '../content/script-tools'
import type { ScriptToolDescriptor } from '../content/skill-tool-types'
import { buildRemoteMicromambaHostCommand } from '../workspace-host/remote-micromamba-command'
import type { CommandResult, HostCommand } from '../workspace-host/types'
import { RemoteEnvironmentService } from './environment-service'
import { remoteScriptArguments } from './script-arguments'
import {
  prepareRemoteSkillBundle,
  prepareRemoteSkillBundleFiles,
  collectRemoteSkillBundleFiles,
  validateRemoteSkillBundleFiles
} from './skill-bundle'
import { diagnoseRemoteCommandFailure, type RemoteWriteDiagnosis } from './write-diagnostics'
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
  RemoteSkillBundleFile,
  RemoteSkillSource
} from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_OUTPUT_BYTES = 1024 * 1024
const WRITE_PROBE_TIMEOUT_MS = 10_000
const WRITE_PROBE_OUTPUT_BYTES = 8 * 1024
interface RememberedTool {
  skill: ValidatedSkill
  tool: ScriptTool
  source: RemoteSkillSource
}

export interface RemoteSkillServiceOptions {
  openWorkspace: OpenRemoteRuntimeWorkspace
  environments: RemoteEnvironmentService
  listSkills: (runtimeSessionId?: string) => Promise<readonly RemoteSkillSource[]>
  timeoutMs?: number
  maxOutputBytes?: number
}

export class RemoteSkillService {
  private readonly remembered = new Map<string, RememberedTool>()
  private readonly latestRemembered = new Map<string, RememberedTool>()
  private readonly runs = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly options: RemoteSkillServiceOptions) {}

  async scriptTools(
    params?: unknown
  ): Promise<{ tools: ScriptToolDescriptor[]; problems: string[] }> {
    const tools: ScriptToolDescriptor[] = []
    const problems: string[] = []
    const seen = new Set<string>()
    const runtimeSessionId = field(params, 'runtimeSessionId')
    for (const listed of await this.options.listSkills(runtimeSessionId)) {
      // The executable bytes and declaration share one trusted selection snapshot.
      let source: RemoteSkillSource
      try {
        source = {
          ...listed,
          files:
            listed.files ??
            (!listed.remoteProject ? collectRemoteSkillBundleFiles(listed.dir) : undefined)
        }
      } catch (error) {
        problems.push(`${listed.name}: ${errorText(error)}`)
        continue
      }
      const prepared = this.withValidatedSource(source, problems, (skill) => {
        const prefix = source.toolPrefix ?? skill.phi?.toolPrefix
        return { skill, tools: prefix ? scriptToolsOf(skill, { prefix }) : [] }
      })
      if (!prepared) continue
      for (const tool of prepared.tools) {
        if (seen.has(tool.name)) {
          problems.push(`duplicate script tool name '${tool.name}'`)
          continue
        }
        seen.add(tool.name)
        const remembered = {
          skill: prepared.skill,
          tool,
          source
        }
        this.remembered.set(toolKey(runtimeSessionId, tool.name), remembered)
        this.latestRemembered.set(tool.name, remembered)
        tools.push(descriptor(tool, prepared.skill.name))
      }
    }
    return { tools, problems }
  }

  async run(params: unknown): Promise<SkillRunResult | SkillNotReady> {
    const input = validRunRequest(params)
    const controller = this.begin(input.requestId)
    let workspace: RemoteRuntimeWorkspace | undefined
    try {
      const resolved = await this.resolveSkill(
        input.skill,
        input.allowedSkills,
        input.runtimeSessionId
      )
      workspace = await this.options.openWorkspace(input.runtimeSessionId, controller.signal)
      const bundle = await this.prepareBundle(resolved.source, workspace, controller.signal)
      const script = checkedScript(bundle, input.script)
      const cwd = await projectCwd(workspace, input.runCwd)
      const selected = await this.environmentFor(
        workspace,
        resolved.skill,
        input.sessionEnvironment
      )
      if (!selected.environment) return notReady(selected.ref)
      const args = checkedRawArgs(input.args, workspace, bundle)
      const command: [string, 'run', ...string[]] = [
        this.options.environments.micromambaPath(workspace),
        'run',
        '-p',
        selected.environment.prefix,
        interpreter(input.script),
        script,
        ...args
      ]
      const startedAt = performance.now()
      const result = await this.executeMicromambaRun(workspace, command, cwd, controller.signal)
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
      const remembered =
        this.remembered.get(toolKey(input.runtimeSessionId, input.tool)) ??
        this.remembered.get(toolKey(undefined, input.tool))
      if (!remembered) throw new Error(`unknown script tool '${input.tool}'`)
      const current = await this.refreshRemoteSource(input.runtimeSessionId, remembered)
      workspace = await this.options.openWorkspace(input.runtimeSessionId, controller.signal)
      return await this.executeScriptTool(workspace, current, input, controller.signal)
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
    const runtimeSessionId = field(input, 'runtimeSessionId')
    const remembered =
      this.remembered.get(toolKey(runtimeSessionId, toolName)) ??
      this.remembered.get(toolKey(undefined, toolName)) ??
      (!runtimeSessionId ? this.latestRemembered.get(toolName) : undefined)
    return remembered ? scriptToolApproval(remembered.tool, input) : undefined
  }

  private withValidatedSource<T>(
    source: RemoteSkillSource,
    problems: string[],
    consume: (skill: ValidatedSkill) => T
  ): T | undefined {
    if (source.remoteUnsupportedReason) {
      problems.push(`${source.name}: ${source.remoteUnsupportedReason}`)
      return undefined
    }
    let temporaryRoot: string | undefined
    try {
      let dir = source.dir
      if (source.files) {
        const files = validateRemoteSkillBundleFiles(source.files)
        temporaryRoot = mkdtempSync(join(tmpdir(), 'phi-remote-skill-validation-'))
        dir = join(temporaryRoot, 'skill')
        materializeSkillSnapshot(dir, files)
      } else if (source.remoteProject) {
        throw new Error('服务器项目 Skill 缺少已发现的文件快照；没有回退到本机。')
      }
      const result = validateSkill(dir, {
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
        return consume(result.skill)
      }
      const problem = result.errors[0]
      problems.push(
        problem
          ? `invalid skill '${source.name}': ${problem.path}: ${problem.message}`
          : `invalid skill '${source.name}'`
      )
    } catch (error) {
      problems.push(`invalid skill '${source.name}': ${errorText(error)}`)
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
    }
    return undefined
  }

  private async resolveSkill(
    name: string,
    allowed: readonly string[] | undefined,
    runtimeSessionId: string
  ): Promise<{ skill: ValidatedSkill; source: RemoteSkillSource }> {
    if (allowed && !allowed.includes(name)) throw new Error(`skill '${name}' is disabled`)
    const source = (await this.options.listSkills(runtimeSessionId)).find(
      (candidate) => candidate.name === name
    )
    if (!source) throw new Error(`unknown skill '${name}'`)
    if (source.remoteUnsupportedReason) throw new Error(source.remoteUnsupportedReason)
    const problems: string[] = []
    const skill = this.withValidatedSource(source, problems, (value) => value)
    if (!skill) throw new Error(problems[0] ?? `invalid skill '${name}'`)
    return { skill, source }
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

  private async refreshRemoteSource(
    runtimeSessionId: string,
    remembered: RememberedTool
  ): Promise<RememberedTool> {
    const current = (await this.options.listSkills(runtimeSessionId)).find(
      (candidate) =>
        candidate.name === remembered.source.name &&
        candidate.filePath === remembered.source.filePath &&
        candidate.remoteProject === remembered.source.remoteProject &&
        candidate.pluginId === remembered.source.pluginId &&
        candidate.toolPrefix === remembered.source.toolPrefix
    )
    const source = current && {
      ...current,
      files:
        current.files ??
        (!current.remoteProject ? collectRemoteSkillBundleFiles(current.dir) : undefined)
    }
    if (!source?.files || !sameSkillSnapshot(remembered.source.files, source.files)) {
      throw new Error(
        `Skill '${remembered.source.name}' 不再受信任或内容已变化；请刷新并重新信任后再运行。`
      )
    }
    return { ...remembered, source }
  }

  private execute(
    workspace: RemoteRuntimeWorkspace,
    command: HostCommand,
    cwd: string,
    signal: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  ): Promise<CommandResult> {
    return workspace.projectHost.exec.run(command as [string, ...string[]], {
      cwd,
      signal,
      timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
    })
  }

  private async executeMicromambaRun(
    workspace: RemoteRuntimeWorkspace,
    command: readonly [string, 'run', ...string[]],
    cwd: string,
    signal: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  ): Promise<CommandResult> {
    const [binary, , ...args] = command
    const result = await this.execute(
      workspace,
      buildRemoteMicromambaHostCommand({
        binary,
        runtimeRoot: workspace.runtimeRoot,
        subcommand: 'run',
        args
      }),
      cwd,
      signal,
      timeoutMs
    )
    const diagnosis = await this.diagnoseFailure(workspace, result, signal)
    return diagnosis && diagnosis.kind !== 'other'
      ? { ...result, stderr: appendMessage(result.stderr, diagnosis.message) }
      : result
  }

  private async prepareBundle(
    source: RemoteSkillSource,
    workspace: RemoteRuntimeWorkspace,
    signal: AbortSignal
  ): ReturnType<typeof prepareRemoteSkillBundle> {
    try {
      return source.files
        ? await prepareRemoteSkillBundleFiles(source.files, workspace, signal)
        : await prepareRemoteSkillBundle(source.dir, workspace, signal)
    } catch (error) {
      signal.throwIfAborted()
      const message = errorText(error)
      if (!/^远程 Skill bundle (?:校验|上传)失败：/u.test(message)) throw error
      const diagnosis = await this.diagnoseFailure(
        workspace,
        { code: 1, stdout: '', stderr: message, signal: null, truncated: false },
        signal
      )
      if (diagnosis && diagnosis.kind !== 'other') {
        throw new Error(appendMessage(message, diagnosis.message))
      }
      throw error
    }
  }

  private diagnoseFailure(
    workspace: RemoteRuntimeWorkspace,
    result: CommandResult,
    signal: AbortSignal
  ): Promise<RemoteWriteDiagnosis | undefined> {
    return diagnoseRemoteCommandFailure(result, workspace.runtimeRoot, (script) =>
      workspace.execWithInput(script, {
        signal,
        timeoutMs: WRITE_PROBE_TIMEOUT_MS,
        maxOutputBytes: WRITE_PROBE_OUTPUT_BYTES
      })
    ).catch(() => undefined)
  }

  private async executeScriptTool(
    workspace: RemoteRuntimeWorkspace,
    remembered: RememberedTool,
    input: RemoteScriptToolRequest,
    signal: AbortSignal
  ): Promise<ScriptToolResult> {
    const bundle = await this.prepareBundle(remembered.source, workspace, signal)
    const selected = await this.environmentFor(
      workspace,
      remembered.skill,
      input.sessionEnvironment
    )
    if (!selected.environment)
      return missingToolEnvironment(remembered.skill, input.sessionEnvironment)
    const { flags } = await remoteScriptArguments(workspace, remembered.tool.args, input.args)
    const run = translatedRun(remembered.skill, remembered.tool, bundle)
    const command: [string, 'run', ...string[]] = [
      this.options.environments.micromambaPath(workspace),
      'run',
      '-p',
      selected.environment.prefix,
      ...run,
      ...flags
    ]
    const timeout = (remembered.tool.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000
    const result = await this.executeMicromambaRun(
      workspace,
      command,
      workspace.projectRoot,
      signal,
      timeout
    )
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

function appendMessage(output: string, message: string): string {
  const trimmed = output.trimEnd()
  return trimmed ? `${trimmed}\n${message}` : message
}

function materializeSkillSnapshot(root: string, files: readonly RemoteSkillBundleFile[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const path = join(root, ...file.relativePath.split('/'))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, file.content, { mode: file.executable ? 0o700 : 0o600 })
  }
}

function toolKey(runtimeSessionId: string | undefined, toolName: string): string {
  return `${runtimeSessionId ?? ''}\0${toolName}`
}

function field(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' && item ? item : undefined
}

function sameSkillSnapshot(
  left: readonly RemoteSkillBundleFile[] | undefined,
  right: readonly RemoteSkillBundleFile[]
): boolean {
  if (!left) return false
  const checkedLeft = validateRemoteSkillBundleFiles(left)
  const checkedRight = validateRemoteSkillBundleFiles(right)
  return (
    checkedLeft.length === checkedRight.length &&
    checkedLeft.every((file, index) => {
      const other = checkedRight[index]
      return (
        other !== undefined &&
        file.relativePath === other.relativePath &&
        file.contentHash === other.contentHash &&
        file.executable === other.executable
      )
    })
  )
}
