import { copyFile, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { LocalHost } from '../../src/main/agent/workspace-host/local-host'
import type { WorkspaceHost } from '../../src/main/agent/workspace-host/types'
import {
  RpcHostResultDelivery,
  type HostResultLease
} from '../../src/main/agent/engine/rpc/host-result-delivery'
import { startHostResultModel } from './rpcHostResultModel'
import { createBootstrapFixture } from '../engine-contract/bootstrap-stdio-fixture'

export function resultHost(
  root: string,
  beforeCopy?: (remote: string, signal?: AbortSignal) => Promise<void>
): WorkspaceHost {
  const local = new LocalHost(root)
  return {
    fs: local.fs,
    exec: local.exec,
    capabilities: () => local.capabilities(),
    transfer: {
      async uploadFile(source, destination, options) {
        await beforeCopy?.(destination, options?.signal)
        options?.signal?.throwIfAborted()
        await copyFile(source, destination)
        await chmod(destination, 0o600)
        options?.signal?.throwIfAborted()
      }
    }
  }
}
export async function rpcHostResultFixture(
  options: {
    hook?: 'normal' | 'missing' | 'throws' | 'timeout'
    beforeCopy?: (remote: string, signal?: AbortSignal) => Promise<void>
  } = {}
): Promise<
  Awaited<ReturnType<typeof createBootstrapFixture>> & {
    delivery: RpcHostResultDelivery
    lease: HostResultLease
    run: AbortController
    directory: string
    capability: string
    generationDirectory: string
  }
> {
  const f = await createBootstrapFixture({ missingEntry: true })
  const provider = await startHostResultModel()
  const run = new AbortController()
  const generationDirectory = join(f.root, 'generation')
  mkdirSync(generationDirectory, { mode: 0o700 })
  const lease: HostResultLease = {
    leaseId: randomBytes(32).toString('hex'),
    generation: 1,
    phiSessionId: 'phi-result-session',
    projectId: 'phi-result-project',
    cwd: f.cwd
  }
  const capability = randomBytes(32).toString('hex')
  const delivery = await RpcHostResultDelivery.create({
    host: resultHost(f.root, options.beforeCopy),
    generationDirectory,
    lease,
    capability,
    signal: run.signal
  })
  const modelPath = join(f.agentDir, 'models.yml')
  writeFileSync(
    modelPath,
    readFileSync(modelPath, 'utf8')
      .replace(f.provider.url, provider.url)
      .replace('"input":["text"]', '"input":["text","image"]'),
    { mode: 0o600 }
  )
  const modulePath = fileURLToPath(
    new URL(
      '../../src/main/agent/engine/phi-extension/extensions/rpc-host-result.ts',
      import.meta.url
    )
  )
  writeFileSync(
    join(f.root, 'missing-entry.ts'),
    `import { createRpcHostResultExtension } from ${JSON.stringify(modulePath)};
export default async (pi) => {
 let ready;
 const signal = new AbortController().signal;
 pi.on('session_start', (_, ctx) => { ready = Object.freeze({ ...${JSON.stringify(lease)}, runId: 'run-1', signal, ompSessionId: ctx.sessionManager.getSessionId() }); });
 pi.registerCommand('phi-result-fixture', { description: 'Host result fixture loaded', handler: async () => {} });
 ${options.hook === 'missing' ? '' : options.hook === 'throws' ? `pi.on('tool_result', () => { throw new Error('synthetic hook failure'); });` : options.hook === 'timeout' ? `pi.on('tool_result', async () => { await new Promise(() => {}); });` : `await createRpcHostResultExtension({ generationDirectory: ${JSON.stringify(generationDirectory)}, directory: ${JSON.stringify(delivery.directory)}, capability: ${JSON.stringify(capability)}, readiness: () => ready, isHostTool: name => name === 'desktop_echo' })(pi);`}
};`,
    { mode: 0o600 }
  )
  try {
    await f.connection.start()
    const commands = await f.connection.request<{ commands: Array<{ name: string }> }>({
      type: 'get_available_commands'
    })
    if (!commands.commands.some((command) => command.name === 'phi-result-fixture'))
      throw new Error(`Result fixture extension did not load: ${f.stderr()}`)
    return {
      ...f,
      provider,
      lease,
      run,
      delivery,
      directory: delivery.directory,
      capability,
      generationDirectory,
      async close() {
        run.abort()
        await delivery.dispose()
        await provider.close()
        await f.close()
      }
    }
  } catch (error) {
    run.abort()
    await delivery.dispose()
    await provider.close()
    await f.close()
    throw error
  }
}
/** Valid high-entropy PNG, not arbitrary bytes labelled as an image. */
export function resultPng(): string {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(Buffer.concat([type, data])))
    return Buffer.concat([size, type, data, sum])
  }
  const width = 600,
    height = 600
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const data = Buffer.alloc(height * (width * 4 + 1))
  let state = 0x13579bdf
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 4; x++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      data[y * (width * 4 + 1) + x + 1] = state & 255
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(data)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}
