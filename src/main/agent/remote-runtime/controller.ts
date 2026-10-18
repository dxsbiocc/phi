import type { EnvironmentRequestConfirm } from '../content/env-request'
import type { RemoteRuntimeWorkspace, RemoteSkillSource } from './types'
import {
  RemoteEnvironmentService,
  type RemoteEnvironmentServiceOptions
} from './environment-service'
import { RemoteSkillService, type RemoteSkillResourceOwner } from './skill-service'
import { openRemoteRuntimeWorkspace, type RemoteRuntimeTarget } from './workspace'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Desktop-only call authority, never a wire argument or part of a saved resource. */
export interface RemoteRuntimeDispatchControl {
  signal?: AbortSignal
  beforeDispatch(): void
  readonly resourceOwner?: RemoteSkillResourceOwner
}

export interface RemoteRuntimeControllerOptions {
  micromambaVersion: string
  resolveTarget: (params: unknown) => RemoteRuntimeTarget | undefined
  listSkills: (
    runtimeSessionId?: string,
    target?: RemoteRuntimeTarget
  ) => Promise<readonly RemoteSkillSource[]>
  confirmEnvironment: (request: EnvironmentRequestConfirm) => Promise<boolean>
  resolveBasePackages?: (ref: string, pluginId?: string) => Promise<readonly string[]>
  resolveBaseEnvironment?: RemoteEnvironmentServiceOptions['resolveBaseEnvironment']
  openWorkspace?: typeof openRemoteRuntimeWorkspace
}

export class RemoteRuntimeController {
  readonly environments: RemoteEnvironmentService
  readonly skills: RemoteSkillService
  private readonly targets = new Map<string, RemoteRuntimeTarget>()
  private readonly controls = new AsyncLocalStorage<RemoteRuntimeDispatchControl>()

  constructor(private readonly options: RemoteRuntimeControllerOptions) {
    const openWorkspace = async (
      runtimeSessionId: string,
      signal?: AbortSignal
    ): Promise<RemoteRuntimeWorkspace> => {
      const target = this.targets.get(runtimeSessionId)
      if (!target)
        throw new Error(
          'Invalid remote runtime session ownership. No local execution fallback was used.'
        )
      const control = this.controls.getStore()
      const assertLive = (): void => {
        signal?.throwIfAborted()
        control?.signal?.throwIfAborted()
        control?.beforeDispatch()
      }
      assertLive()
      const workspace = await (options.openWorkspace ?? openRemoteRuntimeWorkspace)(target, signal)
      try {
        assertLive()
        if (!control) return workspace
        return controlRemoteRuntimeWorkspace(workspace, assertLive)
      } catch (error) {
        await workspace.close?.().catch(() => undefined)
        throw error
      }
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
      listSkills: (runtimeSessionId) =>
        options.listSkills(
          runtimeSessionId,
          runtimeSessionId ? this.targets.get(runtimeSessionId) : undefined
        ),
      resourceOwner: () => {
        const control = this.controls.getStore()
        control?.signal?.throwIfAborted()
        control?.beforeDispatch()
        return control?.resourceOwner
      }
    })
  }

  owns(params: unknown): boolean {
    return this.remember(params) !== undefined
  }

  scriptTools(params: unknown): ReturnType<RemoteSkillService['scriptTools']> {
    const target = this.requireTarget(params)
    return this.skills.scriptTools({ runtimeSessionId: target.runtimeSessionId })
  }

  runSkill(
    params: unknown,
    control?: RemoteRuntimeDispatchControl
  ): ReturnType<RemoteSkillService['run']> {
    this.requireTarget(params)
    return control
      ? this.controls.run(this.snapshotControl(control), () => this.skills.run(params))
      : this.skills.run(params)
  }

  runScriptTool(
    params: unknown,
    control?: RemoteRuntimeDispatchControl
  ): ReturnType<RemoteSkillService['scriptTool']> {
    this.requireTarget(params)
    return control
      ? this.controls.run(this.snapshotControl(control), () => this.skills.scriptTool(params))
      : this.skills.scriptTool(params)
  }

  requestEnvironment(
    params: unknown,
    control?: RemoteRuntimeDispatchControl
  ): ReturnType<RemoteEnvironmentService['request']> {
    this.requireTarget(params)
    return control
      ? this.controls.run(this.snapshotControl(control), () => this.environments.request(params))
      : this.environments.request(params)
  }

  bindEnvironment(
    params: unknown,
    control?: RemoteRuntimeDispatchControl
  ): ReturnType<RemoteEnvironmentService['bindSession']> {
    this.requireTarget(params)
    return control
      ? this.controls.run(this.snapshotControl(control), () =>
          this.environments.bindSession(params)
        )
      : this.environments.bindSession(params)
  }

  approvalFor(
    toolName: string,
    input: unknown,
    control?: RemoteRuntimeDispatchControl
  ): 'exec' | 'read' | 'write' | undefined {
    return control
      ? this.controls.run(this.snapshotControl(control), () =>
          this.skills.approvalFor(toolName, input)
        )
      : this.skills.approvalFor(toolName, input)
  }

  private snapshotControl(control: RemoteRuntimeDispatchControl): RemoteRuntimeDispatchControl {
    const owner = control.resourceOwner
    if (!owner) return control
    if (
      typeof owner.toolOwner !== 'string' ||
      !owner.toolOwner ||
      !Array.isArray(owner.allowedSkills) ||
      owner.allowedSkills.some((skill) => typeof skill !== 'string' || !skill)
    )
      throw new Error('The remote resource request has no trusted tool ownership.')
    return Object.freeze({
      signal: control.signal,
      beforeDispatch: control.beforeDispatch.bind(control),
      resourceOwner: Object.freeze({
        toolOwner: owner.toolOwner,
        allowedSkills: Object.freeze([...owner.allowedSkills])
      })
    })
  }

  private requireTarget(params: unknown): RemoteRuntimeTarget {
    const target = this.remember(params)
    if (!target)
      throw new Error(
        'The remote runtime request has no session ownership. No local execution fallback was used.'
      )
    return target
  }

  private remember(params: unknown): RemoteRuntimeTarget | undefined {
    const direct = this.options.resolveTarget(params)
    if (hasRemoteIdentity(params) && !direct) {
      throw new Error(
        'The remote runtime request has an invalid session or project identity. No local execution fallback was used.'
      )
    }
    if (direct) {
      const existing = this.targets.get(direct.runtimeSessionId)
      if (
        existing &&
        (existing.sessionId !== direct.sessionId || existing.projectId !== direct.projectId)
      ) {
        throw new Error(
          'The remote runtime session identity changed. Execution was denied and no local fallback was used.'
        )
      }
      this.targets.set(direct.runtimeSessionId, direct)
    }
    const runtimeSessionId = field(params, 'runtimeSessionId')
    return direct ?? (runtimeSessionId ? this.targets.get(runtimeSessionId) : undefined)
  }
}

/** Check each new IO/submit against the same captured target; cleanup remains owned. */
export function controlRemoteRuntimeWorkspace(
  workspace: RemoteRuntimeWorkspace,
  assertLive: () => void
): RemoteRuntimeWorkspace {
  const host = (value: RemoteRuntimeWorkspace['projectHost']): typeof value => ({
    ...value,
    capabilities: value.capabilities.bind(value),
    close: value.close?.bind(value),
    fs: guardOperations(value.fs, assertLive),
    exec: {
      run: (command, options) => {
        assertLive()
        return value.exec.run(command, {
          ...options,
          beforeExec: () => {
            assertLive()
            options.beforeExec?.()
          }
        })
      },
      spawnBackground: (command, options) => {
        assertLive()
        return value.exec.spawnBackground(command, {
          ...options,
          beforeExec: () => {
            assertLive()
            options.beforeExec?.()
          }
        })
      }
    }
  })
  return {
    ...workspace,
    projectHost: host(workspace.projectHost),
    runtimeHost: host(workspace.runtimeHost),
    execWithInput: (script, options) => {
      assertLive()
      return workspace.execWithInput(script, {
        ...options,
        beforeExec: () => {
          assertLive()
          options.beforeExec?.()
        }
      })
    }
  }
}

function guardOperations<T extends object>(operations: T, assertLive: () => void): T {
  return new Proxy(operations, {
    get(target, key) {
      const value = Reflect.get(target, key)
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            assertLive()
            return value.apply(target, args)
          }
        : value
    }
  })
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
