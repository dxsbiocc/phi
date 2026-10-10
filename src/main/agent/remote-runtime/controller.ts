import type { EnvironmentRequestConfirm } from '../content/env-request'
import type { RemoteRuntimeWorkspace, RemoteSkillSource } from './types'
import {
  RemoteEnvironmentService,
  type RemoteEnvironmentServiceOptions
} from './environment-service'
import { RemoteSkillService } from './skill-service'
import { openRemoteRuntimeWorkspace, type RemoteRuntimeTarget } from './workspace'

export interface RemoteRuntimeControllerOptions {
  micromambaVersion: string
  resolveTarget: (params: unknown) => RemoteRuntimeTarget | undefined
  listSkills: () => Promise<readonly RemoteSkillSource[]>
  confirmEnvironment: (request: EnvironmentRequestConfirm) => Promise<boolean>
  resolveBasePackages?: (ref: string, pluginId?: string) => Promise<readonly string[]>
  resolveBaseEnvironment?: RemoteEnvironmentServiceOptions['resolveBaseEnvironment']
  openWorkspace?: typeof openRemoteRuntimeWorkspace
}

export class RemoteRuntimeController {
  readonly environments: RemoteEnvironmentService
  readonly skills: RemoteSkillService
  private readonly targets = new Map<string, RemoteRuntimeTarget>()

  constructor(private readonly options: RemoteRuntimeControllerOptions) {
    const openWorkspace = async (
      runtimeSessionId: string,
      signal?: AbortSignal
    ): Promise<RemoteRuntimeWorkspace> => {
      const target = this.targets.get(runtimeSessionId)
      if (!target) throw new Error('远程运行时会话归属无效；没有回退到本机执行。')
      return (options.openWorkspace ?? openRemoteRuntimeWorkspace)(target, signal)
    }
    this.environments = new RemoteEnvironmentService({
      openWorkspace,
      micromambaVersion: options.micromambaVersion,
      confirm: options.confirmEnvironment,
      ...(options.resolveBasePackages ? { resolveBasePackages: options.resolveBasePackages } : {}),
      ...(options.resolveBaseEnvironment
        ? { resolveBaseEnvironment: options.resolveBaseEnvironment }
        : {})
    })
    this.skills = new RemoteSkillService({
      openWorkspace,
      environments: this.environments,
      listSkills: options.listSkills
    })
  }

  owns(params: unknown): boolean {
    return this.remember(params) !== undefined
  }

  scriptTools(params: unknown): ReturnType<RemoteSkillService['scriptTools']> {
    this.requireTarget(params)
    return this.skills.scriptTools()
  }

  runSkill(params: unknown): ReturnType<RemoteSkillService['run']> {
    this.requireTarget(params)
    return this.skills.run(params)
  }

  runScriptTool(params: unknown): ReturnType<RemoteSkillService['scriptTool']> {
    this.requireTarget(params)
    return this.skills.scriptTool(params)
  }

  requestEnvironment(params: unknown): ReturnType<RemoteEnvironmentService['request']> {
    this.requireTarget(params)
    return this.environments.request(params)
  }

  bindEnvironment(params: unknown): ReturnType<RemoteEnvironmentService['bindSession']> {
    this.requireTarget(params)
    return this.environments.bindSession(params)
  }

  approvalFor(toolName: string, input: unknown): 'exec' | 'read' | 'write' | undefined {
    return this.skills.approvalFor(toolName, input)
  }

  private requireTarget(params: unknown): RemoteRuntimeTarget {
    const target = this.remember(params)
    if (!target) throw new Error('远程运行时请求缺少会话归属；没有回退到本机执行。')
    return target
  }

  private remember(params: unknown): RemoteRuntimeTarget | undefined {
    const direct = this.options.resolveTarget(params)
    if (hasRemoteIdentity(params) && !direct) {
      throw new Error('远程运行时请求的会话或项目身份无效；没有回退到本机执行。')
    }
    if (direct) {
      const existing = this.targets.get(direct.runtimeSessionId)
      if (
        existing &&
        (existing.sessionId !== direct.sessionId || existing.projectId !== direct.projectId)
      ) {
        throw new Error('远程运行时会话身份发生变化；已拒绝执行且没有回退到本机。')
      }
      this.targets.set(direct.runtimeSessionId, direct)
    }
    const runtimeSessionId = field(params, 'runtimeSessionId')
    return direct ?? (runtimeSessionId ? this.targets.get(runtimeSessionId) : undefined)
  }
}

function hasRemoteIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.hasOwn(value, 'remoteSessionId') || Object.hasOwn(value, 'projectId')
}

function field(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' && item ? item : undefined
}
