import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeRpcCommand } from './frame-codec'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  encodeHostResult,
  validHostResultPayload
} from '../phi-extension/lib/rpc-host-result-protocol'
import { rpcIdentifier, rpcToolCallId } from './control-frame'
import { DesktopWebSearchProcess } from './desktop-websearch-process'
import {
  webSearchMetadata,
  webSearchModel,
  webSearchParams,
  webSearchPath
} from './desktop-websearch-protocol'
import {
  DESKTOP_SEARCH_CONFIGURATION_LIMITS,
  type DesktopWebSearchAdapter,
  type DesktopWebSearchOptions
} from './desktop-websearch-types'

const adapters = new WeakSet<object>()
export function isDesktopWebSearchAdapter(value: object): value is DesktopWebSearchAdapter {
  return adapters.has(value)
}
export function resolveDesktopWebSearchWorkerPath(moduleUrl = import.meta.url): string {
  const bundleDir = dirname(fileURLToPath(moduleUrl))
  const candidates = [
    join(bundleDir, 'desktop-websearch-worker.ts'),
    join(bundleDir, 'agent/engine/rpc/desktop-websearch-worker.ts'),
    join(bundleDir, 'engine/rpc/desktop-websearch-worker.ts')
  ]
  for (const candidate of candidates) {
    const unpacked = candidate.replace(/\.asar([/\\])/u, '.asar.unpacked$1')
    if (existsSync(unpacked)) return unpacked
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Desktop web search worker is missing from the application closure')
}
/** Metadata-only probes initialize no Settings/AuthStorage and exit immediately. */
export async function createDesktopWebSearchAdapter(
  options: DesktopWebSearchOptions
): Promise<DesktopWebSearchAdapter> {
  const { agentDir, resourceCwd, currentModel } = options
  const identity = Object.freeze({
    runtimeSessionId: options.identity.runtimeSessionId,
    sessionId: options.identity.sessionId,
    projectId: options.identity.projectId,
    cwd: options.identity.cwd
  })
  if (
    ![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(rpcIdentifier) ||
    !webSearchPath(identity.cwd) ||
    !webSearchPath(agentDir) ||
    !webSearchPath(resourceCwd) ||
    typeof currentModel !== 'function'
  )
    throw new Error('Desktop web search requires a trusted session and resource scope')
  const path = options.workerPath ?? resolveDesktopWebSearchWorkerPath()
  const env = {
    ...(options.env ?? process.env),
    PI_CODING_AGENT_DIR: agentDir,
    OMP_CODING_AGENT_DIR: agentDir
  }
  const retirement = new AbortController()
  const lifetime = options.signal
    ? AbortSignal.any([retirement.signal, options.signal])
    : retirement.signal
  const children = new Set<DesktopWebSearchProcess>()
  async function start(): Promise<DesktopWebSearchProcess> {
    lifetime.throwIfAborted()
    const child = await DesktopWebSearchProcess.start(path, env)
    children.add(child)
    if (lifetime.aborted) {
      await stop(child)
      lifetime.throwIfAborted()
    }
    return child
  }
  async function stop(child: DesktopWebSearchProcess): Promise<void> {
    try {
      await child.close()
    } finally {
      children.delete(child)
    }
  }
  const probe = await start()
  let metadata: unknown
  try {
    metadata = await probe.request(
      { type: 'metadata' },
      AbortSignal.any([lifetime, AbortSignal.timeout(15_000)])
    )
    await stop(probe)
  } catch (error) {
    await stop(probe).catch(() => {})
    throw error
  }
  if (!webSearchMetadata(metadata)) throw new Error('Desktop search metadata was invalid')
  const { name, label, description, parameters } = metadata
  let queued = 0
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined
  const adapter: DesktopWebSearchAdapter = {
    identity,
    configurationLimits: DESKTOP_SEARCH_CONFIGURATION_LIMITS,
    tool: Object.freeze({
      name,
      label,
      description,
      parameters,
      site: 'host',
      approval: 'read',
      strict: true,
      loadMode: 'discoverable',
      async execute(toolCallId, params, _update, context, signal) {
        if (!rpcToolCallId(toolCallId) || context.cwd !== identity.cwd || !webSearchParams(params))
          throw new Error('Invalid desktop web search invocation')
        // Serialize before reading live desktop configuration; aborting queued work has zero SDK effects.
        lifetime.throwIfAborted()
        signal?.throwIfAborted()
        if (queued >= 64) throw new Error('Desktop search queue limit exceeded')
        const input = JSON.parse(JSON.stringify(params))
        encodeRpcCommand({ type: 'search', id: randomUUID(), params: input })
        queued++
        const operation = tail.then(async () => {
          const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime
          combined.throwIfAborted()
          const selectedModel = currentModel()
          if (selectedModel !== undefined && !webSearchModel(selectedModel))
            throw new Error('Invalid trusted desktop search model')
          const model = selectedModel ? { ...selectedModel } : undefined
          encodeRpcCommand({
            type: 'search',
            id: randomUUID(),
            params: input,
            ...(model ? { model } : {})
          })
          const child = await start()
          try {
            combined.throwIfAborted()
            await child.request(
              {
                type: 'init',
                agentDir: agentDir,
                resourceCwd: resourceCwd,
                sessionId: identity.runtimeSessionId
              },
              AbortSignal.any([combined, AbortSignal.timeout(15_000)])
            )
            const result = await child.request(
              { type: 'search', params: input, ...(model ? { model } : {}) },
              combined
            )
            combined.throwIfAborted()
            if (!validHostResultPayload(result)) throw new Error('Invalid desktop search result')
            encodeHostResult(result)
            await stop(child)
            return result
          } catch (error) {
            // Keep the original query/cancellation failure if secondary cleanup also fails.
            await stop(child).catch(() => {})
            throw error
          }
        })
        const drained = operation.finally(() => {
          queued--
        })
        tail = drained.then(
          () => {},
          () => {}
        )
        // A queued cancellation is observable immediately, while its serial slot still drains in order.
        return await cancelled(drained, signal ? AbortSignal.any([lifetime, signal]) : lifetime)
      }
    }),
    retire(reason = new Error('Desktop web search adapter retired')) {
      if (!lifetime.aborted) retirement.abort(reason)
    },
    close() {
      if (!lifetime.aborted) retirement.abort(new Error('Desktop web search adapter closed'))
      return (closing ??= (async () => {
        await tail
        await Promise.all([...children].map(stop))
      })())
    }
  }
  adapters.add(adapter)
  return Object.freeze(adapter)
}
function cancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
