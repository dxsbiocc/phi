import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import Ajv from 'ajv'

import {
  ENVIRONMENT_CONTRACT_VERSION,
  PHI_PLATFORMS,
  canTransition,
  computeEnvId,
  condaSpecOf,
  condaSubdir,
  currentPlatform,
  envMetadataSchema,
  environmentSpecSchema,
  lockSha256,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock
} from '../src/main/agent/envs'

const SHA_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SHA_B = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
const GITHUB_REF = '5a3b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3'
const MD5 = '0123456789abcdef0123456789abcdef'
const PACKAGE_URL = `https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.0-h123.conda#${MD5}`

const validSpecYaml = `
name: viz
channels:
  - conda-forge
  - bioconda
dependencies:
  - r-base=4.4
  - pip:
      - numpy==2.1.0
description: visualization environment
host:
  - name: soffice
    description: LibreOffice
    platforms:
      - darwin-arm64
      - darwin-x64
    candidates:
      - /Applications/LibreOffice.app/Contents/MacOS/soffice
sourcePackages:
  - language: r
    name: ggsankey
    source: github
    repo: davidsjoberg/ggsankey
    ref: ${GITHUB_REF}
    sha256: ${SHA_A}
  - language: r
    name: ggplot2
    source: cran
    ref: 3.5.1
    sha256: ${SHA_B}
`

function expectInvalid(yaml: string, pattern: RegExp): void {
  const result = parseEnvironmentSpec(yaml)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    result.errors.join('\n')
  )
}

test('a spec with host requirements and both source package kinds parses', () => {
  const result = parseEnvironmentSpec(validSpecYaml)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.name, 'viz')
  assert.deepEqual(result.spec.channels, ['conda-forge', 'bioconda'])
  assert.deepEqual(result.spec.dependencies, ['r-base=4.4', { pip: ['numpy==2.1.0'] }])
  assert.equal(result.spec.description, 'visualization environment')
  assert.deepEqual(result.spec.host, [
    {
      name: 'soffice',
      description: 'LibreOffice',
      platforms: ['darwin-arm64', 'darwin-x64'],
      candidates: ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    }
  ])
  assert.deepEqual(result.spec.sourcePackages, [
    {
      language: 'r',
      name: 'ggsankey',
      source: 'github',
      repo: 'davidsjoberg/ggsankey',
      ref: GITHUB_REF,
      sha256: SHA_A
    },
    {
      language: 'r',
      name: 'ggplot2',
      source: 'cran',
      ref: '3.5.1',
      sha256: SHA_B
    }
  ])
})

test('invalid specs are rejected', () => {
  expectInvalid(validSpecYaml.replace('name: viz', 'name: Viz'), /name/)
  expectInvalid(validSpecYaml.replace('channels:\n  - conda-forge\n  - bioconda\n', ''), /channels/)
  expectInvalid(validSpecYaml.replace(GITHUB_REF, 'main'), /ref/)
  expectInvalid(validSpecYaml.replace('    repo: davidsjoberg/ggsankey\n', ''), /repo/)
  expectInvalid(
    validSpecYaml.replace(
      '    source: cran\n    ref: 3.5.1',
      '    source: cran\n    repo: cran/ggplot2\n    ref: 3.5.1'
    ),
    /repo/
  )
  expectInvalid(validSpecYaml.replace('ref: 3.5.1', 'ref: 3.5.1.2.3'), /ref/)
  expectInvalid(validSpecYaml.replace(SHA_B, 'deadbeef'), /sha256/)
  expectInvalid(`${validSpecYaml}prefix: /tmp/env\n`, /prefix/)
})

test('condaSpecOf strips Phi sections and description', () => {
  const result = parseEnvironmentSpec(validSpecYaml)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const conda = condaSpecOf(result.spec)
  assert.deepEqual(conda, {
    name: 'viz',
    channels: ['conda-forge', 'bioconda'],
    dependencies: ['r-base=4.4', { pip: ['numpy==2.1.0'] }]
  })
  assert.equal(Object.hasOwn(conda, 'host'), false)
  assert.equal(Object.hasOwn(conda, 'sourcePackages'), false)
  assert.equal(Object.hasOwn(conda, 'description'), false)
})

test('explicit locks accept https URLs with an md5 fragment', () => {
  const text = `# platform: osx-arm64\n\n@EXPLICIT\n${PACKAGE_URL}\n`
  assert.deepEqual(parseExplicitLock(text), {
    ok: true,
    entries: [{ url: PACKAGE_URL, md5: MD5 }]
  })
})

test('explicit locks reject a missing header, non-https URLs, and a bad md5', () => {
  const missing = parseExplicitLock(`${PACKAGE_URL}\n`)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.errors.join('\n'), /@EXPLICIT/)

  const http = parseExplicitLock(`@EXPLICIT\nhttp://example.com/a.conda#${MD5}\n`)
  assert.equal(http.ok, false)
  if (!http.ok) assert.match(http.errors.join('\n'), /https/)

  const short = parseExplicitLock(`@EXPLICIT\nhttps://example.com/a.conda#${MD5.slice(1)}\n`)
  assert.equal(short.ok, false)
  if (!short.ok) assert.match(short.errors.join('\n'), /md5/)

  const upper = parseExplicitLock(`@EXPLICIT\nhttps://example.com/a.conda#${MD5.toUpperCase()}\n`)
  assert.equal(upper.ok, false)
  if (!upper.ok) assert.match(upper.errors.join('\n'), /md5/)
})

test('lockSha256 ignores comments and CRLF', () => {
  const unix = `@EXPLICIT\n${PACKAGE_URL}\n`
  const crlf = `# comment\r\n@EXPLICIT\r\n${PACKAGE_URL}\r\n`
  assert.equal(lockSha256(unix), lockSha256(crlf))
  assert.equal(lockSha256(unix), lockSha256(`\n@EXPLICIT\n\n  ${PACKAGE_URL}  \n\n`))
  assert.notEqual(
    lockSha256(unix),
    lockSha256(`@EXPLICIT\nhttps://example.com/other.conda#${MD5}\n`)
  )
})

test('computeEnvId is stable and tracks the lock and source packages', () => {
  const parsed = parseEnvironmentSpec(validSpecYaml)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const lockText = `@EXPLICIT\n${PACKAGE_URL}\n`
  const input = {
    scope: 'plugin' as const,
    owner: 'visualization',
    name: 'viz',
    platform: 'darwin-arm64' as const,
    lockText,
    sourcePackages: parsed.spec.sourcePackages
  }
  const id = computeEnvId(input)
  assert.equal(id, computeEnvId({ ...input }))
  assert.match(id, /^plugin-visualization-viz-[0-9a-f]{12}$/)
  assert.notEqual(
    id,
    computeEnvId({ ...input, lockText: `${lockText}https://example.com/b.conda#${MD5}\n` })
  )
  assert.notEqual(
    id,
    computeEnvId({ ...input, sourcePackages: parsed.spec.sourcePackages?.slice(0, 1) })
  )
  assert.equal(
    computeEnvId({ ...input, sourcePackages: undefined }),
    computeEnvId({ ...input, sourcePackages: [] })
  )

  const phiId = computeEnvId({
    scope: 'phi',
    owner: 'ignored',
    name: 'python',
    platform: 'linux-x64',
    lockText
  })
  assert.match(phiId, /^phi-python-[0-9a-f]{12}$/)
  assert.equal(
    phiId,
    computeEnvId({ scope: 'phi', name: 'python', platform: 'linux-x64', lockText })
  )
  const canonical = JSON.stringify({
    lockSha256: lockSha256(lockText),
    platform: 'linux-x64',
    sourcePackages: []
  })
  const hash12 = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  assert.equal(phiId, `phi-python-${hash12}`)

  assert.throws(
    () => computeEnvId({ scope: 'project', name: 'default', platform: 'linux-x64', lockText }),
    /owner/
  )
})

test('parseEnvironmentRef accepts the four reference forms and rejects the rest', () => {
  assert.deepEqual(parseEnvironmentRef('phi:python@1'), { kind: 'phi', name: 'python', major: 1 })
  assert.deepEqual(parseEnvironmentRef('phi:python@0'), { kind: 'phi', name: 'python', major: 0 })
  assert.deepEqual(parseEnvironmentRef('plugin:viz'), { kind: 'plugin', name: 'viz' })
  assert.deepEqual(parseEnvironmentRef('project:default'), { kind: 'project', name: 'default' })
  assert.deepEqual(parseEnvironmentRef('./environment.yml'), {
    kind: 'path',
    path: './environment.yml'
  })
  assert.deepEqual(parseEnvironmentRef('./envs/viz/environment.yml'), {
    kind: 'path',
    path: './envs/viz/environment.yml'
  })

  for (const ref of [
    'phi:python',
    'phi:Python@1',
    'phi:python@01',
    'phi:python@1.2',
    'plugin:Viz',
    'project:',
    '../environment.yml',
    './a/../b',
    '/tmp/environment.yml',
    'environment.yml',
    'https://example.com/environment.yml',
    ''
  ]) {
    assert.throws(() => parseEnvironmentRef(ref), /environment reference/, ref)
  }
})

test('platforms map to conda subdirs and unsupported hosts throw', () => {
  assert.deepEqual(PHI_PLATFORMS, ['darwin-arm64', 'darwin-x64', 'linux-x64'])
  assert.equal(condaSubdir('darwin-arm64'), 'osx-arm64')
  assert.equal(condaSubdir('darwin-x64'), 'osx-64')
  assert.equal(condaSubdir('linux-x64'), 'linux-64')
  assert.equal(currentPlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(currentPlatform('darwin', 'x64'), 'darwin-x64')
  assert.equal(currentPlatform('linux', 'x64'), 'linux-x64')
  assert.throws(() => currentPlatform('win32', 'x64'), /unsupported platform: win32-x64/)
})

test('environment status only follows the v1 transitions', () => {
  assert.equal(canTransition('absent', 'building'), true)
  assert.equal(canTransition('building', 'ready'), true)
  assert.equal(canTransition('building', 'failed'), true)
  assert.equal(canTransition('ready', 'drifted'), true)
  assert.equal(canTransition('ready', 'building'), true)
  assert.equal(canTransition('drifted', 'building'), true)
  assert.equal(canTransition('failed', 'building'), true)
  assert.equal(canTransition('absent', 'ready'), false)
  assert.equal(canTransition('ready', 'failed'), false)
  assert.equal(canTransition('failed', 'ready'), false)
  assert.equal(canTransition('building', 'drifted'), false)
  assert.equal(canTransition('drifted', 'ready'), false)
})

test('published schemas match the runtime constants', () => {
  const spec = JSON.parse(
    readFileSync(resolve('docs/contracts/environment.schema.json'), 'utf8')
  ) as unknown
  const metadata = JSON.parse(
    readFileSync(resolve('docs/contracts/env-metadata.schema.json'), 'utf8')
  ) as unknown
  assert.deepEqual(spec, environmentSpecSchema)
  assert.deepEqual(metadata, envMetadataSchema)
  assert.equal(ENVIRONMENT_CONTRACT_VERSION, '1.2.0')
})

test('env.json metadata matching the contract validates', () => {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(envMetadataSchema)
  const metadata = {
    envId: 'plugin-visualization-viz-3f9a1c2b7d10',
    name: 'viz',
    kind: 'package',
    platform: 'darwin-arm64',
    lockSha256: SHA_A,
    createdAt: '2026-09-29T09:03:00.000Z',
    micromambaVersion: '2.0.5',
    activation: {
      set: { CONDA_PREFIX: '/Users/me/.phi/runtime/envs/plugin-visualization-viz-3f9a1c2b7d10' },
      pathPrepend: ['/Users/me/.phi/runtime/envs/plugin-visualization-viz-3f9a1c2b7d10/bin']
    },
    host: { soffice: '/Applications/LibreOffice.app/Contents/MacOS/soffice' },
    sourcePackages: [
      {
        language: 'r',
        name: 'ggsankey',
        source: 'github',
        repo: 'davidsjoberg/ggsankey',
        ref: GITHUB_REF,
        sha256: SHA_A
      }
    ],
    status: 'ready',
    contractVersion: '1.0.0'
  }
  assert.equal(validate(metadata), true)
  assert.equal(validate({ ...metadata, status: 'installed' }), false)
})

test('computeEnvId rejects names and owners that would break the envId format', () => {
  const lockText = `@EXPLICIT\n${PACKAGE_URL}\n`
  assert.throws(() =>
    computeEnvId({ scope: 'phi', name: 'Python', platform: 'darwin-arm64', lockText })
  )
  assert.throws(() =>
    computeEnvId({
      scope: 'plugin',
      owner: 'Viz/x',
      name: 'viz',
      platform: 'darwin-arm64',
      lockText
    })
  )
})

test('specs need at least one dependency and host names are plain commands', () => {
  const base = 'name: demo\nchannels: [conda-forge]\n'
  assert.equal(parseEnvironmentSpec(`${base}dependencies: []\n`).ok, false)
  assert.equal(
    parseEnvironmentSpec(`${base}dependencies: [python]\nhost:\n  - name: /usr/bin/soffice\n`).ok,
    false
  )
  assert.equal(
    parseEnvironmentSpec(`${base}dependencies: [python]\nhost:\n  - name: soffice\n`).ok,
    true
  )
})

test('skill scope envIds carry the skill name as owner (contract 1.1.0)', () => {
  const lockText = `@EXPLICIT\n${PACKAGE_URL}\n`
  const id = computeEnvId({
    scope: 'skill',
    owner: 'scanpy',
    name: 'scanpy',
    platform: 'darwin-arm64',
    lockText
  })
  assert.match(id, /^skill-scanpy-scanpy-[0-9a-f]{12}$/)
  assert.throws(() =>
    computeEnvId({ scope: 'skill', name: 'scanpy', platform: 'darwin-arm64', lockText })
  )
  assert.equal(ENVIRONMENT_CONTRACT_VERSION, '1.2.0')
})
