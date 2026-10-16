import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename as filename, join, posix } from 'node:path'
import test from 'node:test'
import { SshTransferDataPlane } from '../src/main/agent/transfer/ssh-data-plane'
import { parseTransferManifest, type TransferManifest } from '../src/main/agent/transfer/manifest'
import type { TransferPreflight } from '../src/main/agent/transfer/data-plane'
import type { TransferProgress, TransferRequest } from '../src/main/agent/transfer/types'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import { createLocalShellSession } from './helpers/localShellSession'

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const hostResultName = 'a'.repeat(64) + '.json.partial'

function fixture(basename = hostResultName): {
  root: string
  content: Buffer
  scripts: string[]
  partial: string
  manifestPath: string
  destination: string
  request: TransferRequest
  plane: SshTransferDataPlane
  manifest(preflight: TransferPreflight, offset?: number): TransferManifest
  close(): Promise<void>
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-transfer-long-state-')))
  const directory = join(root, 'host-results-' + 'b'.repeat(64))
  const source = join(root, 'source.bin')
  const content = Buffer.from(Array.from({ length: 103 }, (_, index) => index))
  const transferId = 'phi-host-result-' + 'c'.repeat(64)
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(source, content, { mode: 0o600 })
  const local = new LocalHost(root),
    ssh = createLocalShellSession(root),
    scripts: string[] = []
  const host: WorkspaceHost = {
    fs: local.fs,
    exec: {
      run: (command, options) => {
        scripts.push(command[2])
        return local.exec.run(command, options)
      },
      spawnBackground: (...args) => local.exec.spawnBackground(...args)
    },
    capabilities: () => local.capabilities()
  }
  const request: TransferRequest = {
    transferId,
    dataPlaneId: 'ssh',
    direction: 'upload',
    hostKey: 'host',
    source: { kind: 'local-path', path: source },
    destination: {
      kind: 'remote-workspace-path',
      hostId: 'host',
      workspaceId: 'workspace',
      relativePath: posix.join(filename(directory), basename)
    },
    expectedSha256: hash(content)
  }
  const partial = join(directory, `.${basename}.phi-transfer-${transferId}.part`)
  return {
    root,
    content,
    scripts,
    partial,
    manifestPath: partial + '.json',
    destination: join(directory, basename),
    request,
    plane: new SshTransferDataPlane({
      host,
      hostId: 'host',
      workspaceId: 'workspace',
      remoteRoot: root,
      canonicalRoot: root,
      openStream: async (command) => {
        const channel = await ssh.openStdio!(command)
        channel.stdin.on('error', () => undefined)
        return channel
      }
    }),
    manifest(preflight, offset = 0) {
      const lastSize = Math.min(offset, 32),
        lastOffset = offset - lastSize
      const manifest: TransferManifest = {
        protocolVersion: 1,
        transferId,
        direction: 'upload',
        sourceIdentity: preflight.sourceIdentity,
        expectedSize: content.length,
        expectedSha256: hash(content),
        durableOffset: offset,
        chunkSize: 32,
        lastChunk:
          offset === 0
            ? null
            : {
                offset: lastOffset,
                size: lastSize,
                sha256: hash(content.subarray(lastOffset, offset))
              },
        createdAt: 1,
        updatedAt: 1
      }
      assert.ok(parseTransferManifest(manifest))
      return manifest
    },
    async close() {
      await ssh.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

for (const [name, basename] of [
  ['short control', 'result.json'],
  ['host-result filename', hostResultName]
]) {
  test(`SSH manifest initialization keeps valid103B content for ${name}`, async () => {
    const f = fixture(basename)
    try {
      const session = await f.plane.open(f.request)
      const preflight = await session.preflight(new AbortController().signal)
      assert.equal(preflight.expectedSize, 103)
      const manifest = f.manifest(preflight)
      try {
        await session.writeManifest(manifest)
      } catch (error) {
        const prefix = /^temporary='([^']+)'\.\$\$/m.exec(f.scripts.at(-1) ?? '')?.[1]
        if (prefix && Buffer.byteLength(filename(prefix)) > 255) {
          assert.throws(() => writeFileSync(prefix + '.diagnostic', '{}', { flag: 'wx' }), {
            code: 'ENAMETOOLONG'
          })
          console.log(
            JSON.stringify({
              actualTemporaryPrefixBytes: Buffer.byteLength(filename(prefix)),
              nativeFailure: 'ENAMETOOLONG',
              manifestContentValid: true
            })
          )
        }
        throw error
      }
      const prefix = /^temporary='([^']+)'\.\$\$/m.exec(f.scripts.at(-1) ?? '')?.[1]
      assert.ok(prefix)
      assert.ok(Buffer.byteLength(filename(prefix)) + 24 <= 255)
      assert.deepEqual(
        parseTransferManifest(JSON.parse(readFileSync(f.manifestPath, 'utf8'))),
        manifest
      )
      assert.equal(lstatSync(f.manifestPath).mode & 0o777, 0o600)
      assert.equal(lstatSync(f.manifestPath).nlink, 1)
      assert.equal(lstatSync(f.partial).size, 0)
      assert.deepEqual(
        readdirSync(posix.dirname(f.partial)).sort(),
        [filename(f.partial), filename(f.manifestPath)].sort()
      )
      assert.equal(session.partialLocator, `ssh://host/workspace/${f.partial}`)
      assert.equal(session.manifestLocator, `ssh://host/workspace/${f.manifestPath}`)
    } finally {
      await f.close()
    }
  })
}

for (const offset of [0, 17]) {
  test(`SSH long-name stream ${offset === 0 ? 'checkpoint' : 'truncated resume'} preserves retained locators and SHA`, async () => {
    const f = fixture()
    try {
      const initial = await f.plane.open(f.request)
      const initialPreflight = await initial.preflight(new AbortController().signal)
      const retained = f.manifest(initialPreflight, offset)
      writeFileSync(
        f.partial,
        offset === 0
          ? Buffer.alloc(0)
          : Buffer.concat([f.content.subarray(0, offset), Buffer.from('uncommitted tail')]),
        { mode: 0o600 }
      )
      chmodSync(f.partial, 0o600)
      writeFileSync(f.manifestPath, JSON.stringify(retained), { mode: 0o600 })
      const session = await f.plane.open(f.request)
      await session.preflight(new AbortController().signal)
      assert.equal(session.partialLocator, initial.partialLocator)
      assert.equal(session.manifestLocator, initial.manifestLocator)
      assert.deepEqual(await session.loadManifest(), retained)
      if (offset) {
        assert.ok((await session.inspectPartial()).size > offset)
        assert.equal(await session.hashPartialRange(0, offset, 32), retained.lastChunk!.sha256)
        await session.truncatePartial(offset)
      }
      const checkpoints: TransferProgress[] = []
      await session.copy({
        offset,
        chunkSize: 32,
        signal: new AbortController().signal,
        onChunk: async () => false,
        onCheckpoint: async (progress) => {
          checkpoints.push(progress)
        }
      })
      assert.equal(checkpoints.length, 1)
      assert.equal(checkpoints[0].offset, 103)
      assert.deepEqual(readFileSync(f.partial), f.content)
      const actual = parseTransferManifest(JSON.parse(readFileSync(f.manifestPath, 'utf8')))
      assert.ok(actual)
      assert.equal(actual.transferId, retained.transferId)
      assert.deepEqual(actual.sourceIdentity, retained.sourceIdentity)
      assert.equal(actual.durableOffset, 103)
      assert.equal(actual.lastChunk?.sha256, hash(f.content.subarray(71)))
      assert.equal(lstatSync(f.manifestPath).mode & 0o777, 0o600)
      const cold = await f.plane.open(f.request)
      await cold.preflight(new AbortController().signal)
      assert.equal(cold.partialLocator, initial.partialLocator)
      assert.equal(cold.manifestLocator, initial.manifestLocator)
      assert.equal((await cold.loadManifest())?.durableOffset, 103)
      assert.equal(await session.hashPartial(32), hash(f.content))
      await session.publish()
      assert.deepEqual(readFileSync(f.destination), f.content)
      assert.equal(existsSync(f.partial), false)
      assert.equal(existsSync(f.manifestPath), false)
      assert.deepEqual(readdirSync(posix.dirname(f.destination)), [filename(f.destination)])
    } finally {
      await f.close()
    }
  })
}
