import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import Ajv from 'ajv'
import { stringify } from 'yaml'

import {
  computeEnvId,
  ENVIRONMENT_CONTRACT_VERSION,
  lockSha256,
  parseEnvironmentSpec,
  parseExplicitLock
} from '../src/main/agent/envs/contract'
import { environmentSpecSchema, envMetadataSchema } from '../src/main/agent/envs/schemas'
import type { ApplicationInstallation } from '../src/main/agent/envs/applications/types'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const python: ApplicationInstallation = {
  backend: 'python-uv',
  requirements: './requirements.lock',
  requirementsSha256: SHA_A,
  executable: 'bio-mcp'
}
const node: ApplicationInstallation = {
  backend: 'javascript-bun',
  manifest: './package.json',
  manifestSha256: SHA_A,
  lock: './package-lock.json',
  lockSha256: SHA_B,
  executable: 'node-mcp-server',
  runtime: 'node'
}
const native: ApplicationInstallation = {
  backend: 'native',
  executable: 'bio-mcp',
  artifacts: {
    'linux-x64': {
      url: 'https://releases.example.test/v1/server.tar.gz',
      sha256: SHA_A,
      size: 123,
      format: 'tar.gz',
      member: 'server/bin/bio-mcp'
    }
  }
}
const validateSpec = new Ajv({ allErrors: true, strict: false }).compile(environmentSpecSchema)
const validateMetadata = new Ajv({ allErrors: true, strict: false }).compile(envMetadataSchema)

function spec(
  installation?: unknown,
  dependencies: string[] = ['python=3.12']
): Record<string, unknown> {
  return {
    name: 'application',
    channels: ['conda-forge'],
    dependencies,
    ...(installation === undefined ? {} : { installation })
  }
}

function metadata(): Record<string, unknown> {
  return {
    envId: 'mcp-demo-application-0123456789ab',
    name: 'application',
    kind: 'package',
    platform: 'linux-x64',
    lockSha256: SHA_A,
    createdAt: '2026-10-09T00:00:00.000Z',
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [] },
    host: {},
    sourcePackages: [],
    status: 'ready',
    contractVersion: '1.4.0'
  }
}

test('locked Python, Node, and platform-specific native applications parse and validate', () => {
  for (const installation of [python, node, native]) {
    const parsed = parseEnvironmentSpec(stringify(spec(installation)))
    assert.equal(parsed.ok, true, JSON.stringify(parsed))
    if (parsed.ok) assert.deepEqual(parsed.spec.installation, installation)
    assert.equal(validateSpec(spec(installation)), true, JSON.stringify(validateSpec.errors))
  }
  assert.equal(
    validateSpec(spec({ ...python, requirements: './locks/python/requirements.txt' })),
    true
  )
  assert.equal(
    validateSpec(
      spec({
        backend: 'native',
        executable: 'server',
        artifacts: {
          'darwin-arm64': {
            url: 'https://releases.example.test/v1/server',
            sha256: SHA_B,
            size: 12,
            format: 'file'
          }
        }
      })
    ),
    true
  )
})

test('application inputs reject unknown or floating fields and unsafe lock paths', () => {
  for (const installation of [
    { ...node, backend: 'node-npm' },
    { ...python, package: 'biomcp-cli@latest' },
    { ...python, backend: 'uvx' },
    { ...python, requirementsSha256: 'latest' },
    { ...node, version: '^1.0.0' },
    { ...node, manifest: './other.json' },
    { ...node, lock: './npm-shrinkwrap.json' },
    { ...node, lockSha256: 'short' },
    ...[
      '../requirements.lock',
      '/tmp/requirements.lock',
      './a/../requirements.lock',
      './a/./requirements.lock',
      './a//requirements.lock',
      './a\\requirements.lock',
      './a/%2e%2e/requirements.lock',
      './requirements.lock\n'
    ].map((requirements) => ({ ...python, requirements }))
  ])
    assert.equal(validateSpec(spec(installation)), false, JSON.stringify(installation))
})

test('application commands must be plain binary names and cannot shadow managed runtime tools', () => {
  for (const executable of [
    '/bin/server',
    '../server',
    './server',
    'bin/server',
    'server arg',
    'server\n',
    'server\0',
    'python',
    'python3',
    'python3.12',
    'Python3',
    'pip',
    'pip3',
    'pip3.12',
    'node',
    'nodejs',
    'npm',
    'npx',
    'uv',
    'uvx',
    'micromamba',
    'conda',
    'mamba',
    'R',
    'Rscript'
  ]) {
    assert.equal(validateSpec(spec({ ...python, executable })), false, executable)
  }
})

test('native applications require bounded, pinned artifacts and format-appropriate safe members', () => {
  const artifact = native.backend === 'native' ? native.artifacts['linux-x64']! : assert.fail()
  for (const mutation of [
    { url: 'http://releases.example.test/server' },
    { url: 'https://user:secret@releases.example.test/server' },
    { url: 'https://releases.example.test/server#hash' },
    { url: 'https:///server' },
    { url: 'https://releases.example.test:invalid/server' },
    { url: 'https://releases.example.test/server\n' },
    { sha256: 'not-a-digest' },
    { size: undefined },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { format: 'tgz' },
    { member: undefined },
    { member: '/bin/server' },
    { member: '../server' },
    { member: 'a/../server' },
    { member: 'a/./server' },
    { member: 'a//server' },
    { member: 'a\\server' },
    { member: 'C:/server' },
    { member: 'a/%2e%2e/server' },
    { format: 'file', member: 'server' },
    { extra: true }
  ]) {
    assert.equal(
      validateSpec(spec({ ...native, artifacts: { 'linux-x64': { ...artifact, ...mutation } } })),
      false,
      JSON.stringify(mutation)
    )
  }
  assert.equal(validateSpec(spec({ ...native, artifacts: {} })), false)
  assert.equal(validateSpec(spec({ ...native, artifacts: { 'win32-x64': artifact } })), false)
  assert.equal(
    validateSpec(spec({ ...native, artifacts: { 'linux-x64': { ...artifact, format: 'zip' } } })),
    true
  )
})

test('native URL parsing rejects invalid ports and malformed IPv6 hosts before installation', () => {
  const artifact = native.backend === 'native' ? native.artifacts['linux-x64']! : assert.fail()
  for (const url of [
    'https://example.test:99999/server',
    'https://[.]/server',
    'https://[invalid]/server'
  ]) {
    const parsed = parseEnvironmentSpec(
      stringify(spec({ ...native, artifacts: { 'linux-x64': { ...artifact, url } } }))
    )
    assert.equal(parsed.ok, false, url)
    if (!parsed.ok) assert.match(parsed.errors.join('; '), /url/)
  }
  assert.equal(
    parseEnvironmentSpec(
      stringify(
        spec({
          ...native,
          artifacts: { 'linux-x64': { ...artifact, url: 'https://[::1]:443/server' } }
        })
      )
    ).ok,
    true
  )
})

test('undeclared runtimes retain nonempty array requirements while explicit locks preserve legacy validation', () => {
  assert.equal(validateSpec(spec(native, [])), true)
  assert.equal(validateSpec({ ...spec(native, []), channels: [] }), true)
  for (const installation of [undefined, python, node])
    assert.equal(validateSpec(spec(installation, [])), false)
  for (const installation of [undefined, python, node])
    assert.equal(validateSpec({ ...spec(installation), channels: [] }), false)
  assert.deepEqual(parseExplicitLock('@EXPLICIT\n'), { ok: true, entries: [] })
  assert.deepEqual(parseExplicitLock('# Native application\n@EXPLICIT\n', { allowEmpty: true }), {
    ok: true,
    entries: []
  })
  assert.equal(parseExplicitLock('# no header\n', { allowEmpty: true }).ok, false)
  assert.equal(parseExplicitLock('@OTHER\n', { allowEmpty: true }).ok, false)
  assert.equal(
    parseExplicitLock('@EXPLICIT\nhttp://example.test/a#bad\n', { allowEmpty: true }).ok,
    false
  )
})

test('application identity includes canonical installation input while preserving every legacy hash', () => {
  const input = {
    scope: 'mcp' as const,
    owner: 'demo',
    name: 'application',
    platform: 'linux-x64' as const,
    lockText: '@EXPLICIT\nhttps://example.test/python.conda#0123456789abcdef0123456789abcdef\n'
  }
  const canonicalLegacy = JSON.stringify({
    lockSha256: lockSha256(input.lockText),
    platform: input.platform,
    sourcePackages: []
  })
  const legacy = `mcp-demo-application-${createHash('sha256').update(canonicalLegacy).digest('hex').slice(0, 12)}`
  assert.equal(computeEnvId(input), legacy)
  assert.equal(computeEnvId({ ...input, installation: undefined }), legacy)
  const pythonId = computeEnvId({ ...input, installation: python })
  assert.notEqual(pythonId, legacy)
  assert.notEqual(
    computeEnvId({ ...input, installation: node }),
    computeEnvId({ ...input, installation: { ...node, runtime: 'bun' } })
  )
  assert.equal(
    pythonId,
    computeEnvId({
      ...input,
      installation: {
        executable: python.executable,
        requirementsSha256: SHA_A,
        requirements: './requirements.lock',
        backend: 'python-uv'
      }
    })
  )
  for (const installation of [
    { ...python, requirementsSha256: SHA_B },
    { ...python, requirements: './other.lock' },
    { ...python, executable: 'other-server' },
    node,
    native
  ])
    assert.notEqual(computeEnvId({ ...input, installation }), pythonId)
  const first = {
    backend: 'native' as const,
    executable: 'server',
    artifacts: {
      'linux-x64': {
        url: 'https://example.test/server',
        sha256: SHA_A,
        size: 1,
        format: 'file' as const
      },
      'darwin-arm64': {
        url: 'https://example.test/mac',
        sha256: SHA_B,
        size: 2,
        format: 'file' as const
      }
    }
  }
  const reversed = {
    ...first,
    artifacts: {
      'darwin-arm64': first.artifacts['darwin-arm64'],
      'linux-x64': first.artifacts['linux-x64']
    }
  }
  assert.equal(
    computeEnvId({ ...input, installation: first }),
    computeEnvId({ ...input, installation: reversed })
  )
  for (const mutation of [
    { url: 'https://example.test/server-v2' },
    { sha256: SHA_B },
    { size: 2 },
    { format: 'zip' as const, member: 'server' }
  ]) {
    const changed = {
      ...first,
      artifacts: {
        ...first.artifacts,
        'linux-x64': { ...first.artifacts['linux-x64'], ...mutation }
      }
    }
    assert.notEqual(
      computeEnvId({ ...input, installation: first }),
      computeEnvId({ ...input, installation: changed })
    )
  }
})

test('application metadata preserves micromamba version requirements outside the native engine', () => {
  const installMetadata = {
    backend: 'native',
    executable: '/managed/env/bin/server',
    specSha256: SHA_A,
    artifacts: [{ key: 'linux-x64', sha256: SHA_B, size: 123 }]
  }
  const legacy = metadata()
  assert.equal(validateMetadata(legacy), true)
  const withoutVersion = { ...legacy }
  delete withoutVersion.micromambaVersion
  assert.equal(validateMetadata(withoutVersion), false)
  assert.equal(validateMetadata({ ...legacy, installation: installMetadata }), true)
  assert.equal(
    validateMetadata({ ...withoutVersion, runtimeEngine: 'native', installation: installMetadata }),
    true
  )
  assert.equal(validateMetadata({ ...withoutVersion, installation: installMetadata }), false)
  assert.equal(validateMetadata({ ...withoutVersion, runtimeEngine: 'native' }), false)
  assert.equal(
    validateMetadata({
      ...withoutVersion,
      runtimeEngine: 'native',
      installation: { ...installMetadata, backend: 'python-uv' }
    }),
    false
  )
  assert.equal(
    validateMetadata({
      ...legacy,
      runtimeEngine: 'micromamba',
      installation: { ...installMetadata, backend: 'javascript-bun' }
    }),
    true
  )
  for (const installation of [
    { ...installMetadata, extra: true },
    { ...installMetadata, executable: 'python' },
    { ...installMetadata, specSha256: 'bad' },
    { ...installMetadata, artifacts: [{ key: 'test', sha256: 'bad', size: 1 }] },
    { ...installMetadata, artifacts: [{ key: 'test', sha256: SHA_A, size: -1 }] },
    { ...installMetadata, artifacts: [{ key: 'test', sha256: SHA_A, size: 1, extra: true }] }
  ])
    assert.equal(validateMetadata({ ...legacy, installation }), false, JSON.stringify(installation))
})

test('published application schemas match runtime objects and declare contract 1.4.0', () => {
  assert.deepEqual(
    JSON.parse(readFileSync(resolve('docs/contracts/environment.schema.json'), 'utf8')),
    environmentSpecSchema
  )
  assert.deepEqual(
    JSON.parse(readFileSync(resolve('docs/contracts/env-metadata.schema.json'), 'utf8')),
    envMetadataSchema
  )
  assert.equal(ENVIRONMENT_CONTRACT_VERSION, '1.4.0')
})

test('resolved package metadata records bounded exact Python and Node versions without unknown fields', () => {
  const installation = {
    backend: 'python-uv',
    executable: '/managed/env/bin/server',
    specSha256: SHA_A,
    artifacts: [],
    packages: [{ name: 'biomcp-cli', version: '1.2.3rc1.post2+cpu' }]
  }
  assert.equal(validateMetadata({ ...metadata(), installation }), true)
  assert.equal(
    validateMetadata({
      ...metadata(),
      installation: {
        ...installation,
        backend: 'javascript-bun',
        packages: [{ name: '@scope/package', version: '1.2.3-beta.1+build.2' }]
      }
    }),
    true
  )
  for (const pkg of [
    { name: '', version: '1.0.0' },
    { name: 'package', version: '' },
    { name: 'package', version: 'latest' },
    { name: 'package', version: '^1.0.0' },
    { name: 'package', version: '1.x' },
    { name: 'package', version: '1.0.*' },
    { name: 'package', version: '1.0.0', extra: true },
    { name: 'a'.repeat(215), version: '1.0' },
    { name: 'package', version: '1'.repeat(129) }
  ])
    assert.equal(
      validateMetadata({ ...metadata(), installation: { ...installation, packages: [pkg] } }),
      false,
      JSON.stringify(pkg)
    )
})

test('Bun JavaScript descriptors accept both pinned lock formats and an explicit managed Node runtime override', () => {
  const javascript = {
    backend: 'javascript-bun',
    manifest: './package.json',
    manifestSha256: SHA_A,
    lock: './bun.lock',
    lockSha256: SHA_B,
    executable: 'js-server'
  }
  for (const installation of [
    javascript,
    { ...javascript, runtime: 'bun' },
    { ...javascript, runtime: 'node' },
    { ...javascript, lock: './package-lock.json' }
  ])
    assert.equal(validateSpec(spec(installation)), true, JSON.stringify(installation))
  for (const installation of [
    { ...javascript, runtime: 'host-bun' },
    { ...javascript, runtime: 'npm' },
    { ...javascript, runtime: 'bun@latest' },
    { ...javascript, lock: './bun.lockb' },
    { ...javascript, lock: '../bun.lock' },
    { ...javascript, command: 'bun install' },
    { ...javascript, executable: 'bun' },
    { ...javascript, executable: 'bunx' }
  ])
    assert.equal(validateSpec(spec(installation)), false, JSON.stringify(installation))
})

test('application installer receipts record an exact tool version without unknown fields', () => {
  const installation = {
    backend: 'javascript-bun',
    executable: '/managed/env/bin/js-server',
    specSha256: SHA_A,
    artifacts: [],
    installer: { name: 'bun', version: '1.3.14' }
  }
  assert.equal(validateMetadata({ ...metadata(), installation }), true)
  assert.equal(
    validateMetadata({
      ...metadata(),
      installation: {
        ...installation,
        backend: 'python-uv',
        installer: { name: 'uv', version: '0.8.6' }
      }
    }),
    true
  )
  for (const installer of [
    { name: 'npm', version: '1.0.0' },
    { name: 'bun', version: 'latest' },
    { name: 'bun', version: '^1.3.14' },
    { name: 'bun', version: '1.x' },
    { name: 'bun', version: '' },
    { name: 'bun', version: '1.3.14', extra: true }
  ])
    assert.equal(
      validateMetadata({ ...metadata(), installation: { ...installation, installer } }),
      false,
      JSON.stringify(installer)
    )
})

test('declared runtime tools permit pure Bun artifact environments only with the complete runtime selection', () => {
  const artifact = {
    url: 'https://fixtures.invalid/bun.zip',
    sha256: SHA_A,
    size: 123,
    format: 'zip',
    member: 'bun/bin/bun'
  }
  const bun = { version: '1.3.14', artifacts: { 'linux-x64': artifact } }
  const nodeTool = {
    version: '22.11.0',
    artifacts: {
      'linux-x64': {
        ...artifact,
        url: 'https://fixtures.invalid/node.tar.gz',
        format: 'tar.gz',
        member: 'node/bin/node'
      }
    }
  }
  const javascript = { ...node, runtime: 'bun', bun }
  assert.equal(validateSpec({ ...spec(javascript, []), channels: [] }), true)
  assert.equal(
    validateSpec({ ...spec({ ...javascript, runtime: 'node', node: nodeTool }, []), channels: [] }),
    true
  )
  assert.equal(
    validateSpec({ ...spec({ ...javascript, runtime: 'node' }, []), channels: [] }),
    false
  )
  assert.equal(
    validateSpec({ ...spec({ ...javascript, bun: undefined }, []), channels: [] }),
    false
  )
  assert.equal(validateSpec(spec({ ...javascript, node: nodeTool })), false)
  for (const bad of [
    { ...bun, version: 'latest' },
    { ...bun, version: '^1.3.14' },
    { ...bun, version: '1.3' },
    { ...bun, artifacts: {} },
    { ...bun, extra: true },
    { ...bun, artifacts: { 'linux-x64': { ...artifact, sha256: 'bad' } } }
  ])
    assert.equal(validateSpec(spec({ ...javascript, bun: bad })), false, JSON.stringify(bad))
  const legacyRuntime = spec({ ...node, runtime: 'node' })
  assert.equal(
    validateSpec(legacyRuntime),
    true,
    'existing managed runtime supplied by Conda remains valid'
  )
})

test('pure artifact JavaScript metadata can use the native runtime engine without a micromamba version', () => {
  const value = metadata()
  delete value.micromambaVersion
  const installation = {
    backend: 'javascript-bun',
    executable: '/managed/env/bin/js-server',
    specSha256: SHA_A,
    artifacts: [],
    installer: { name: 'bun', version: '1.3.14' }
  }
  assert.equal(validateMetadata({ ...value, runtimeEngine: 'native', installation }), true)
  assert.equal(
    validateMetadata({
      ...value,
      runtimeEngine: 'native',
      installation: { ...installation, backend: 'python-uv' }
    }),
    false
  )
})
