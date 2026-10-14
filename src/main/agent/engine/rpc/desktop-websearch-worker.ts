/** Owned desktop Bun entry. No ToolSession or ExtensionHost is constructed. */
import { once } from 'node:events'
import { Settings, ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import {
  runSearchQuery,
  webSearchCustomTool,
  webSearchSchema
} from '@oh-my-pi/pi-coding-agent/web/search'
import { RpcFrameEncoder } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame'
import { toolWireSchema } from '@oh-my-pi/pi-ai/utils/schema'
import { logger, postmortem, setProjectDir } from '@oh-my-pi/pi-utils'
import type { AuthStorage } from '@oh-my-pi/pi-ai'
import { createPhiSettings } from '../in-process/settings'
import { createPhiAuth } from '../in-process/auth'
import { encodeHostResult } from '../phi-extension/lib/rpc-host-result-protocol'
import { RpcFrameCodec } from './frame-codec'
import { rpcIdentifier } from './control-frame'
import { webSearchModel, webSearchParams, webSearchPath } from './desktop-websearch-protocol'
import {
  prepareDesktopWebSearchCapability,
  DesktopWebSearchCapabilityError,
  type DesktopWebSearchCapability
} from './desktop-websearch-capability'

logger.setTransports({ file: false, console: false })
delete process.env.PI_REQ_DEBUG
delete process.env.OMP_REQ_DEBUG
const privateDirectory = process.cwd()
const encoder = new RpcFrameEncoder()
encoder.setProtocolVersion(2)
let output = Promise.resolve()
function send(frame: object): Promise<void> {
  output = output.then(async () => {
    for (const line of encoder.encodeFrames(frame)) {
      if (!process.stdout.write(line)) await once(process.stdout, 'drain')
    }
  })
  return output
}
let settings: Settings | undefined
let auth: AuthStorage | undefined
let models: ModelRegistry | undefined
let capability: DesktopWebSearchCapability | undefined
let sessionId: string | undefined
let retiring = false
let tail = Promise.resolve()
const active = new Map<string, AbortController>()
const secrets = new Set<string>()
function remember(value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    // Providers can echo raw JSON bodies after HTTP normalizes a known header/key.
    for (const known of [value, value.trim()]) {
      if (!known) continue
      secrets.add(known)
      secrets.add(JSON.stringify(known).slice(1, -1))
    }
  }
}
function snapshotSecrets(): void {
  for (const [key, value] of Object.entries(process.env))
    if (/KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION/i.test(key)) remember(value)
  const providers = auth
    ? new Set(
        createPhiAuth(auth)
          .listCredentials()
          .map((entry) => entry.providerId)
      )
    : []
  for (const provider of providers)
    for (const entry of auth!.credentials.list(provider)) {
      if (entry.credential.type === 'api_key') remember(entry.credential.key)
      else {
        remember(entry.credential.access)
        remember(entry.credential.refresh)
      }
    }
  if (settings) {
    const values = createPhiSettings(settings).webSearch.readSearxngCredentials()
    remember(values.token)
    remember(values.basicUsername)
    remember(values.basicPassword)
    if (typeof values.basicUsername === 'string' && typeof values.basicPassword === 'string')
      remember(Buffer.from(`${values.basicUsername}:${values.basicPassword}`).toString('base64'))
  }
}
function redact(value: string): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    value = value.split(secret).join('[redacted]')
  return value
}
async function dispatch(frame: Record<string, unknown>): Promise<void> {
  const id = frame.id
  if (!rpcIdentifier(id)) throw new Error('Invalid desktop search request identity')
  if (frame.type === 'metadata') {
    await send({
      type: 'reply',
      id,
      value: {
        name: webSearchCustomTool.name,
        label: webSearchCustomTool.label,
        description: webSearchCustomTool.description,
        parameters: toolWireSchema(webSearchCustomTool)
      }
    })
    return
  }
  if (frame.type === 'cancel') {
    active.get(id)?.abort(new Error('Desktop search cancelled'))
    return
  }
  if (frame.type === 'close') {
    void close()
    return
  }
  if (retiring) throw new Error('Desktop search worker retired')
  if (frame.type === 'init') {
    if (
      settings ||
      !webSearchPath(frame.agentDir) ||
      !webSearchPath(frame.resourceCwd) ||
      !rpcIdentifier(frame.sessionId)
    )
      throw new Error('Invalid desktop search initialization')
    // Static SDK imports saw the private launch cwd; selected project .env is not injected.
    // Native resource/settings lookup and browser providers use the trusted desktop anchor.
    // Command-backed credentials/headers are rejected before execution.
    setProjectDir(frame.resourceCwd)
    settings = await Settings.init({ cwd: frame.resourceCwd, agentDir: frame.agentDir })
    settings.stopWatching() // Each fresh query process uses one stable configuration snapshot.
    capability = await prepareDesktopWebSearchCapability({
      settings,
      agentDir: frame.agentDir,
      resourceCwd: frame.resourceCwd,
      privateDirectory,
      onUnsupported(error) {
        for (const controller of active.values()) controller.abort(error)
      }
    })
    auth = capability.auth
    models = new ModelRegistry(auth, capability.modelsPath, {
      settings,
      cacheDbPath: capability.cacheDbPath
    })
    capability.installResolver()
    capability.assertCredentials()
    const resolveHeaders = models.resolveModelHeaders.bind(models)
    models.resolveModelHeaders = async (...args) => {
      const values = await resolveHeaders(...args)
      for (const value of Object.values(values ?? {})) remember(value)
      // Match the standard Headers normalization used by native grounded providers.
      for (const value of new Headers(values).values()) remember(value)
      return values
    }
    // Observe genuine resolved literal/environment keys without selecting,
    // retrying or replacing any SDK credential. The original resolver returns unchanged.
    const getKey = auth.keys.get.bind(auth.keys)
    auth.keys.get = async (...args) => {
      const value = await getKey(...args)
      remember(value)
      return value
    }
    const getCredential = auth.keys.getWithCredential.bind(auth.keys)
    auth.keys.getWithCredential = async (...args) => {
      const value = await getCredential(...args)
      remember(value?.apiKey)
      return value
    }
    const peekKey = auth.keys.peek.bind(auth.keys)
    auth.keys.peek = async (...args) => {
      const value = await peekKey(...args)
      remember(value)
      return value
    }
    const resolveKey = auth.keys.resolver.bind(auth.keys)
    auth.keys.resolver = (...args) => {
      const resolver = resolveKey(...args)
      return async (context) => {
        const value = await resolver(context)
        remember(typeof value === 'string' ? value : value?.apiKey)
        return value
      }
    }
    sessionId = frame.sessionId
    snapshotSecrets()
    await send({ type: 'reply', id, value: true })
    return
  }
  if (
    frame.type !== 'search' ||
    !settings ||
    !auth ||
    !models ||
    !webSearchParams(frame.params) ||
    (frame.model !== undefined && !webSearchModel(frame.model)) ||
    active.has(id) ||
    active.size >= 64
  )
    throw new Error('Invalid desktop search command')
  const controller = new AbortController()
  active.set(id, controller)
  const params = frame.params
  const model = frame.model
  tail = tail.then(async () => {
    try {
      controller.signal.throwIfAborted()
      await auth!.credentials.revalidate()
      capability!.assertCredentials()
      await models!.refresh('offline')
      await models!.hydrateCredentialScopedModelCaches()
      snapshotSecrets()
      const sessionModel = model ? models!.find(model.provider, model.id) : undefined
      if (model && !sessionModel) throw new Error('Selected desktop search model is unavailable')
      controller.signal.throwIfAborted()
      const parsed = webSearchSchema.assert(params)
      const result = await runSearchQuery(parsed, {
        authStorage: auth!,
        modelRegistry: models!,
        sessionId,
        sessionModel,
        signal: controller.signal
      })
      controller.signal.throwIfAborted()
      snapshotSecrets()
      // SDK results have optional undefined properties; JSON transport omits those normally.
      const plain = JSON.parse(JSON.stringify(result))
      if (typeof result.details.error === 'string') {
        plain.details.error = redact(plain.details.error)
        for (const part of plain.content) if (part.type === 'text') part.text = redact(part.text)
      }
      encodeHostResult(plain)
      await send({ type: 'reply', id, value: plain })
    } catch (error) {
      snapshotSecrets()
      const failure =
        controller.signal.reason instanceof DesktopWebSearchCapabilityError
          ? controller.signal.reason
          : error
      await send({
        type: 'reply',
        id,
        error: redact(failure instanceof Error ? failure.message : String(failure))
      })
    } finally {
      active.delete(id)
    }
  })
}
async function close(): Promise<void> {
  if (retiring) return
  retiring = true
  for (const controller of active.values())
    controller.abort(new Error('Desktop search worker closed'))
  await tail
  settings?.cancelPendingSaves()
  auth?.close() // Session affinity remains in the genuine SDK store across idle restarts.
  await output
  await postmortem.quit(0)
}
const codec = new RpcFrameCodec()
let input = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const frame of codec.push(chunk)) {
      input = input
        .then(() => dispatch(frame))
        .catch(async (error) => {
          // Protocol/setup failures never expose configuration, paths or credential-bearing errors.
          if (rpcIdentifier(frame.id))
            await send({
              type: 'reply',
              id: frame.id,
              error:
                error instanceof DesktopWebSearchCapabilityError
                  ? error.message
                  : 'Desktop search initialization or protocol failed'
            })
          else void close()
        })
    }
  } catch {
    void close()
  }
})
process.stdin.on('end', () => {
  void input.finally(close)
})
process.stdin.on('error', () => {
  void close()
})
