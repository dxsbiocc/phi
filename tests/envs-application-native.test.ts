import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib'

import {
  MAX_EXPANDED_ARCHIVE_BYTES,
  readTarEntries
} from '../src/main/agent/envs/applications/artifacts'
import { installNativeApplication } from '../src/main/agent/envs/applications/native'
import type { NativeApplicationArtifact } from '../src/main/agent/envs/applications/types'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'

const executable = Buffer.from('#!/bin/sh\nprintf "native works"\n')

async function withRoot(body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-application-native-'))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function install(
  root: string,
  data: Buffer,
  selection: { format: 'file' } | { format: 'tar.gz' | 'zip'; member: string },
  signal?: AbortSignal
): ReturnType<typeof installNativeApplication> {
  const artifact: NativeApplicationArtifact = {
    url: 'https://example.test/native',
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    ...selection
  }
  return installNativeApplication({
    root,
    prefix: join(root, 'prefix'),
    sourceDir: root,
    platform: 'linux-x64',
    installation: { backend: 'native', executable: 'tool', artifacts: { 'linux-x64': artifact } },
    signal,
    fetch: (async () => new Response(Uint8Array.from(data))) as typeof fetch
  })
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface ZipFixtureEntry {
  name: string
  data: Buffer
  mode?: number
  method?: number
  size?: number
  descriptor?: boolean
}

function zip(files: ZipFixtureEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const method = file.method ?? 8
    const compressed = method === 0 ? file.data : deflateRawSync(file.data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    const flags = 0x800 | (file.descriptor ? 0x8 : 0)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    if (!file.descriptor) {
      header.writeUInt32LE(crc32(file.data), 14)
      header.writeUInt32LE(compressed.length, 18)
      header.writeUInt32LE(file.size ?? file.data.length, 22)
    }
    header.writeUInt16LE(name.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(0x314, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(flags, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc32(file.data), 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(file.size ?? file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(((file.mode ?? 0o100755) << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    const descriptor = Buffer.alloc(file.descriptor ? 16 : 0)
    if (file.descriptor) {
      descriptor.writeUInt32LE(0x08074b50)
      descriptor.writeUInt32LE(crc32(file.data), 4)
      descriptor.writeUInt32LE(compressed.length, 8)
      descriptor.writeUInt32LE(file.size ?? file.data.length, 12)
    }
    local.push(header, name, compressed, descriptor)
    central.push(entry, name)
    offset += header.length + name.length + compressed.length + descriptor.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

test('native file installation writes only a private executable and runs without another runtime', async () => {
  await withRoot(async (root) => {
    const metadata = await install(root, executable, { format: 'file' })
    const path = join(root, 'prefix', 'bin', 'tool')
    assert.deepEqual(readFileSync(path), executable)
    assert.equal(statSync(path).mode & 0o777, 0o700)
    assert.equal(
      execFileSync(path, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }),
      'native works'
    )
    assert.equal(metadata.backend, 'native')
    assert.equal(metadata.executable, 'tool')
    assert.equal(metadata.artifacts[0].size, executable.length)
    assert.match(metadata.specSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(readdirSync(join(root, 'prefix', 'bin')), ['tool'])
  })
})

test('native tar installation selects one regular member and ignores unrelated regular contents', async () => {
  await withRoot(async (root) => {
    const archive = createDeterministicTarGz([
      { path: 'package/bin/tool', data: executable },
      { path: 'package/readme', data: Buffer.from('documentation') }
    ])
    await install(root, archive, { format: 'tar.gz', member: 'package/bin/tool' })
    assert.deepEqual(readFileSync(join(root, 'prefix', 'bin', 'tool')), executable)
    assert.deepEqual(readdirSync(join(root, 'prefix')), ['bin'])
  })
})

test('native ZIP wheel installation copies the exact member for stored and deflated entries', async () => {
  for (const method of [0, 8])
    await withRoot(async (root) => {
      const archive = zip([
        { name: 'biomcp.data/scripts/biomcp', data: executable, method },
        { name: 'biomcp.dist-info/METADATA', data: Buffer.from('metadata') }
      ])
      await install(root, archive, { format: 'zip', member: 'biomcp.data/scripts/biomcp' })
      assert.deepEqual(readFileSync(join(root, 'prefix', 'bin', 'tool')), executable)
      assert.deepEqual(readdirSync(join(root, 'prefix')), ['bin'])
    })
})

test('native ZIP installer supports consistent streaming data descriptors', async () => {
  await withRoot(async (root) => {
    await install(root, zip([{ name: 'target', data: executable, descriptor: true }]), {
      format: 'zip',
      member: 'target'
    })
    assert.deepEqual(readFileSync(join(root, 'prefix', 'bin', 'tool')), executable)
  })
})

test('native cancellation before publication never leaves a runnable executable', async () => {
  await withRoot(async (root) => {
    const controller = new AbortController()
    await assert.rejects(
      installNativeApplication({
        root,
        prefix: join(root, 'prefix'),
        sourceDir: root,
        platform: 'linux-x64',
        installation: {
          backend: 'native',
          executable: 'tool',
          artifacts: {
            'linux-x64': {
              format: 'file',
              url: 'https://example.test/native',
              sha256: createHash('sha256').update(executable).digest('hex'),
              size: executable.length
            }
          }
        },
        signal: controller.signal,
        onProgress: ({ message }) => {
          if (message.startsWith('installing')) controller.abort()
        },
        fetch: (async () => new Response(executable)) as typeof fetch
      }),
      { name: 'AbortError' }
    )
    assert.equal(existsSync(join(root, 'prefix', 'bin', 'tool')), false)
    assert.deepEqual(readdirSync(join(root, 'prefix', 'bin')), [])
  })
})

test('native application fails when the selected platform has no binary', async () => {
  await withRoot(async (root) => {
    let fetched = false
    await assert.rejects(
      installNativeApplication({
        root,
        prefix: join(root, 'prefix'),
        sourceDir: root,
        platform: 'darwin-arm64',
        installation: { backend: 'native', executable: 'tool', artifacts: {} },
        fetch: (async () => {
          fetched = true
          return new Response(executable)
        }) as typeof fetch
      }),
      /no artifact.*darwin-arm64/
    )
    assert.equal(fetched, false)
    assert.equal(existsSync(join(root, 'prefix')), false)
  })
})

test('native archive failures leave no prefix or executable', async () => {
  const malformed = [
    zip([{ name: '../tool', data: executable }]),
    zip([
      { name: 'target', data: executable },
      { name: 'unrelated/../../escape', data: executable }
    ]),
    zip([{ name: 'target', data: executable, mode: 0o120777 }]),
    zip([
      { name: 'target', data: executable },
      { name: 'target', data: executable }
    ]),
    zip([
      { name: 'target', data: executable },
      { name: 'target/child', data: executable }
    ]),
    zip([{ name: 'target', data: executable, size: MAX_EXPANDED_ARCHIVE_BYTES + 1 }]),
    zip([{ name: 'target', data: Buffer.alloc(100000), size: 1 }])
  ]
  for (const archive of malformed)
    await withRoot(async (root) => {
      await assert.rejects(install(root, archive, { format: 'zip', member: 'target' }))
      assert.equal(existsSync(join(root, 'prefix')), false)
    })
})

test('ZIP members require consistent metadata and a valid CRC', async () => {
  for (const corruption of ['local-name', 'crc', 'overlap', 'encrypted'])
    await withRoot(async (root) => {
      const archive = zip([{ name: 'target', data: executable }])
      const central = archive.readUInt32LE(archive.length - 6)
      if (corruption === 'local-name') archive[30] = 'x'.charCodeAt(0)
      if (corruption === 'crc') {
        archive.writeUInt32LE(0, 14)
        archive.writeUInt32LE(0, central + 16)
      }
      if (corruption === 'overlap') archive.writeUInt32LE(1, central + 42)
      if (corruption === 'encrypted') {
        archive.writeUInt16LE(0x801, 6)
        archive.writeUInt16LE(0x801, central + 8)
      }
      await assert.rejects(install(root, archive, { format: 'zip', member: 'target' }))
      assert.equal(existsSync(join(root, 'prefix')), false)
    })
})

test('safe tar parser rejects traversal, links, collisions, and bounded expansion', () => {
  assert.throws(
    () => readTarEntries(createDeterministicTarGz([{ path: '../escape', data: executable }])),
    /unsafe/
  )
  assert.throws(
    () =>
      readTarEntries(
        createDeterministicTarGz([
          { path: 'target', data: executable },
          { path: 'target/child', data: executable }
        ])
      ),
    /collides/
  )
  const tar = gunzipSync(createDeterministicTarGz([{ path: 'target', data: executable }]))
  tar[156] = '2'.charCodeAt(0)
  tar.fill(0x20, 148, 156)
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
  tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  tar[154] = 0
  tar[155] = 0x20
  assert.throws(() => readTarEntries(gzipSync(tar)), /link or special/)
  assert.throws(
    () =>
      readTarEntries(
        createDeterministicTarGz([{ path: 'large', data: Buffer.alloc(10000) }]),
        1000
      ),
    /gzip|size|larger/
  )
})

test('native archive rejects missing members, invalid executable names, and cancellation', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      install(root, zip([{ name: 'other', data: executable }]), {
        format: 'zip',
        member: 'target'
      }),
      /no regular member/
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(install(root, executable, { format: 'file' }, controller.signal), {
      name: 'AbortError'
    })
    await assert.rejects(
      installNativeApplication({
        root,
        prefix: join(root, 'prefix'),
        sourceDir: root,
        platform: 'linux-x64',
        installation: { backend: 'native', executable: '../tool', artifacts: {} }
      }),
      /invalid native.*executable/
    )
  })
})
