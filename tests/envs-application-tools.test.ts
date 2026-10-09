import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  installDeclaredApplicationTools,
  validateDeclaredApplicationTools
} from '../src/main/agent/envs/applications/tools'
import type {
  ApplicationInstallInput,
  JavaScriptBunInstallation,
  NativeApplicationArtifact,
  PinnedRuntimeTool
} from '../src/main/agent/envs/applications/types'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'

const BUN_VERSION = '1.3.14'
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const runtime = (version: string): Buffer =>
  Buffer.from(`#!/bin/sh\n[ "$1" = --version ] || exit 4\nprintf '%s\\n' '${version}'\n`)

interface Fixture {
  root: string
  prefix: string
  sourceDir: string
  installation: JavaScriptBunInstallation
}

async function withFixture(body: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-declared-tools-'))
  const sourceDir = join(root, 'source')
  mkdirSync(sourceDir)
  const manifest = Buffer.from('{"name":"fixture","version":"1.0.0","dependencies":{}}')
  const lock = Buffer.from('{"lockfileVersion":3,"packages":{}}')
  writeFileSync(join(sourceDir, 'package.json'), manifest)
  writeFileSync(join(sourceDir, 'package-lock.json'), lock)
  const fixture: Fixture = {
    root,
    prefix: join(root, 'prefix'),
    sourceDir,
    installation: {
      backend: 'javascript-bun',
      manifest: './package.json',
      manifestSha256: digest(manifest),
      lock: './package-lock.json',
      lockSha256: digest(lock),
      executable: 'fixture-cli'
    }
  }
  try {
    await body(fixture)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function tool(
  bytes: Buffer,
  selected: { format: 'file' } | { format: 'tar.gz' | 'zip'; member: string },
  version = BUN_VERSION
): PinnedRuntimeTool {
  const artifact: NativeApplicationArtifact = {
    url: `https://example.test/runtime/${version}`,
    sha256: digest(bytes),
    size: bytes.length,
    ...selected
  }
  return { version, artifacts: { 'linux-x64': artifact } }
}

function request(fixture: Fixture, bytes: Buffer): ApplicationInstallInput {
  return {
    ...fixture,
    platform: 'linux-x64',
    fetch: (async () => new Response(Uint8Array.from(bytes))) as typeof fetch
  }
}

function zip(name: string, data: Buffer, mode = 0o100755): Buffer {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const encoded = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x800, 6)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(encoded.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(0x314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x800, 8)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(encoded.length, 28)
  central.writeUInt32LE((mode << 16) >>> 0, 38)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + encoded.length, 12)
  end.writeUInt32LE(local.length + encoded.length + data.length, 16)
  return Buffer.concat([local, encoded, data, central, encoded, end])
}

function tarLink(archive: Buffer, name: string): Buffer {
  const tar = gunzipSync(archive)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const path = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').trim().replace(/\0.*$/, ''),
      8
    )
    if (path === name) {
      header[156] = '2'.charCodeAt(0)
      header.fill(0x20, 148, 156)
      const sum = header.reduce((total, byte) => total + byte, 0)
      header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
      header[154] = 0
      header[155] = 0x20
      return gzipSync(tar)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('missing fixture tar member')
}

test('declared runtime provisions raw, tar, and ZIP Bun bytes without another package manager', async () => {
  const binary = runtime(BUN_VERSION)
  const formats = [
    { bytes: binary, selection: { format: 'file' as const } },
    {
      bytes: createDeterministicTarGz([{ path: 'bun-linux-x64/bun', data: binary }]),
      selection: { format: 'tar.gz' as const, member: 'bun-linux-x64/bun' }
    },
    {
      bytes: zip('bun-linux-x64/bun', binary),
      selection: { format: 'zip' as const, member: 'bun-linux-x64/bun' }
    }
  ]
  for (const format of formats)
    await withFixture(async (fixture) => {
      fixture.installation.bun = tool(format.bytes, format.selection)
      const input = request(fixture, format.bytes)
      const artifacts = await installDeclaredApplicationTools(input)
      assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'bun')), binary)
      assert.equal(statSync(join(fixture.prefix, 'bin', 'bun')).mode & 0o777, 0o700)
      assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')), ['bun'])
      assert.deepEqual(artifacts, [
        {
          key: `sha256-${digest(format.bytes)}`,
          sha256: digest(format.bytes),
          size: format.bytes.length
        }
      ])
      assert.deepEqual(validateDeclaredApplicationTools(input), artifacts)
    })
})

test('declared Node override provisions both fixed names and checks Node v-prefixed versions', async () => {
  await withFixture(async (fixture) => {
    const bun = runtime(BUN_VERSION)
    const node = runtime('v22.16.0')
    fixture.installation.runtime = 'node'
    fixture.installation.bun = tool(bun, { format: 'file' })
    fixture.installation.node = tool(node, { format: 'file' }, '22.16.0')
    const input = {
      ...request(fixture, bun),
      fetch: (async (url) =>
        new Response(
          Uint8Array.from(String(url).endsWith('/22.16.0') ? node : bun)
        )) as typeof fetch
    }
    assert.equal((await installDeclaredApplicationTools(input)).length, 2)
    assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')).sort(), ['bun', 'node'])
    assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'node')), node)
  })
})

test('unchanged cached runtime reuse does not write the prefix or fetch again', async () => {
  await withFixture(async (fixture) => {
    const binary = runtime(BUN_VERSION)
    fixture.installation.bun = tool(binary, { format: 'file' })
    await installDeclaredApplicationTools(request(fixture, binary))
    const executable = join(fixture.prefix, 'bin', 'bun')
    const before = statSync(executable)
    const binBefore = statSync(join(fixture.prefix, 'bin'))
    const offline = {
      ...request(fixture, binary),
      fetch: (async () => {
        throw new Error('network forbidden')
      }) as typeof fetch
    }
    validateDeclaredApplicationTools(offline)
    await installDeclaredApplicationTools(offline)
    assert.equal(statSync(executable).mtimeMs, before.mtimeMs)
    assert.equal(statSync(executable).ino, before.ino)
    assert.equal(statSync(join(fixture.prefix, 'bin')).mtimeMs, binBefore.mtimeMs)
  })
})

test('cache-hit source integrity is checked before runtime lookup or acquisition', async () => {
  await withFixture(async (fixture) => {
    const binary = runtime(BUN_VERSION)
    fixture.installation.bun = tool(binary, { format: 'file' })
    await installDeclaredApplicationTools(request(fixture, binary))
    writeFileSync(join(fixture.sourceDir, 'package-lock.json'), 'tampered')
    let fetched = false
    const input = {
      ...request(fixture, binary),
      fetch: (async () => {
        fetched = true
        return new Response(Uint8Array.from(binary))
      }) as typeof fetch
    }
    assert.throws(() => validateDeclaredApplicationTools(input), /asset sha256 mismatch/)
    await assert.rejects(installDeclaredApplicationTools(input), /asset sha256 mismatch/)
    assert.equal(fetched, false)
    assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'bun')), binary)
  })
})

test('runtime drift fails read-only validation and is repaired from verified cached bytes', async () => {
  await withFixture(async (fixture) => {
    const binary = runtime(BUN_VERSION)
    fixture.installation.bun = tool(binary, { format: 'file' })
    const input = request(fixture, binary)
    await installDeclaredApplicationTools(input)
    writeFileSync(join(fixture.prefix, 'bin', 'bun'), Buffer.alloc(binary.length))
    assert.throws(() => validateDeclaredApplicationTools(input), /does not match/)
    await installDeclaredApplicationTools({
      ...input,
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch
    })
    assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'bun')), binary)
  })
})

test('declared artifact checksum and actual runtime version mismatch prevent activation', async () => {
  for (const failure of ['checksum', 'version'])
    await withFixture(async (fixture) => {
      const binary = runtime(failure === 'version' ? '1.3.13' : BUN_VERSION)
      fixture.installation.bun = tool(binary, { format: 'file' })
      if (failure === 'checksum')
        fixture.installation.bun.artifacts['linux-x64']!.sha256 = '0'.repeat(64)
      await assert.rejects(
        installDeclaredApplicationTools(request(fixture, binary)),
        failure === 'checksum' ? /sha256 mismatch/ : /version mismatch/
      )
      assert.equal(existsSync(join(fixture.prefix, 'bin', 'bun')), false)
      assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')), [])
    })
})

test('runtime provisioning refuses symlink destinations and leaves outside files unchanged', async () => {
  for (const symlink of ['prefix', 'bin', 'bun'])
    await withFixture(async (fixture) => {
      const binary = runtime(BUN_VERSION)
      fixture.installation.bun = tool(binary, { format: 'file' })
      const outside = join(fixture.root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'bun'), binary)
      if (symlink === 'prefix') symlinkSync(outside, fixture.prefix)
      else {
        mkdirSync(fixture.prefix)
        if (symlink === 'bin') symlinkSync(outside, join(fixture.prefix, 'bin'))
        else {
          mkdirSync(join(fixture.prefix, 'bin'))
          symlinkSync(join(outside, 'bun'), join(fixture.prefix, 'bin', 'bun'))
        }
      }
      await assert.rejects(installDeclaredApplicationTools(request(fixture, binary)), /symlinks/)
      assert.deepEqual(readFileSync(join(outside, 'bun')), binary)
      assert.deepEqual(readdirSync(outside), ['bun'])
    })
})

test('runtime declaration/platform failures do not fall back to a host tool', async () => {
  await withFixture(async (fixture) => {
    const binary = runtime(BUN_VERSION)
    fixture.installation.bun = tool(binary, { format: 'file' })
    const base = request(fixture, binary)
    let fetched = false
    const input = {
      ...base,
      fetch: (async () => {
        fetched = true
        return new Response(Uint8Array.from(binary))
      }) as typeof fetch
    }
    await assert.rejects(
      installDeclaredApplicationTools({ ...input, platform: 'darwin-arm64' }),
      /no artifact.*darwin-arm64/
    )
    fixture.installation.bun.version = '^1.3.14'
    await assert.rejects(installDeclaredApplicationTools(input), /exact version/)
    fixture.installation.bun.version = BUN_VERSION
    fixture.installation.node = tool(runtime('v22.16.0'), { format: 'file' }, '22.16.0')
    await assert.rejects(installDeclaredApplicationTools(input), /requires runtime: node/)
    assert.equal(fetched, false)
    assert.equal(existsSync(fixture.prefix), false)
  })
})

test('official Node-style tar can ignore unrelated links without extracting them', async () => {
  await withFixture(async (fixture) => {
    const node = runtime('v22.16.0')
    const archive = tarLink(
      createDeterministicTarGz([
        { path: 'node-v22/bin/node', data: node },
        { path: 'node-v22/bin/npm', data: Buffer.alloc(0) }
      ]),
      'node-v22/bin/npm'
    )
    fixture.installation.runtime = 'node'
    fixture.installation.node = tool(
      archive,
      { format: 'tar.gz', member: 'node-v22/bin/node' },
      '22.16.0'
    )
    await installDeclaredApplicationTools(request(fixture, archive))
    assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'node')), node)
    assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')), ['node'])
  })
})

test('selected runtime links, traversal, and link-parent collisions remain rejected', async () => {
  const binary = runtime(BUN_VERSION)
  const variants = [
    { bytes: zip('bun', binary, 0o120777), format: 'zip' as const, member: 'bun' },
    {
      bytes: tarLink(createDeterministicTarGz([{ path: 'bun', data: binary }]), 'bun'),
      format: 'tar.gz' as const,
      member: 'bun'
    },
    {
      bytes: createDeterministicTarGz([
        { path: 'bun', data: binary },
        { path: '../outside', data: binary }
      ]),
      format: 'tar.gz' as const,
      member: 'bun'
    },
    {
      bytes: tarLink(
        createDeterministicTarGz([
          { path: 'bun', data: binary },
          { path: 'link', data: Buffer.alloc(0) },
          { path: 'link/child', data: binary }
        ]),
        'link'
      ),
      format: 'tar.gz' as const,
      member: 'bun'
    }
  ]
  for (const variant of variants)
    await withFixture(async (fixture) => {
      fixture.installation.bun = tool(variant.bytes, {
        format: variant.format,
        member: variant.member
      })
      await assert.rejects(
        installDeclaredApplicationTools(request(fixture, variant.bytes)),
        /regular member|unsafe|collides/
      )
      assert.equal(existsSync(join(fixture.prefix, 'bin', 'bun')), false)
    })
})

test('runtime --version receives only an owned HOME/TMP/PATH environment', async () => {
  await withFixture(async (fixture) => {
    const log = join(fixture.root, 'version-env.jsonl')
    const binary = Buffer.from(
      `#!/bin/sh\nprintf '%s\\n' "$PATH" "$HOME" "$TMPDIR" "\${PHI_RUNTIME_SECRET-unset}" > '${log}'\nprintf '${BUN_VERSION}\\n'\n`
    )
    fixture.installation.bun = tool(binary, { format: 'file' })
    const previous = process.env.PHI_RUNTIME_SECRET
    process.env.PHI_RUNTIME_SECRET = 'do-not-inherit'
    try {
      await installDeclaredApplicationTools(request(fixture, binary))
    } finally {
      if (previous === undefined) delete process.env.PHI_RUNTIME_SECRET
      else process.env.PHI_RUNTIME_SECRET = previous
    }
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      join(fixture.prefix, 'bin'),
      join(fixture.root, 'tools', 'home'),
      join(fixture.root, 'tools', 'tmp'),
      'unset'
    ])
    rmSync(log)
    rmSync(join(fixture.root, 'tools'), { recursive: true })
    validateDeclaredApplicationTools(request(fixture, binary))
    assert.equal(existsSync(log), false, 'readiness validation must not execute the runtime')
    assert.equal(
      existsSync(join(fixture.root, 'tools')),
      false,
      'readiness validation must not create version-check directories'
    )
  })
})

test('cancelled runtime bootstrap does not activate a partial executable', async () => {
  await withFixture(async (fixture) => {
    const binary = Buffer.from('#!/bin/sh\nexec /bin/sleep 30\n')
    fixture.installation.bun = tool(binary, { format: 'file' })
    const controller = new AbortController()
    const pending = installDeclaredApplicationTools({
      ...request(fixture, binary),
      signal: controller.signal
    })
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      await assert.rejects(pending, /aborted|AbortError/)
    } finally {
      clearTimeout(timer)
    }
    assert.equal(existsSync(join(fixture.prefix, 'bin', 'bun')), false)
    assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')), [])
  })
})

test('read-only runtime validation never repairs corrupt artifacts or replaces missing runtime bytes', async () => {
  await withFixture(async (fixture) => {
    const binary = runtime(BUN_VERSION)
    fixture.installation.bun = tool(binary, { format: 'file' })
    const input = request(fixture, binary)
    const [artifact] = await installDeclaredApplicationTools(input)
    const cache = join(fixture.root, 'artifacts', artifact.key)
    writeFileSync(cache, Buffer.alloc(binary.length))
    assert.throws(() => validateDeclaredApplicationTools(input), /changed after verification/)
    assert.deepEqual(readFileSync(cache), Buffer.alloc(binary.length))
    assert.deepEqual(readFileSync(join(fixture.prefix, 'bin', 'bun')), binary)
  })
})

const officialBun = {
  url: 'https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-1.3.14.tgz',
  // Verified against the publisher's SHA512 SRI before recording this SHA256 fixture pin.
  sha256: '603d327a393c32fec5d9e7165c5f57afc28f1c84ef85593448870ccc41bda636',
  size: 24310637,
  format: 'tar.gz' as const,
  member: 'package/bin/bun'
}

test(
  'official pinned Bun 1.3.14 bootstraps into a disposable prefix and validates offline',
  {
    skip:
      process.env.PHI_BUN_BOOTSTRAP_INTEGRATION !== '1' ||
      process.platform !== 'darwin' ||
      process.arch !== 'arm64',
    timeout: 120000
  },
  async () => {
    await withFixture(async (fixture) => {
      fixture.installation.bun = {
        version: BUN_VERSION,
        artifacts: { 'darwin-arm64': officialBun }
      }
      const input: ApplicationInstallInput = { ...fixture, platform: 'darwin-arm64' }
      if (process.env.PHI_BUN_BOOTSTRAP_ARCHIVE) {
        const bytes = readFileSync(process.env.PHI_BUN_BOOTSTRAP_ARCHIVE)
        input.fetch = (async () => new Response(Uint8Array.from(bytes))) as typeof fetch
      }
      const refs = await installDeclaredApplicationTools(input)
      assert.equal(refs[0].sha256, officialBun.sha256)
      assert.deepEqual(validateDeclaredApplicationTools(input), refs)
      const offline = {
        ...input,
        fetch: (async () => {
          throw new Error('network forbidden')
        }) as typeof fetch
      }
      await installDeclaredApplicationTools(offline)
      assert.deepEqual(readdirSync(join(fixture.prefix, 'bin')), ['bun'])
    })
  }
)
