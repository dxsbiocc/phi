import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listWrapperCompositionCatalog } from '../src/main/agent/wrappers/composition/discovery'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import {
  checkWrapperStatic,
  collectRemoteUrls,
  probeUrl,
  resolveIncludeTargets
} from '../src/main/agent/wrappers/composition/smoke'

const MANIFEST = `
id: test/modules/demo
name: Demo
summary: A demo wrapper
params:
  bam:
    kind: input
    type: file
    required: true
  outdir:
    kind: output
    type: directory
    required: true
outputs:
  report:
    type: directory
    path: '\${outdir}/demo'
    primary: true
`

const MAIN_NF = `nextflow.enable.dsl = 2
include { DEMO } from '../main.nf'
workflow { DEMO(Channel.empty()) }
`

interface FixtureOptions {
  manifest?: string
  mainNf?: string
  params?: string | null
  skip?: string[]
  dag?: boolean
}

function makeFixture(options: FixtureOptions = {}): {
  entry: Parameters<typeof checkWrapperStatic>[0]
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-smoke-'))
  const componentDir = join(root, 'demo')
  const wrapperDir = join(componentDir, 'wrapper')
  mkdirSync(wrapperDir, { recursive: true })
  writeFileSync(join(componentDir, 'main.nf'), 'process DEMO { }\n')
  const manifestText = options.manifest ?? MANIFEST
  const files: Record<string, string | null> = {
    'wrapper.yaml': manifestText,
    'main.nf': options.mainNf ?? MAIN_NF,
    'params.json':
      options.params === undefined
        ? JSON.stringify({ bam: 'https://example.org/test.bam', outdir: 'results' })
        : options.params,
    'dag.mmd': options.dag === false ? null : 'flowchart TD\n'
  }
  for (const [name, content] of Object.entries(files)) {
    if (content === null || options.skip?.includes(name)) continue
    writeFileSync(join(wrapperDir, name), content)
  }
  return {
    entry: { manifest: parseWrapperCompositionManifest(manifestText), wrapperDir, componentDir },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function messages(
  issues: ReturnType<typeof checkWrapperStatic>,
  level: 'error' | 'warn'
): string[] {
  return issues.filter((issue) => issue.level === level).map((issue) => issue.message)
}

test('a well-formed wrapper has no static issues', () => {
  const { entry, cleanup } = makeFixture()
  try {
    assert.deepEqual(checkWrapperStatic(entry), [])
  } finally {
    cleanup()
  }
})

test('missing triad files are reported as errors', () => {
  const { entry, cleanup } = makeFixture({ skip: ['params.json'] })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('params.json')))
  } finally {
    cleanup()
  }
})

test('malformed params.json is an error, not a crash', () => {
  const { entry, cleanup } = makeFixture({ params: '{ not json' })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('params.json')))
  } finally {
    cleanup()
  }
})

test('default params that fail wrapper.yaml validation are errors', () => {
  const { entry, cleanup } = makeFixture({ params: JSON.stringify({ outdir: 'results' }) })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('Missing required parameter: bam')))
  } finally {
    cleanup()
  }
})

test('an include that points at a missing file is an error', () => {
  const { entry, cleanup } = makeFixture({
    mainNf: "include { GONE } from '../nope.nf'\nworkflow { }\n"
  })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('../nope.nf')))
  } finally {
    cleanup()
  }
})

test('an include may omit the .nf extension', () => {
  const { entry, cleanup } = makeFixture({
    mainNf: "include { DEMO } from '../main'\nworkflow { }\n"
  })
  try {
    assert.deepEqual(messages(checkWrapperStatic(entry), 'error'), [])
  } finally {
    cleanup()
  }
})

test('a wrapper that includes another wrapper adapter is an error', () => {
  const { entry, cleanup } = makeFixture({
    mainNf: "include { DEMO } from './main.nf'\nworkflow { }\n"
  })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('another wrapper')))
  } finally {
    cleanup()
  }
})

test('a wrapper without a primary output is an error', () => {
  const noPrimary = MANIFEST.replace('primary: true', 'primary: false')
  const { entry, cleanup } = makeFixture({ manifest: noPrimary })
  try {
    const errors = messages(checkWrapperStatic(entry), 'error')
    assert.ok(errors.some((message) => message.includes('primary')))
  } finally {
    cleanup()
  }
})

test('a missing dag.mmd is only a warning', () => {
  const { entry, cleanup } = makeFixture({ dag: false })
  try {
    const issues = checkWrapperStatic(entry)
    assert.deepEqual(messages(issues, 'error'), [])
    assert.ok(messages(issues, 'warn').some((message) => message.includes('dag.mmd')))
  } finally {
    cleanup()
  }
})

test('resolveIncludeTargets returns relative include paths and skips plugins', () => {
  const text = `
include { A } from '../main.nf'
include { B; C as D } from "../../x/main"
include { validateParameters } from 'plugin/nf-schema'
`
  assert.deepEqual(resolveIncludeTargets(text), ['../main.nf', '../../x/main'])
})

test('collectRemoteUrls finds http(s) values, including in arrays, once each', () => {
  const urls = collectRemoteUrls({
    a: 'https://example.org/a.bam',
    b: ['http://example.org/b.fq', 'https://example.org/a.bam', 'local/file'],
    c: 3,
    d: 's3://bucket/key'
  })
  assert.deepEqual(urls.sort(), ['http://example.org/b.fq', 'https://example.org/a.bam'])
})

test('probeUrl reports ok for 2xx and the status for failures', async () => {
  const ok = await probeUrl('https://x', {
    fetchImpl: async () => new Response(null, { status: 200 })
  })
  assert.equal(ok.ok, true)
  const gone = await probeUrl('https://x', {
    fetchImpl: async () => new Response(null, { status: 404 })
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.status, 404)
})

test('probeUrl falls back to a ranged GET when HEAD is rejected', async () => {
  const methods: string[] = []
  const result = await probeUrl('https://x', {
    fetchImpl: async (_url, init) => {
      methods.push(String(init?.method))
      return new Response(null, { status: init?.method === 'HEAD' ? 405 : 206 })
    }
  })
  assert.deepEqual(methods, ['HEAD', 'GET'])
  assert.equal(result.ok, true)
})

test('probeUrl turns a network failure into a failed result', async () => {
  const result = await probeUrl('https://x', {
    retryDelayMs: 0,
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /ENOTFOUND/)
})

test('probeUrl retries a transient network failure and then succeeds', async () => {
  let calls = 0
  const result = await probeUrl('https://x', {
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error('fetch failed')
      return new Response(null, { status: 200 })
    }
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test('probeUrl retries 5xx and 429 but never a 404', async () => {
  const seen: number[] = []
  const flaky = await probeUrl('https://x', {
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      seen.push(1)
      return new Response(null, {
        status: seen.length < 3 ? 503 : init?.method === 'HEAD' ? 200 : 206
      })
    }
  })
  assert.equal(flaky.ok, true)

  let notFoundCalls = 0
  const gone = await probeUrl('https://x', {
    retryDelayMs: 0,
    fetchImpl: async () => {
      notFoundCalls += 1
      return new Response(null, { status: 404 })
    }
  })
  assert.equal(gone.ok, false)
  // one attempt = HEAD then the ranged-GET fallback; a 404 must not trigger another attempt
  assert.equal(notFoundCalls, 2)
})

test('probeUrl gives up after the retry budget on a persistent failure', async () => {
  let calls = 0
  const result = await probeUrl('https://x', {
    retries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      throw new Error('ECONNRESET')
    }
  })
  assert.equal(result.ok, false)
  assert.equal(calls, 3)
})

test('every bundled wrapper passes the static smoke checks', () => {
  const entries = listWrapperCompositionCatalog()
  assert.ok(entries.length > 0)
  const failures = entries.flatMap((entry) =>
    checkWrapperStatic(entry)
      .filter((issue) => issue.level === 'error')
      .map((issue) => `${entry.manifest.id}: ${issue.message}`)
  )
  assert.deepEqual(failures, [])
})
