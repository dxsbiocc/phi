import type { PhiAgentDefinition } from '../../agents/definition'
import type { PhiToolApproval, PhiToolResult, PhiToolUpdate } from '../types'
import type { RpcChildCall } from '../phi-extension/lib/rpc-child-protocol'
import type { RpcDesktopToolRun, RpcDesktopToolScope } from './desktop-tool-scope'
import { registeredHostTools, type RegisteredHostTool } from './host-tool-validation'
import type { RpcChildRun } from './subagents/run-registry'
import type { RpcAgentResourceCatalogInput } from './subagents/types'

interface ChildScope {
  readonly run: RpcChildRun
  readonly scope: RpcDesktopToolScope
  readonly tools: Map<string, RegisteredHostTool>
}
const rank = { read: 0, write: 1, exec: 2 } as const

/** Genuine desktop builders, with a distinct stable authority for every native child. */
export class FacadeChildToolScopes {
  readonly hostTools: RpcAgentResourceCatalogInput['hostTools']
  private readonly children = new Map<string, ChildScope>()
  private readonly definitions: ReadonlyMap<string, PhiAgentDefinition>
  constructor(
    private readonly options: {
      readonly definitions: readonly PhiAgentDefinition[]
      readonly current: (id: string) => RpcChildRun | undefined
      readonly name: (run: RpcChildRun) => string
      readonly createScope: (
        currentRun: () => RpcDesktopToolRun | undefined,
        owner: string,
        skills: readonly string[],
        childId?: string
      ) => RpcDesktopToolScope
    }
  ) {
    this.definitions = new Map(
      options.definitions.map((definition) => [definition.name, definition])
    )
    const skills = [...new Set(options.definitions.flatMap((definition) => definition.skills))]
    const catalog = new Map<string, RpcAgentResourceCatalogInput['hostTools'][number]>()
    for (const definition of options.definitions) {
      const scope = options.createScope(() => undefined, definition.name, skills)
      try {
        for (const tool of scope.tools.filter((tool) => definition.tools.includes(tool.name))) {
          const resource = {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
          const previous = catalog.get(tool.name)
          if (previous && JSON.stringify(previous) !== JSON.stringify(resource))
            throw new Error('Child host tool schemas conflict in this generation')
          catalog.set(tool.name, structuredClone(resource))
        }
      } finally {
        scope.dispose()
      }
    }
    this.hostTools = Object.freeze([...catalog.values()])
  }
  private owned(run: RpcChildRun): ChildScope {
    if (run.signal.aborted || this.options.current(run.id) !== run)
      throw new Error('Child host execution authority is unavailable')
    const existing = this.children.get(run.id)
    if (existing) {
      if (existing.run !== run) throw new Error('Child host scope was replaced')
      return existing
    }
    const definition = this.definitions.get(this.options.name(run))
    if (!definition) throw new Error('Child host profile is not a trusted Phi definition')
    const actor = Object.freeze({ id: run.id, agentRunId: run.id, signal: run.signal })
    const scope = this.options.createScope(
      () => (this.options.current(run.id) === run && !run.signal.aborted ? actor : undefined),
      definition.name,
      definition.skills,
      run.id
    )
    const tools = registeredHostTools(
      scope.tools.filter((tool) => definition.tools.includes(tool.name))
    )
    const owned = { run, scope, tools }
    this.children.set(run.id, owned)
    return owned
  }
  classify(run: RpcChildRun, call: RpcChildCall): PhiToolApproval | undefined {
    const owned = this.owned(run)
    const tool = owned.tools.get(call.toolName)
    if (!run.profile.tools.includes(call.toolName) || !tool || !tool.validate(call.input))
      return undefined
    const dynamic = owned.scope.approvalFor(call.toolName, call.input)
    const declared = tool.tool.approval
    if (dynamic && (!declared || rank[dynamic] > rank[declared])) return dynamic
    return declared
  }
  async execute(
    run: RpcChildRun,
    call: RpcChildCall,
    signal: AbortSignal,
    onUpdate?: PhiToolUpdate
  ): Promise<PhiToolResult> {
    const owned = this.owned(run)
    const tool = owned.tools.get(call.toolName)
    if (!run.profile.tools.includes(call.toolName) || !tool || !tool.validate(call.input))
      throw new Error('Child host tool input was refused')
    const result = await tool.tool.execute(
      call.toolCallId,
      structuredClone(call.input),
      onUpdate,
      {
        cwd: run.scope.cwd,
        recentUserImages: owned.scope.recentUserImages
      },
      AbortSignal.any([signal, run.signal])
    )
    if (this.options.current(run.id) !== run || run.signal.aborted)
      throw new Error('Child host tool authority changed before delivery')
    return result
  }
  async drain(id?: string): Promise<void> {
    const scopes = [...this.children].filter(([key]) => id === undefined || id === key)
    const drains = scopes.map(([, owned]) => owned.scope.captureNotebookExecutionDrain())
    for (const [, owned] of scopes) owned.scope.dispose()
    const results = await Promise.allSettled(drains.map((drain) => drain()))
    for (const [key] of scopes) this.children.delete(key)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}

/** Public jobs never expose native journal paths or capabilities. */
export function childJobView(
  run: import('./subagents/types').RpcChildRunSnapshot
): Record<string, unknown> {
  return {
    agentRunId: run.id,
    agentName: run.agent,
    task: '',
    state:
      run.status === 'completed'
        ? 'done'
        : run.status === 'aborted'
          ? 'cancelled'
          : run.status === 'failed' || run.status === 'interrupted'
            ? 'error'
            : run.status,
    background: run.background,
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    toolCallId: run.parentToolCallId,
    canControl: run.verified && run.completedAt === undefined,
    historyAvailable: false
  }
}
