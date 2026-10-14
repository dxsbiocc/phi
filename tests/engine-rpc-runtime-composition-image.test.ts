import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PhiTool, PhiToolImage } from '../src/main/agent/engine/types'
import { resultPng } from './helpers/rpcHostResultFixture'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { scanPersistentLauncherFiles } from './helpers/persistentLauncherFixture'
import type { RpcRuntimeConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-runtime-config'

test(
  'production host image/details hydrate through the true gateway, durable blobs and a fresh HOME with all ephemeral secrets absent from durable files',
  { timeout: 75_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    f.beforeLaunch(async (path) => {
      await writeFile(
        join(dirname(path), 'home/.omp/agent/config.yml'),
        JSON.stringify({ compaction: { enabled: false } }),
        { mode: 0o600 }
      )
    })
    const png = resultPng()
    assert.ok(Buffer.byteLength(png) > 1024 * 1024)
    const tool: PhiTool = {
      name: 'desktop_image',
      approval: 'read',
      site: 'host',
      label: 'Private image',
      description: 'Return a private valid PNG',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return {
          content: [
            { type: 'text', text: 'image boundary evidence' },
            { type: 'image', data: png, mimeType: 'image/png' }
          ],
          details: { marker: 'image details retained' }
        }
      }
    }
    const first = await f.create({ tools: [tool] })
    await f.sdk.enqueue(
      { tool: { name: tool.name, args: {}, id: 'image-call' } },
      { text: 'image consumed' }
    )
    const turn = await first.prompt('phi-image-run', 'Call the image tool')
    assert.equal(turn.outcome, 'completed')
    const result = turn.snapshot.messages.findLast(
      (value) => (value as { role?: string }).role === 'toolResult'
    ) as {
      content: Array<PhiToolImage | { type: 'text'; text: string }>
      details: { marker: string }
    }
    const image = result.content.find((item): item is PhiToolImage => item.type === 'image')!
    assert.ok(image.data && image.mimeType)
    assert.equal(result.details.marker, 'image details retained')
    assert.ok(
      JSON.stringify((await f.sdk.snapshot()).providerRequests.at(-1)!.body).includes(image.data)
    )
    const privateConfig = async (): Promise<RpcRuntimeConfig> => {
      const [nonce] = await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))
      return JSON.parse(
        await readFile(join(f.f.runtimeRoot, 'rpc-sessions', nonce, 'runtime.json'), 'utf8')
      )
    }
    const old = await privateConfig()
    await first.close()
    const count = (await f.sdk.snapshot()).providerRequests.length
    const second = await f.create({
      tools: [tool],
      action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref }
    })
    const next = await privateConfig()
    assert.notEqual(old.execution.capability, next.execution.capability)
    assert.equal((await f.sdk.snapshot()).providerRequests.length, count)
    assert.ok(JSON.stringify(second.currentSnapshot().messages).includes(image.data))
    await f.sdk.enqueue({ text: 'fresh image history accepted' })
    assert.equal(
      (await second.prompt('phi-image-next', 'Continue explicitly with the existing image'))
        .outcome,
      'completed'
    )
    assert.ok(
      JSON.stringify((await f.sdk.snapshot()).providerRequests.at(-1)!.body).includes(image.data)
    )
    await second.close()
    const secrets = [
      old.execution.capability,
      old.result.capability,
      next.execution.capability,
      next.result.capability,
      ...f.leases.map((lease) => lease.bearerToken)
    ]
    for (const file of await scanPersistentLauncherFiles(f.f.paths.directory))
      for (const secret of secrets)
        assert.ok(
          !file.bytes.includes(Buffer.from(secret)),
          `Ephemeral authority persisted in ${file.path}`
        )
    assert.deepEqual(await readdir(join(f.f.runtimeRoot, 'rpc-sessions')), [])
  }
)
