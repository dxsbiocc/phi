import type {
  KernelHostCapabilityName,
  KernelHostCapabilityParams,
  KernelHostCapabilityResult
} from '../../../../shared/kernel-protocol'
import type { DecisionRequest, DecisionResult } from '../../../../shared/decisionTypes'
import {
  executeLibraryAction,
  localLibraryStore,
  type LibraryToolAction,
  type LibraryToolExecutionResult
} from '../../library/library-tools'
import {
  readPaletteCatalog,
  suggestPalettes,
  type Palette,
  type PaletteUse
} from '../../palettes/tools'
import { getBundledPalettesDir } from '../../runtime/runtime-adapter'
import type { HostServiceRegistry } from '../host-service-registry'
import {
  KernelClientError,
  type KernelHostRequestContext,
  type KernelProtocolClient
} from '../kernel-client'

export const DESKTOP_SERVICE_HOST_CAPABILITIES = [
  'agentInteraction.request',
  'browser.execute',
  'browser.cancel',
  'deliverables.present',
  'notebookTool.execute',
  'decisions.evaluate',
  'libraryTool.execute',
  'palette.suggest',
  'memory.read',
  'memory.learn',
  'memory.ingest',
  'memory.deleteLesson',
  'memory.clear',
  'wrapperCatalog.search',
  'wrapperCatalog.inspect',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait'
] as const satisfies readonly KernelHostCapabilityName[]

export interface KernelDesktopServiceBinding {
  /** The kernel session this immutable binding belongs to. */
  readonly kernelSessionId: string
  /** Current desktop runtime identity used by the existing host-service registry. */
  readonly runtimeSessionId: string
  /** Canonical cwd on the execution host. */
  readonly cwd: string
  readonly executionHost: 'local' | 'ssh'
  readonly remoteProject?: { readonly sessionId: string; readonly projectId: string }
}

type MemoryReadResult = KernelHostCapabilityResult<'memory.read'>
type MemoryDeleteResult = KernelHostCapabilityResult<'memory.deleteLesson'>

export interface KernelDesktopMemoryService {
  read(
    binding: KernelDesktopServiceBinding,
    signal: AbortSignal
  ): Promise<MemoryReadResult> | MemoryReadResult
  learn(
    binding: KernelDesktopServiceBinding,
    input: KernelHostCapabilityParams<'memory.learn'>['input'],
    signal: AbortSignal
  ): Promise<KernelHostCapabilityResult<'memory.learn'>>
  ingest(
    binding: KernelDesktopServiceBinding,
    input: Omit<KernelHostCapabilityParams<'memory.ingest'>, 'runtimeSessionId' | 'cwd'>,
    signal: AbortSignal
  ): Promise<KernelHostCapabilityResult<'memory.ingest'>>
  deleteLesson(
    binding: KernelDesktopServiceBinding,
    input: Pick<KernelHostCapabilityParams<'memory.deleteLesson'>, 'index' | 'text'>,
    signal: AbortSignal
  ): Promise<MemoryDeleteResult>
  clear(binding: KernelDesktopServiceBinding, signal: AbortSignal): Promise<void>
}

export interface KernelDesktopServicesBrokerOptions {
  services: HostServiceRegistry
  resolveSession(
    kernelSessionId: string,
    signal: AbortSignal
  ): KernelDesktopServiceBinding | undefined | Promise<KernelDesktopServiceBinding | undefined>
  evaluateDecision(
    binding: KernelDesktopServiceBinding,
    model: KernelHostCapabilityParams<'decisions.evaluate'>['model'],
    request: DecisionRequest,
    signal: AbortSignal
  ): Promise<DecisionResult>
  executeLibrary?(
    binding: KernelDesktopServiceBinding,
    action: LibraryToolAction,
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<LibraryToolExecutionResult>
  suggestPalette?(
    binding: KernelDesktopServiceBinding,
    request: { use?: PaletteUse; id?: string; limit?: number },
    signal: AbortSignal
  ): Promise<Palette[]>
  paletteCatalogPath?: string
  memory: KernelDesktopMemoryService
}

type ServiceContext = {
  binding: KernelDesktopServiceBinding
  host: KernelHostRequestContext
  legacy: {
    signal: AbortSignal
    originSessionId: string
    agentRunId?: string
    toolCallId?: string
  }
}

function unavailable(reason: string, message: string): KernelClientError {
  return new KernelClientError({ code: 'CAPABILITY_UNAVAILABLE', message, detail: { reason } })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Desktop service request must be an object.')
  }
  return value as Record<string, unknown>
}

function assertKernelIdentity(value: unknown, expected: string, field: string): void {
  if (value !== expected) {
    throw unavailable('session_binding_mismatch', `Desktop service ${field} binding changed.`)
  }
}

async function serviceContext(
  options: KernelDesktopServicesBrokerOptions,
  context: KernelHostRequestContext,
  toolCallId?: string
): Promise<ServiceContext> {
  if (!context.sessionId) {
    throw unavailable('session_binding_required', 'Desktop service requires a kernel session.')
  }
  const binding = await options.resolveSession(context.sessionId, context.signal)
  if (!binding || binding.kernelSessionId !== context.sessionId) {
    throw unavailable('session_binding_unavailable', 'Desktop service session is unavailable.')
  }
  return {
    binding,
    host: context,
    legacy: {
      signal: context.signal,
      originSessionId: binding.runtimeSessionId,
      ...(context.agentRunId ? { agentRunId: context.agentRunId } : {}),
      ...(toolCallId ? { toolCallId } : {})
    }
  }
}

type Unregister = () => void

function registerCoreServices(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): Unregister[] {
  return [
    client.registerHostCapability('agentInteraction.request', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'interaction')
      return options.services.invoke(
        'agentInteraction.request',
        { ...params, runtimeSessionId: scope.binding.runtimeSessionId },
        scope.legacy
      ) as Promise<KernelHostCapabilityResult<'agentInteraction.request'>>
    }),
    client.registerHostCapability('browser.execute', async (params, context) => {
      const scope = await serviceContext(options, context, params.toolCallId)
      assertKernelIdentity(params.originSessionId, scope.binding.kernelSessionId, 'browser')
      return options.services.invoke(
        'browser.execute',
        { ...params, originSessionId: scope.binding.runtimeSessionId },
        scope.legacy
      ) as Promise<KernelHostCapabilityResult<'browser.execute'>>
    }),
    client.registerHostCapability('browser.cancel', async (params, context) => {
      const scope = await serviceContext(options, context, params.toolCallId)
      assertKernelIdentity(params.originSessionId, scope.binding.kernelSessionId, 'browser')
      await options.services.invoke(
        'browser.cancel',
        { ...params, originSessionId: scope.binding.runtimeSessionId },
        scope.legacy
      )
      return null
    }),
    client.registerHostCapability('deliverables.present', async (params, context) => {
      const scope = await serviceContext(options, context, params.toolCallId)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'deliverable')
      return options.services.invoke(
        'deliverables.present',
        { ...params, runtimeSessionId: scope.binding.runtimeSessionId },
        scope.legacy
      ) as Promise<KernelHostCapabilityResult<'deliverables.present'>>
    })
  ]
}

function registerNotebookAndDecision(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): Unregister[] {
  return [
    client.registerHostCapability('notebookTool.execute', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'Notebook cwd')
      if (params.remoteProject !== undefined) {
        throw unavailable(
          'untrusted_remote_project_identity',
          'Kernel Notebook requests cannot select a desktop project.'
        )
      }
      return options.services.invoke(
        'notebookTool.execute',
        {
          ...params,
          cwd: scope.binding.cwd,
          ...(scope.binding.remoteProject
            ? {
                remoteProject: {
                  runtimeSessionId: scope.binding.runtimeSessionId,
                  ...scope.binding.remoteProject
                }
              }
            : {})
        },
        scope.legacy
      ) as Promise<KernelHostCapabilityResult<'notebookTool.execute'>>
    }),
    client.registerHostCapability('decisions.evaluate', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'decision')
      return (await options.evaluateDecision(
        scope.binding,
        params.model,
        params.request,
        context.signal
      )) as KernelHostCapabilityResult<'decisions.evaluate'>
    })
  ]
}

function registerLibraryAndPalette(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): Unregister[] {
  return [
    client.registerHostCapability('libraryTool.execute', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'Library')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'Library cwd')
      const action = params.action as LibraryToolAction
      const input = object(params.params)
      if (!options.executeLibrary && scope.binding.executionHost === 'ssh') {
        throw unavailable(
          'remote_library_adapter_unavailable',
          'The remote project Library adapter is unavailable; no desktop fallback was used.'
        )
      }
      return options.executeLibrary
        ? (options.executeLibrary(scope.binding, action, input, context.signal) as Promise<
            KernelHostCapabilityResult<'libraryTool.execute'>
          >)
        : (executeLibraryAction(
            action,
            localLibraryStore({ cwd: scope.binding.cwd }),
            input
          ) as Promise<KernelHostCapabilityResult<'libraryTool.execute'>>)
    }),
    client.registerHostCapability('palette.suggest', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'palette')
      context.signal.throwIfAborted()
      const request = {
        ...(params.use ? { use: params.use } : {}),
        ...(params.id ? { id: params.id } : {}),
        ...(params.limit ? { limit: params.limit } : {})
      }
      const palettes = options.suggestPalette
        ? await options.suggestPalette(scope.binding, request, context.signal)
        : suggestPalettes(
            readPaletteCatalog(
              options.paletteCatalogPath ?? `${getBundledPalettesDir()}/palettes.yaml`
            ),
            request
          )
      context.signal.throwIfAborted()
      return { palettes }
    })
  ]
}

function registerMemoryServices(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): Unregister[] {
  return [
    client.registerHostCapability('memory.read', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'memory')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'memory cwd')
      return options.memory.read(scope.binding, context.signal)
    }),
    client.registerHostCapability('memory.learn', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'memory')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'memory cwd')
      return options.memory.learn(scope.binding, params.input, context.signal)
    }),
    client.registerHostCapability('memory.ingest', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'memory')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'memory cwd')
      assertKernelIdentity(params.source.sessionId, scope.binding.kernelSessionId, 'memory source')
      return options.memory.ingest(
        scope.binding,
        {
          runId: params.runId,
          status: params.status,
          source: params.source
        },
        context.signal
      )
    }),
    client.registerHostCapability('memory.deleteLesson', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'memory')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'memory cwd')
      return options.memory.deleteLesson(
        scope.binding,
        { index: params.index, text: params.text },
        context.signal
      )
    }),
    client.registerHostCapability('memory.clear', async (params, context) => {
      const scope = await serviceContext(options, context)
      assertKernelIdentity(params.runtimeSessionId, scope.binding.kernelSessionId, 'memory')
      assertKernelIdentity(params.cwd, scope.binding.cwd, 'memory cwd')
      await options.memory.clear(scope.binding, context.signal)
      return null
    })
  ]
}

function registerWrapperServices(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): Unregister[] {
  return [
    client.registerHostCapability('wrapperCatalog.search', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperCatalog.search', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperCatalog.search'>
      >
    }),
    client.registerHostCapability('wrapperCatalog.inspect', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperCatalog.inspect', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperCatalog.inspect'>
      >
    }),
    client.registerHostCapability('wrapperJob.start', async (params, context) => {
      const scope = await serviceContext(options, context)
      if (
        params.originSessionId !== undefined &&
        params.originSessionId !== scope.binding.kernelSessionId
      ) {
        throw unavailable('session_binding_mismatch', 'Wrapper origin binding changed.')
      }
      return options.services.invoke(
        'wrapperJob.start',
        { ...params, originSessionId: scope.binding.runtimeSessionId },
        scope.legacy
      ) as Promise<KernelHostCapabilityResult<'wrapperJob.start'>>
    }),
    client.registerHostCapability('wrapperJob.status', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperJob.status', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperJob.status'>
      >
    }),
    client.registerHostCapability('wrapperJob.list', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperJob.list', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperJob.list'>
      >
    }),
    client.registerHostCapability('wrapperJob.cancel', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperJob.cancel', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperJob.cancel'>
      >
    }),
    client.registerHostCapability('wrapperJob.wait', async (params, context) => {
      const scope = await serviceContext(options, context)
      return options.services.invoke('wrapperJob.wait', params, scope.legacy) as Promise<
        KernelHostCapabilityResult<'wrapperJob.wait'>
      >
    })
  ]
}

/**
 * Binds the unified kernel roster to the existing single desktop service owners. The resolver is
 * the authority for project/host identity; model-provided ids and cwd values are only checked
 * against that immutable binding and are never used to select another project.
 */
export function registerKernelDesktopServicesBroker(
  client: KernelProtocolClient,
  options: KernelDesktopServicesBrokerOptions
): { close(): void } {
  const remove = [
    ...registerCoreServices(client, options),
    ...registerNotebookAndDecision(client, options),
    ...registerLibraryAndPalette(client, options),
    ...registerMemoryServices(client, options),
    ...registerWrapperServices(client, options)
  ]

  return {
    close() {
      for (const unregister of remove.reverse()) unregister()
    }
  }
}
