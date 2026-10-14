import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { BrowserOutcome } from '../../../../shared/browserTypes'
import type { PresentedFile } from '../../../../shared/presentedFileTypes'
import { buildBrowserTool } from '../../browser/browser-tool'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { buildEnvRequestTool } from '../../content/env-request-tool'
import { buildScriptTools, buildSkillRunTool } from '../../content/skill-tools'
import type { ScriptToolDescriptor } from '../../content/skill-tool-types'
import { buildRemotePresentFilesTool } from '../../deliverables/remote-present-tool'
import { buildRenderBlocksTool } from '../../deliverables/render-blocks-tool'
import {
  buildRemoteProjectDownloadTool,
  type RemoteDownloadBackend
} from '../../download/remote-project-download-tool'
import { buildNotebookCustomTools } from '../../notebook/notebook-tools'
import {
  JupyterKernelExecutionStoppedError,
  JupyterKernelExecutionUnconfirmedError
} from '../../notebook/analysis-jupyter-execution'
import { buildPaletteRecommendationTool } from '../../palettes/tools'
import { buildAskUserQuestionCustomTools } from '../../user-interaction-tools'
import { buildLibraryCustomTools } from '../../library/library-tools'
import { createHostJobClient } from '../../wrappers/composition/job-host-client'
import { WRAPPER_JOB_HOST_METHODS } from '../../wrappers/composition/job-types'
import { buildWrapperCompositionTools } from '../../wrappers/composition/tools'
import { HostServiceRegistry } from '../host-service-registry'
import type { PhiHostRequestContext, PhiTool, PhiToolImage, PhiToolApproval } from '../types'
import { rpcIdentifier } from './control-frame'
import { remoteLibraryToolStore } from './remote-library-service'
import { isDesktopWebSearchAdapter } from './desktop-websearch-adapter'
import type { DesktopWebSearchAdapter } from './desktop-websearch-types'
import { isDesktopMcpAdapter } from './desktop-mcp-adapter'
import type { DesktopMcpAdapter } from './desktop-mcp-types'

export interface RpcDesktopToolIdentity {
  readonly runtimeSessionId: string
  readonly sessionId: string
  readonly projectId: string
  /** Canonical server project cwd, never a desktop project anchor. */
  readonly cwd: string
}
export interface RpcDesktopToolRun {
  readonly id: string
  readonly signal: AbortSignal
  /** Only set for an independently verified Phi child run. Main runs omit it. */
  readonly agentRunId?: string
}
export interface RpcDesktopToolScopeOptions {
  readonly identity: RpcDesktopToolIdentity
  /** The exact registry populated by engine.host.register in the desktop main process. */
  readonly services: HostServiceRegistry
  readonly currentRun: () => RpcDesktopToolRun | undefined
  readonly assertBinding?: () => void
  readonly recentUserImages: () => PhiToolImage[]
  readonly allowBrowserTypeText: () => boolean
  /** Shared with the real pre-dispatch redaction owner; raw text is never accepted here. */
  readonly browserTextVault: BrowserTextVault
  /** Desktop-owned resource catalog, separate from the server execution cwd. */
  readonly agentDir: string
  readonly catalogProjectDir?: string
  readonly paletteCatalogPath?: string
  readonly allowedSkills: readonly string[]
  readonly skillCatalog?: readonly { readonly name: string; readonly description: string }[]
  readonly scriptTools: readonly ScriptToolDescriptor[]
  /** Enable after the genuine selected-workspace library.execute/cancel service is registered. */
  readonly remoteLibrary?: true
  /** A genuine separately owned desktop SDK adapter; owner awaits close on teardown. */
  readonly desktopWebSearch?: DesktopWebSearchAdapter
  readonly desktopMcp?: DesktopMcpAdapter
  /** The actual RemoteRuntimeController.approvalFor; required when script tools are enabled. */
  readonly scriptApprovalFor?: (toolName: string, input: unknown) => PhiToolApproval | undefined
}
export interface RpcDesktopToolScope {
  readonly identity: Readonly<RpcDesktopToolIdentity>
  readonly tools: readonly PhiTool[]
  /** Explicit missing adapters; the caller must retain these in its readiness reporting. */
  readonly unavailable: readonly { capability: string; reason: string }[]
  recentUserImages(): PhiToolImage[]
  /** Inject into the runtime's host policy so declared read scripts can be promoted live. */
  approvalFor(
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ): PhiToolApproval | undefined
  dispose(): void
  /** Captures only these genuine run objects; a late stop cannot drain a successor. */
  captureNotebookExecutionDrain(runId?: string): () => Promise<void>
}
interface Call {
  readonly run: RpcDesktopToolRun
  readonly runId: string
  readonly runSignal: AbortSignal
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly context: PhiHostRequestContext
}
const CANCELLATIONS = new Set([
  'browser.cancel',
  'skills.cancel',
  'environments.cancel',
  'remoteWorkspace.cancelDownload',
  'library.cancel'
])
const coordinatedTools = new WeakSet<PhiTool>()

/** A name or caller-supplied metadata flag cannot claim an existing coordinator's own UI gate. */
export function isRpcDesktopCoordinatedTool(tool: PhiTool): boolean {
  return coordinatedTools.has(tool)
}
const UNAVAILABLE = Object.freeze([
  {
    capability: 'library',
    reason:
      'Existing library-store writes the local project filesystem; a remote-aware store is required.'
  },
  {
    capability: 'websearch/MCP',
    reason:
      'Requires real session-private resource/auth adapters and their lifecycle; no fabricated SDK session is supported.'
  },
  {
    capability: 'agent delegation',
    reason: 'Requires the separately verified native child-session and Phi run binding from R6.'
  }
])

/** Curated real Phi builders. The RPC bridge owns input validation and complete result delivery. */
export function createRpcDesktopToolScope(
  options: RpcDesktopToolScopeOptions
): RpcDesktopToolScope {
  const identity = Object.freeze({
    runtimeSessionId: options.identity.runtimeSessionId,
    sessionId: options.identity.sessionId,
    projectId: options.identity.projectId,
    cwd: options.identity.cwd
  })
  if (
    ![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(rpcIdentifier) ||
    !canonicalCwd(identity.cwd) ||
    !options.agentDir.startsWith('/') ||
    (options.catalogProjectDir !== undefined && !options.catalogProjectDir.startsWith('/'))
  )
    throw new Error('Desktop tools require a trusted canonical remote project scope')
  const webSearch = options.desktopWebSearch
  const mcp = options.desktopMcp
  if (
    webSearch &&
    (!isDesktopWebSearchAdapter(webSearch) ||
      Object.entries(identity).some(
        ([key, value]) => webSearch.identity[key as keyof RpcDesktopToolIdentity] !== value
      ))
  )
    throw new Error('Desktop search adapter belongs to a different trusted session')
  if (
    mcp &&
    (!isDesktopMcpAdapter(mcp) ||
      Object.entries(identity).some(
        ([key, value]) => mcp.identity[key as keyof RpcDesktopToolIdentity] !== value
      ))
  )
    throw new Error('Desktop MCP adapter belongs to a different trusted session')
  const lifetime = new AbortController()
  const calls = new AsyncLocalStorage<Call>()
  const active = new Set<AbortController>()
  const notebookExecutions = new Map<RpcDesktopToolRun, Set<Promise<void>>>()
  const currentRun = options.currentRun
  const services = options.services
  const vault = options.browserTextVault
  const remoteProject = Object.freeze({
    sessionId: identity.sessionId,
    projectId: identity.projectId
  })
  const skills = Object.freeze([...options.allowedSkills])
  const descriptors = structuredClone(options.scriptTools).filter(
    (descriptor) => descriptor.attachTo.includes('main') && skills.includes(descriptor.skill)
  )
  const scriptNames = new Set(descriptors.map((descriptor) => descriptor.name))
  const scriptApprovalFor = options.scriptApprovalFor
  if (scriptNames.size && !scriptApprovalFor)
    throw new Error('Remote script tools require their live approval classifier')

  function live(call: Call): void {
    options.assertBinding?.()
    lifetime.signal.throwIfAborted()
    call.signal.throwIfAborted()
    call.runSignal.throwIfAborted()
    if (
      currentRun() !== call.run ||
      call.run.id !== call.runId ||
      call.run.signal !== call.runSignal
    )
      throw new Error('Desktop tool run binding changed')
  }
  function requestFor(
    methods: readonly string[]
  ): (method: string, params: unknown) => Promise<unknown> {
    const permitted = new Set(methods)
    return async (method, params) => {
      const call = calls.getStore()
      if (!call || !permitted.has(method)) throw new Error('Unregistered desktop tool service')
      // Cancellation remains bound to the original request even after its run is retired.
      if (!CANCELLATIONS.has(method)) live(call)
      if (
        method === WRAPPER_JOB_HOST_METHODS.start &&
        typeof params === 'object' &&
        params !== null &&
        'target' in params &&
        params.target === 'local'
      ) {
        throw new Error('An SSH project cannot run a wrapper on the desktop')
      }
      const operation = services.invoke(
        method,
        params,
        method.startsWith('browser.') ? call.context : { ...call.context, signal: call.signal }
      )
      if (
        method === 'notebookTool.execute' &&
        params &&
        typeof params === 'object' &&
        'action' in params &&
        params.action === 'run_cell'
      ) {
        const owned = notebookExecutions.get(call.run) ?? new Set<Promise<void>>()
        notebookExecutions.set(call.run, owned)
        const settled = operation.then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof JupyterKernelExecutionStoppedError) return
            if (error instanceof JupyterKernelExecutionUnconfirmedError || call.signal.aborted)
              throw error
          }
        )
        owned.add(settled)
        void settled.catch(() => undefined)
      }
      return operation
    }
  }
  const browserRequest = requestFor(['browser.execute', 'browser.cancel'])
  const interactionRequest = requestFor(['agentInteraction.request'])
  const notebookRequest = requestFor(['notebookTool.execute'])
  const presentRequest = requestFor(['deliverables.present'])
  const downloadRequest = requestFor(['remoteWorkspace.download', 'remoteWorkspace.cancelDownload'])
  const skillRequest = requestFor(['skills.run', 'skills.scriptTool', 'skills.cancel'])
  const environmentRequest = requestFor(['environments.request', 'environments.cancel'])
  const wrapperRequest = requestFor(Object.values(WRAPPER_JOB_HOST_METHODS))
  const libraryRequest = requestFor(['library.execute', 'library.cancel'])
  const download: RemoteDownloadBackend = async (request, signal) => {
    signal?.throwIfAborted()
    const requestId = randomUUID()
    const binding = { ...remoteProject, requestId }
    const cancel = (): void => {
      void downloadRequest('remoteWorkspace.cancelDownload', binding).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return (await downloadRequest('remoteWorkspace.download', {
        ...request,
        ...binding
      })) as Awaited<ReturnType<RemoteDownloadBackend>>
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  const skillTool = buildSkillRunTool(skillRequest, {
    runtimeSessionId: identity.runtimeSessionId,
    allowedSkills: skills,
    remoteProject
  })
  skillTool.description +=
    '\nEnabled skills: ' +
    skills
      .map((name) => {
        const description = options.skillCatalog?.find((skill) => skill.name === name)?.description
        return description ? `${name}: ${description}` : name
      })
      .join('; ')
  const skillProperties = skillTool.parameters.properties as Record<string, unknown>
  skillTool.parameters = {
    ...skillTool.parameters,
    properties: {
      ...skillProperties,
      skill: { ...(skillProperties.skill as Record<string, unknown>), enum: skills }
    }
  }
  const built = [
    buildBrowserTool(
      identity.runtimeSessionId,
      async (request) => (await browserRequest('browser.execute', request)) as BrowserOutcome,
      {
        cancelHost: (request) => browserRequest('browser.cancel', request),
        takeText: (id, placeholder) => vault.take(id, placeholder),
        allowTypeText: options.allowBrowserTypeText
      }
    ),
    ...buildAskUserQuestionCustomTools(identity.runtimeSessionId, (request) =>
      interactionRequest('agentInteraction.request', request)
    ),
    buildRenderBlocksTool(),
    ...(webSearch ? [webSearch.tool] : []),
    ...(mcp ? mcp.tools : []),
    ...(options.remoteLibrary
      ? buildLibraryCustomTools(
          remoteLibraryToolStore(libraryRequest, identity, () => {
            const call = calls.getStore()
            if (!call) throw new Error('Library call has no trusted tool identity')
            return call.toolCallId
          })
        )
      : []),
    buildPaletteRecommendationTool(options.paletteCatalogPath),
    ...buildNotebookCustomTools((request) => notebookRequest('notebookTool.execute', request), {
      remoteProject: { runtimeSessionId: identity.runtimeSessionId, ...remoteProject }
    }),
    buildRemotePresentFilesTool(
      identity.runtimeSessionId,
      async (request) =>
        (await presentRequest('deliverables.present', request)) as { files: PresentedFile[] }
    ),
    buildRemoteProjectDownloadTool(download),
    ...(skills.length ? [skillTool] : []),
    ...buildScriptTools(descriptors, skillRequest, {
      runtimeSessionId: identity.runtimeSessionId,
      remoteProject
    }),
    buildEnvRequestTool(environmentRequest, {
      runtimeSessionId: identity.runtimeSessionId,
      requireEnvironment: true,
      remoteProject
    }),
    ...buildWrapperCompositionTools(
      createHostJobClient(wrapperRequest, { originSessionId: identity.runtimeSessionId }),
      {
        agentDir: options.agentDir,
        ...(options.catalogProjectDir ? { projectDir: options.catalogProjectDir } : {})
      }
    )
  ]
  const names = new Set<string>()
  const tools = Object.freeze(
    built.map((tool): PhiTool => {
      if (names.has(tool.name)) throw new Error(`Duplicate desktop tool: ${tool.name}`)
      names.add(tool.name)
      const wrapped: PhiTool = {
        ...tool,
        async execute(toolCallId, params, update, context, signal) {
          const run = currentRun()
          if (
            !run ||
            !rpcIdentifier(run.id) ||
            !rpcIdentifier(toolCallId) ||
            context.cwd !== identity.cwd
          ) {
            throw new Error('Desktop tool call has no trusted active remote run')
          }
          const controller = new AbortController()
          const call: Call = {
            run,
            runId: run.id,
            runSignal: run.signal,
            toolCallId,
            signal: controller.signal,
            context: Object.freeze({
              originSessionId: identity.runtimeSessionId,
              toolCallId,
              ...(run.agentRunId ? { agentRunId: run.agentRunId } : {})
            })
          }
          const signals = [lifetime.signal, run.signal, ...(signal ? [signal] : [])]
          const abort = (): void => {
            // Existing builders send cancellation synchronously from their abort listener.
            calls.run(call, () => controller.abort(signals.find((item) => item.aborted)?.reason))
          }
          for (const item of signals) item.addEventListener('abort', abort, { once: true })
          if (signals.some((item) => item.aborted)) abort()
          active.add(controller)
          try {
            live(call)
            const images = recentImages()
            const trustedContext = {
              cwd: identity.cwd,
              recentUserImages: () => images.map((image) => ({ ...image }))
            }
            if (tool.name === 'browser') vault.watchAbort(toolCallId, controller.signal)
            return await calls.run(call, async () => {
              const operation = tool.execute(
                toolCallId,
                params,
                update
                  ? (partial) => {
                      live(call)
                      update(partial)
                    }
                  : undefined,
                trustedContext,
                controller.signal
              )
              const result =
                tool.name === 'notebook.run_cell'
                  ? await operation
                  : await untilAborted(operation, controller.signal)
              live(call)
              // The legacy questionnaire builder encodes UI failures only in details.
              // Preserve those details while making a failed desktop surface explicit on RPC.
              if (
                tool.name === 'ask_user_question' &&
                result.details &&
                typeof result.details === 'object' &&
                'error' in result.details &&
                typeof result.details.error === 'string'
              )
                return { ...result, isError: true }
              return result
            })
          } finally {
            active.delete(controller)
            for (const item of signals) item.removeEventListener('abort', abort)
          }
        }
      }
      Object.freeze(wrapped)
      if (tool.name === 'browser' || tool.name === 'env_request') coordinatedTools.add(wrapped)
      return wrapped
    })
  )
  return {
    identity,
    tools,
    unavailable: UNAVAILABLE.flatMap((item) => {
      if (options.remoteLibrary && item.capability === 'library') return []
      if ((webSearch || mcp) && item.capability === 'websearch/MCP')
        return [
          ...(!mcp
            ? [
                {
                  capability: 'MCP',
                  reason: 'No enabled session-private MCP adapter was selected.'
                }
              ]
            : []),
          ...(!webSearch
            ? [
                {
                  capability: 'websearch',
                  reason: 'No session-private desktop search adapter was selected.'
                }
              ]
            : [])
        ]
      return [item]
    }).concat(
      webSearch
        ? [
            {
              capability: 'websearch command-backed configuration',
              reason:
                'Command-backed credentials and model headers are rejected before execution; their helper ownership is unsupported.'
            },
            {
              capability: 'websearch cached discovery',
              reason:
                'Search uses a private query catalog cache; previously cached discovery-only models are unsupported.'
            }
          ]
        : []
    ),
    recentUserImages: recentImages,
    captureNotebookExecutionDrain(runId) {
      const captured = [...notebookExecutions].filter(
        ([run]) => runId === undefined || run.id === runId
      )
      let draining: Promise<void> | undefined
      return () =>
        (draining ??= (async () => {
          const results = await Promise.allSettled(captured.flatMap(([, owned]) => [...owned]))
          for (const [run, owned] of captured)
            if (notebookExecutions.get(run) === owned) notebookExecutions.delete(run)
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
          )
          if (failure) throw failure.reason
        })())
    },
    approvalFor(toolName, input) {
      if (lifetime.signal.aborted) return undefined
      const tool = tools.find((item) => item.name === toolName)
      if (!tool) return undefined
      if (scriptNames.has(toolName))
        return scriptApprovalFor?.(toolName, {
          ...input,
          runtimeSessionId: identity.runtimeSessionId
        })
      if (mcp?.tools.some((item) => item.name === toolName)) return mcp.approvalFor(toolName, input)
      return tool.approval
    },
    dispose() {
      if (lifetime.signal.aborted) return
      lifetime.abort(new Error('Desktop tool scope disposed'))
      webSearch?.retire(lifetime.signal.reason)
      mcp?.retire(lifetime.signal.reason)
      for (const controller of active) controller.abort(lifetime.signal.reason)
      vault.clear()
    }
  }
  function recentImages(): PhiToolImage[] {
    if (lifetime.signal.aborted) return []
    return options
      .recentUserImages()
      .filter(
        (image) =>
          image.type === 'image' &&
          image.data &&
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType)
      )
      .slice(0, 5)
      .map((image) => ({ ...image }))
  }
}

function canonicalCwd(cwd: string): boolean {
  return (
    typeof cwd === 'string' &&
    cwd.startsWith('/') &&
    !/[\0\r\n]/.test(cwd) &&
    posix.normalize(cwd) === cwd
  )
}
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
