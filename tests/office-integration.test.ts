import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import {
  detectOfficeRuntime,
  officeBinaryCandidates
} from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { createPhiSession } from '../src/main/agent/session/session-store'

// Real-binary checks. Run with PHI_OFFICE_INTEGRATION=1 after `bun run office:fetch`.
const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const bundled = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!bundled && existsSync(bundled)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

interface Cell {
  text: string
  format: { evaluated?: boolean }
  code?: string
}

interface Envelope {
  success: boolean
  data: { results: Cell[]; summary?: { atomicRolledBack?: boolean } }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function lsof(...args: string[]): string {
  try {
    return execFileSync('/usr/sbin/lsof', args, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function assertLoopbackListener(port: number): void {
  const listeners = lsof('-nP', `-iTCP:${port}`, '-sTCP:LISTEN')
  assert.match(listeners, new RegExp(`TCP 127\\.0\\.0\\.1:${port} \\(LISTEN\\)`))
  assert.doesNotMatch(listeners, /TCP (?:\*|\[::\]):/)
}

function assertNoOfficeResources(ports: readonly number[], paths: readonly string[]): void {
  for (const port of ports) {
    if (port) assert.equal(lsof('-nP', `-iTCP:${port}`, '-sTCP:LISTEN'), '')
  }
  for (const path of paths) {
    if (path) assert.equal(lsof('-t', '-a', '-c', 'officecli', '--', path), '')
  }
}

async function blankPreviewHtml(url: string): Promise<string> {
  const deadline = Date.now() + 5_000
  let html = ''
  while (Date.now() < deadline) {
    html = await (await fetch(url)).text()
    if (html.includes('Sheet1') && html.includes('class="empty-sheet"')) return html
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error('blank preview did not render Sheet1 and its empty surface')
}

async function waitForPreviewText(url: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await (await fetch(url)).text()).includes(expected)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error(`preview did not render ${expected}`)
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(message)
}

async function waitForSsePatch(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE response has no body')
  const deadline = Date.now() + 5_000
  let text = ''
  while (Date.now() < deadline) {
    const result = await readSseChunk(reader)
    if (result.done) break
    text += new TextDecoder().decode(result.value)
    if (text.includes('excel-patch')) {
      await reader.cancel()
      return text
    }
  }
  throw new Error('SSE did not publish an excel-patch event')
}

function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE read timeout')), 5_000)
    void reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function json(
  binary: string,
  args: string[],
  cwd: string
): Promise<{ exit: number | null; body: Envelope }> {
  const result = await runOfficeCli(binary, [...args, '--json'], { cwd, timeoutMs: 30_000 })
  return { exit: result.exitCode, body: JSON.parse(result.stdout) as Envelope }
}

test(
  'the bundled binary is available at the pinned version from a path with spaces',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office integration '))
    try {
      const copied = join(root, 'bin dir', 'officecli')
      mkdirSync(join(root, 'bin dir'))
      cpSync(bundled!, copied)
      const before = readdirSync(root)
      const status = await detectOfficeRuntime({ candidates: [copied], cwd: root })
      assert.equal(status.state, 'available')
      assert.deepEqual(readdirSync(root), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'contract baseline: JSON envelopes, formula evaluation, and atomic batch rollback',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office baseline '))
    const file = join(root, 'baseline.xlsx')
    try {
      const created = await json(bundled!, ['create', file], root)
      assert.equal(created.exit, 0)
      assert.equal(created.body.success, true)

      for (const [cell, value] of [
        ['A1', '10'],
        ['A2', '20']
      ]) {
        const set = await json(
          bundled!,
          ['set', file, `/Sheet1/${cell}`, '--prop', `value=${value}`],
          root
        )
        assert.equal(set.body.success, true)
      }
      await json(bundled!, ['set', file, '/Sheet1/A3', '--prop', 'formula=SUM(A1:A2)'], root)
      const sum = await json(bundled!, ['get', file, '/Sheet1/A3'], root)
      const cell = sum.body.data.results[0]
      assert.equal(cell.text, '30')
      assert.equal(cell.format.evaluated, true)

      await json(bundled!, ['set', file, '/Sheet1/A4', '--prop', 'formula=NOSUCHFN(A1)'], root)
      const unsupported = (await json(bundled!, ['get', file, '/Sheet1/A4'], root)).body.data
        .results[0]
      assert.equal(unsupported.format.evaluated, false)
      assert.match(unsupported.text, /^#OCLI_NOTEVAL!/)

      const batch = JSON.stringify([
        { command: 'set', path: '/Sheet1/H1', props: { value: 'kept?' } },
        { command: 'set', path: '/Sheet9/Z1', props: { value: 'bad' } }
      ])
      const rolledBack = await json(bundled!, ['batch', file, '--commands', batch], root)
      assert.equal(rolledBack.exit, 1)
      assert.equal(rolledBack.body.success, false)
      assert.equal(rolledBack.body.data.summary?.atomicRolledBack, true)
      assert.equal(rolledBack.body.data.results[1].code, 'not_found')
      // An untouched cell reads back as the literal "(empty)", never the rolled-back value.
      const h1 = (await json(bundled!, ['get', file, '/Sheet1/H1'], root)).body.data.results
      assert.equal(h1[0]?.text, '(empty)')

      await runOfficeCli(bundled!, ['close', file], { cwd: root, timeoutMs: 15_000 })
      assert.ok(statSync(file).size > 0)
    } finally {
      await runOfficeCli(bundled!, ['close', file], { cwd: root, timeoutMs: 15_000 }).catch(
        () => undefined
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'sample fixture contains multiple sheets, Chinese text, and an evaluated SUM formula',
  options,
  async () => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')
    const root = mkdtempSync(join(tmpdir(), 'office fixture integration '))
    const copy = join(root, 'sample.xlsx')
    cpSync(fixture, copy)
    try {
      const workbook = await json(bundled!, ['get', copy, '/', '--depth', '1'], root)
      assert.equal(workbook.body.data.results[0]?.childCount, 2)
      const chinese = await json(bundled!, ['get', copy, '/说明/A2'], root)
      assert.equal(chinese.body.data.results[0]?.text, 'Phi Office 实时预览样例')
      const formula = await json(bundled!, ['get', copy, '/Sheet1/B4'], root)
      assert.equal(formula.body.data.results[0]?.text, '30')
      assert.equal(formula.body.data.results[0]?.format.evaluated, true)
    } finally {
      await runOfficeCli(bundled!, ['close', copy], { cwd: root, timeoutMs: 15_000 }).catch(
        () => undefined
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real service isolates the draft, streams updates, and cleans its owned processes',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office service integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')
    const originalHash = sha256(sourcePath)
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: process.cwd(),
      cwdRealPath: process.cwd(),
      permissionMode: 'auto'
    })
    const service = createOfficeService()
    let watchPort = 0
    let gatewayPort = 0
    let draftPath = ''
    const previewStarted = performance.now()
    try {
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [process.cwd()]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      const { document } = opened
      watchPort = document.watchPort
      gatewayPort = document.gatewayPort
      draftPath = document.draftPath
      await (await fetch(document.previewUrl)).text()
      const hotFirstResponseMs = Math.round(performance.now() - previewStarted)

      assertLoopbackListener(watchPort)
      assertLoopbackListener(gatewayPort)
      const forgedSend = await fetch(`${document.previewUrl}api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/Sheet1/A1', props: { x: 1, y: 2 } })
      })
      assert.equal(forgedSend.status, 400)
      for (const path of ['/api/switch', '/api/batch']) {
        assert.equal(
          (await fetch(`${document.previewUrl.slice(0, -1)}${path}`, { method: 'POST' })).status,
          403
        )
      }

      const events = await fetch(`${document.previewUrl}events`)
      const patch = waitForSsePatch(events)
      const updateStarted = performance.now()
      const changed = await runOfficeCli(
        bundled!,
        ['set', document.draftPath, '/Sheet1/A1', '--prop', 'value=集成更新', '--json'],
        { env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }) }
      )
      assert.equal(changed.exitCode, 0)
      assert.match(await patch, /excel-patch/)
      await waitForPreviewText(document.previewUrl, '集成更新')
      const updateVisibleMs = Math.round(performance.now() - updateStarted)
      assert.equal(sha256(sourcePath), originalHash)
      process.stdout.write(
        `OFFICE_INTEGRATION_BASELINE ${JSON.stringify({ hotFirstResponseMs, updateVisibleMs })}\n`
      )
    } finally {
      await service.dispose()
      if (watchPort) assert.equal(lsof('-nP', `-iTCP:${watchPort}`, '-sTCP:LISTEN'), '')
      if (gatewayPort) assert.equal(lsof('-nP', `-iTCP:${gatewayPort}`, '-sTCP:LISTEN'), '')
      if (draftPath) assert.equal(lsof('-t', '-a', '-c', 'officecli', '--', draftPath), '')
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real service creates independent blank workbooks and releases every owned resource',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office blank integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: process.cwd(),
      cwdRealPath: process.cwd(),
      permissionMode: 'auto'
    })
    const service = createOfficeService()
    const ports: number[] = []
    const draftPaths: string[] = []
    try {
      const first = await service.create({
        requestId: 'blank-integration-1',
        sessionId: session.sessionId,
        projectId: null,
        name: '空白草稿一'
      })
      assert.equal(first.state, 'ready')
      if (first.state !== 'ready') throw new Error(first.message)
      ports.push(first.document.watchPort, first.document.gatewayPort)
      draftPaths.push(first.document.draftPath)
      const firstPreview = await blankPreviewHtml(first.document.previewUrl)
      assert.match(firstPreview, /<div class="empty-sheet">Empty sheet<\/div>/)
      assert.doesNotMatch(firstPreview, /<td[^>]+data-path=/)

      const validation = await json(bundled!, ['validate', first.document.draftPath], root)
      assert.equal(validation.exit, 0)
      assert.equal(validation.body.success, true)
      const firstBytes = readFileSync(first.document.draftPath)

      const attached = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: first.document.draftPath,
        allowRoots: [process.cwd()]
      })
      assert.equal(attached.state, 'ready')
      assert.equal(await service.close(first.document.artifactId, session.sessionId), true)
      const reopened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: first.document.draftPath,
        allowRoots: [process.cwd()]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      assert.equal(reopened.document.artifactId, first.document.artifactId)
      ports.push(reopened.document.watchPort, reopened.document.gatewayPort)
      await blankPreviewHtml(reopened.document.previewUrl)

      const second = await service.create({
        requestId: 'blank-integration-2',
        sessionId: session.sessionId,
        projectId: null,
        name: '空白草稿二'
      })
      assert.equal(second.state, 'ready')
      if (second.state !== 'ready') throw new Error(second.message)
      ports.push(second.document.watchPort, second.document.gatewayPort)
      draftPaths.push(second.document.draftPath)
      await blankPreviewHtml(second.document.previewUrl)

      assert.notEqual(second.document.artifactId, first.document.artifactId)
      assert.notEqual(dirname(second.document.draftPath), dirname(first.document.draftPath))
      assert.notEqual(second.document.watchPort, first.document.watchPort)
      assert.notEqual(second.document.gatewayPort, first.document.gatewayPort)
      assert.deepEqual(readFileSync(first.document.draftPath), firstBytes)

      service.bindRunTarget({
        runId: 'blank-integration-run',
        artifactId: second.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      await service.close(second.document.artifactId, session.sessionId)
      assert.equal(
        service.resolveRunTarget('blank-integration-run', session.sessionId).artifactId,
        second.document.artifactId
      )
      assert.equal(service.clearRunTarget('blank-integration-run'), true)
      assert.throws(() => service.resolveRunTarget('blank-integration-run', session.sessionId), {
        code: 'target_missing'
      })
    } finally {
      await service.dispose()
      assertNoOfficeResources(ports, draftPaths)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real service rejects another session Office artifact as a prompt target',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office target session integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const firstSession = createPhiSession({
      kind: 'ordinary',
      cwd: process.cwd(),
      cwdRealPath: process.cwd(),
      permissionMode: 'auto'
    })
    const secondSession = createPhiSession({
      kind: 'ordinary',
      cwd: process.cwd(),
      cwdRealPath: process.cwd(),
      permissionMode: 'auto'
    })
    const service = createOfficeService()
    const ports: number[] = []
    const draftPaths: string[] = []
    try {
      const first = await service.create({
        requestId: 'target-session-1',
        sessionId: firstSession.sessionId,
        projectId: null,
        name: '会话一'
      })
      const second = await service.create({
        requestId: 'target-session-2',
        sessionId: secondSession.sessionId,
        projectId: null,
        name: '会话二'
      })
      assert.equal(first.state, 'ready')
      assert.equal(second.state, 'ready')
      if (first.state !== 'ready' || second.state !== 'ready') throw new Error('草稿创建失败')
      ports.push(
        first.document.watchPort,
        first.document.gatewayPort,
        second.document.watchPort,
        second.document.gatewayPort
      )
      draftPaths.push(first.document.draftPath, second.document.draftPath)

      assert.throws(
        () =>
          service.bindRunTarget({
            runId: 'foreign-target-run',
            artifactId: second.document.artifactId,
            sessionId: firstSession.sessionId,
            projectId: null
          }),
        { code: 'target_session_mismatch' }
      )
      assert.throws(() => service.resolveRunTarget('foreign-target-run'), { code: 'no_target' })
    } finally {
      await service.dispose()
      assertNoOfficeResources(ports, draftPaths)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real selected cells resolve into an immutable run target and clear back to document-level',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office selection integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: process.cwd(),
      cwdRealPath: process.cwd(),
      permissionMode: 'auto'
    })
    const service = createOfficeService()
    const selections: Array<{ selection: { range?: string } | null }> = []
    const unsubscribe = service.onSelection((event) => selections.push(event))
    let events: Response | undefined
    let watchPort = 0
    let gatewayPort = 0
    let draftPath = ''
    try {
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [process.cwd()]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      const { document } = opened
      watchPort = document.watchPort
      gatewayPort = document.gatewayPort
      draftPath = document.draftPath
      events = await fetch(`${document.previewUrl}events`)

      const firstPaths = [
        '/Sheet1/A1',
        '/Sheet1/B1',
        '/Sheet1/A2',
        '/Sheet1/B2',
        '/Sheet1/A3',
        '/Sheet1/B3'
      ]
      const selected = await fetch(`${document.previewUrl}api/selection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: firstPaths })
      })
      assert.ok(selected.status >= 200 && selected.status < 300)
      await selected.text()
      await waitFor(
        () => selections.some((event) => event.selection?.range === 'A1:B3'),
        'selection SSE did not publish A1:B3'
      )

      await service.bindPromptTarget(
        {
          runId: 'selection-run',
          artifactId: document.artifactId,
          sessionId: session.sessionId,
          projectId: null
        },
        true
      )
      assert.equal(service.resolveRunTarget('selection-run').selection?.range, 'A1:B3')

      await fetch(`${document.previewUrl}api/selection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: ['/Sheet1/A4'] })
      }).then((response) => response.text())
      await waitFor(
        () => selections.some((event) => event.selection?.range === 'A4'),
        'selection SSE did not publish the changed selection'
      )
      assert.equal(service.resolveRunTarget('selection-run').selection?.range, 'A1:B3')

      assert.equal(await service.clearSelection(document.artifactId, session.sessionId), true)
      await service.bindPromptTarget(
        {
          runId: 'document-run',
          artifactId: document.artifactId,
          sessionId: session.sessionId,
          projectId: null
        },
        false
      )
      assert.equal(service.resolveRunTarget('document-run').selection, undefined)
      await assert.rejects(
        service.bindPromptTarget(
          {
            runId: 'cleared-selection-run',
            artifactId: document.artifactId,
            sessionId: session.sessionId,
            projectId: null
          },
          true
        ),
        { code: 'selection_unavailable' }
      )
    } finally {
      unsubscribe()
      await events?.body?.cancel().catch(() => undefined)
      await service.dispose()
      assertNoOfficeResources([watchPort, gatewayPort], [draftPath])
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('officecli create refuses to overwrite an existing target', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office create collision '))
  const target = join(root, 'existing.xlsx')
  const original = Buffer.from('keep-existing-bytes')
  try {
    writeFileSync(target, original)
    const result = await runOfficeCli(bundled!, ['create', target, '--json'], {
      cwd: root,
      timeoutMs: 30_000
    })
    assert.notEqual(result.exitCode, 0)
    const envelope = JSON.parse(result.stdout) as {
      success: boolean
      error?: { code?: string }
    }
    assert.equal(envelope.success, false)
    assert.equal(envelope.error?.code, 'file_exists')
    assert.deepEqual(readFileSync(target), original)
    assert.equal(lsof('-t', '-a', '-c', 'officecli', '--', target), '')
  } finally {
    await runOfficeCli(bundled!, ['close', target], { cwd: root, timeoutMs: 15_000 }).catch(
      () => undefined
    )
    rmSync(root, { recursive: true, force: true })
  }
})
