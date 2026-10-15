import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ModelReply } from '../engine-contract/loopback-model'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rpcSessionSelectionOracle, type SelectionState } from './rpcSessionSelectionOracle'

export interface CompactionState extends SelectionState {
  isCompacting: boolean
  isSettled: boolean
  contextUsage?: { tokens: number; contextWindow: number; percent: number }
}

export interface CompactionResult {
  summary: string
  shortSummary?: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
}

export interface CompactionObservation {
  type: string
  [key: string]: unknown
}

type SelectionOracle = Awaited<ReturnType<typeof rpcSessionSelectionOracle>>
export interface CompactionOracle {
  readonly selection: SelectionOracle
  readonly requests: Array<{ summary: boolean; optionKeys: string[] }>
  readonly frames: SelectionOracle['frames']
  readonly connection: SelectionOracle['connection']
  enqueue(...replies: ModelReply[]): void
  summary(reply: ModelReply): void
  holdSummaries(): () => void
  extensionCompact(): ReturnType<SelectionOracle['connection']['prompt']>
  state(): Promise<CompactionState>
  messages: SelectionOracle['messages']
  journal: SelectionOracle['journal']
  compact(customInstructions?: string): Promise<CompactionResult>
  policy(percent?: 70 | 80 | 90): Promise<CompactionObservation>
  observations(): Promise<CompactionObservation[]>
  reopen: SelectionOracle['reopen']
  close(): Promise<void>
}

/** Reuses the real SDK gateway and CLI; only the private trusted observer extension differs. */
export async function rpcSessionCompactionOracle(): Promise<CompactionOracle> {
  const selection = await rpcSessionSelectionOracle()
  const observationPath = join(selection.base.root, 'compaction-observations.jsonl')
  let proxy: Server | undefined
  const requests: Array<{ summary: boolean; optionKeys: string[] }> = []
  const mainReplies: ModelReply[] = []
  const active = new Set<AbortController>()
  let summaryReply: ModelReply = {
    text: 'Compacted source facts; the original read completed once.'
  }
  let forwarding = Promise.resolve()
  let summaryGate: Promise<void> | undefined
  let releaseSummaries: (() => void) | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      let failed = false
      let failure: unknown
      for (const dispose of [
        async () => {
          for (const controller of active) controller.abort()
          releaseSummaries?.()
          await selection.close()
        },
        async () => {
          for (const controller of active) controller.abort()
          proxy?.closeAllConnections()
          if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()))
        }
      ]) {
        try {
          await dispose()
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        }
      }
      if (failed) throw failure
    })())
  try {
    const configPath = join(selection.base.agentDir, 'config.yml')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.compaction = {
      ...config.compaction,
      enabled: true,
      thresholdPercent: 90,
      thresholdTokens: -1,
      keepRecentTokens: 512,
      methodOrder: ['soft']
    }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    await writeFile(observationPath, '', { mode: 0o600 })
    await writeFile(
      join(selection.base.cwd, 'retained-source.txt'),
      'Original source fact read once.',
      { mode: 0o600 }
    )
    // Use the injected public namespace; bundled CLI extension imports stay unchanged.
    await writeFile(
      join(selection.base.root, 'selection-refresh-extension.ts'),
      `import { appendFileSync, readFileSync } from 'node:fs';
const audit = ${JSON.stringify(observationPath)};
const record = value => appendFileSync(audit, JSON.stringify(value) + '\\n', {mode:0o600});
export default pi => {
  pi.registerCommand('compaction-oracle-observe', {
    description: 'Private public-SDK compaction observer',
    handler: async (_args, ctx) => {
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!session || session.sessionManager.getCwd() !== ctx.cwd)
        throw new Error('Actual session identity unavailable');
      record({type:'state_observation', autoCompactionEnabled:session.autoCompactionEnabled,
        contextUsage:ctx.getContextUsage(), configuredPolicy:session.settings.getGlobalSettings().compaction});
    }
  });
  pi.registerCommand('compaction-oracle-compact', {
    description:'Private public-SDK cancellable compaction oracle',
    handler: async (_args,ctx) => {
      await ctx.compact({suppressContinuation:true,
        onComplete:result=>record({type:'extension_compact_completed',result}),
        onError:error=>record({type:'extension_compact_error',name:error.name,message:error.message})});
    }
  });
  pi.registerTool({
    name:'read', label:'Compaction contract read',
    description:'Record one isolated fixture invocation',
    parameters:{type:'object', properties:{path:{type:'string'}}, required:['path']},
    async execute(_id, args) {
      const path = args.path.endsWith(':raw') ? args.path.slice(0,-4) : args.path;
      const text = readFileSync(path, 'utf8');
      record({type:'tool_execute', path:args.path});
      return {content:[{type:'text',text}]};
    }
  });
  pi.on('session_start', async () => { await pi.setActiveTools(['read']); record({type:'session_start'}); });
  pi.on('session_before_compact', (event) => record({type:event.type, customInstructions:event.customInstructions}));
  pi.on('session_compact', event => record({type:event.type, fromExtension:event.fromExtension, entry:event.compactionEntry}));
};`,
      { mode: 0o600 }
    )
    // The SDK creates a journal lazily, after the first explicit model turn.
    selection.base.provider.enqueue({ text: 'Compaction contract initialized.' })
    const initialized = await selection.connection.prompt(
      'Initialize this isolated compaction contract.'
    )
    if (initialized.status !== 'completed')
      throw new Error('Compaction contract initialization failed')
    const modelConfigPath = join(selection.base.agentDir, 'models.yml')
    const modelConfig = JSON.parse(await readFile(modelConfigPath, 'utf8'))
    const providers = Object.values(modelConfig.providers) as Array<{ baseUrl: string }>
    const target = providers[0].baseUrl
    proxy = createServer(async (request, response) => {
      const controller = new AbortController()
      active.add(controller)
      response.once('close', () => {
        if (!response.writableEnded) controller.abort()
      })
      try {
        if (request.method !== 'POST' || request.url !== '/v1/pi/stream')
          throw new Error('Unexpected contract endpoint')
        let body = ''
        for await (const chunk of request) body += chunk
        const payload = JSON.parse(body)
        const summary = payload.context.messages.some((message: { content: unknown }) =>
          JSON.stringify(message.content).includes('<conversation>')
        )
        requests.push({ summary, optionKeys: Object.keys(payload.options ?? {}) })
        if (summary && summaryGate) {
          let aborted!: () => void
          try {
            await Promise.race([
              summaryGate,
              new Promise<never>((_resolve, reject) => {
                aborted = () => reject(controller.signal.reason)
                controller.signal.addEventListener('abort', aborted, { once: true })
                if (controller.signal.aborted) aborted()
              })
            ])
          } finally {
            controller.signal.removeEventListener('abort', aborted)
          }
        }
        controller.signal.throwIfAborted()
        // Feed the existing provider by actual request purpose. A speculative summary
        // must not consume a reply intended for the explicit user turn.
        const previous = forwarding
        let release!: () => void
        forwarding = new Promise<void>((resolve) => {
          release = resolve
        })
        let upstream: Response
        try {
          await previous
          controller.signal.throwIfAborted()
          const reply = summary ? summaryReply : mainReplies.shift()
          if (!reply) throw new Error('No explicit contract reply remains')
          selection.base.provider.enqueue(reply)
          upstream = await fetch(target + request.url, {
            method: 'POST',
            body,
            headers: {
              authorization: request.headers.authorization ?? '',
              'content-type': 'application/json'
            },
            signal: controller.signal
          })
        } finally {
          release()
        }
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'text/plain'
        })
        const reader = upstream.body!.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            response.write(value)
          }
        } finally {
          reader.releaseLock()
        }
        response.end()
      } catch {
        if (!response.destroyed) response.writeHead(500).end('Isolated compaction transport failed')
      } finally {
        active.delete(controller)
      }
    })
    await new Promise<void>((resolve, reject) => {
      proxy!.once('error', reject)
      proxy!.listen(0, '127.0.0.1', resolve)
    })
    for (const provider of providers)
      provider.baseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    await writeFile(modelConfigPath, JSON.stringify(modelConfig), { mode: 0o600 })
    const state = await selection.state()
    await selection.reopen(state.sessionFile)
    selection.frames.length = 0
    const observations = async (): Promise<CompactionObservation[]> => {
      const content = (await readFile(observationPath, 'utf8')).trim()
      return content ? content.split('\n').map((line) => JSON.parse(line)) : []
    }
    return {
      selection,
      requests,
      enqueue: (...replies: ModelReply[]) => mainReplies.push(...replies),
      summary: (reply: ModelReply) => {
        summaryReply = reply
      },
      holdSummaries: () => {
        summaryGate = new Promise<void>((resolve) => {
          releaseSummaries = resolve
        })
        return () => {
          releaseSummaries?.()
          releaseSummaries = undefined
          summaryGate = undefined
        }
      },
      extensionCompact: () => selection.connection.prompt('/compaction-oracle-compact'),
      frames: selection.frames,
      get connection() {
        return selection.connection
      },
      state: () => selection.connection.request<CompactionState>({ type: 'get_state' }),
      messages: selection.messages,
      journal: selection.journal,
      compact: (customInstructions?: string) =>
        selection.connection.request<CompactionResult>({ type: 'compact', customInstructions }),
      async policy(percent?: 70 | 80 | 90): Promise<CompactionObservation> {
        if (percent !== undefined) {
          const state = await selection.state()
          config.compaction.thresholdPercent = percent
          await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
          await selection.reopen(state.sessionFile)
        }
        const result = await selection.connection.prompt('/compaction-oracle-observe')
        if (result.agentInvoked || result.status !== 'completed')
          throw new Error('Public compaction observer failed')
        const entries = await observations()
        const value = entries.findLast((entry) => entry.type === 'state_observation')
        if (!value) throw new Error('Compaction observer unavailable')
        return value
      },
      observations,
      reopen: selection.reopen,
      close
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
