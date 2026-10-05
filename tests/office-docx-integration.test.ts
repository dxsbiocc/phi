import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { releaseTransientOfficeResident } from '../src/main/agent/office/office-process'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}
const CLI_ENV = officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function wordDocumentXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'word/document.xml'], {
    encoding: 'utf8'
  })
}

async function cli(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await runOfficeCli(binary!, [...args, '--json'], {
    timeoutMs: 30_000,
    env: CLI_ENV
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const value = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(value.success, true)
  return value
}

async function waitForHtml(url: string, expected: string): Promise<string> {
  const deadline = Date.now() + 8_000
  let html = ''
  while (Date.now() < deadline) {
    html = await (await fetch(url)).text()
    if (html.includes(expected)) return html
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`DOCX preview did not contain ${expected}`)
}

async function waitForDocxEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('DOCX SSE response has no body')
  let body = ''
  try {
    for (;;) {
      const next = await readSseChunk(reader)
      if (next.done) break
      body += new TextDecoder().decode(next.value)
      if (/"action":"(?:full|word-patch)"/u.test(body)) return body
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error('DOCX SSE did not publish full or word-patch')
}

async function readInitialDocxEvents(url: string): Promise<string> {
  const response = await fetch(url)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('DOCX SSE response has no body')
  let body = ''
  try {
    while (!body.includes('selection-update') || !body.includes('mark-update')) {
      const next = await readSseChunk(reader)
      if (next.done) break
      body += new TextDecoder().decode(next.value)
    }
    return body
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DOCX SSE timeout')), 8_000)
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

function createSession(root: string): ReturnType<typeof createPhiSession> {
  return createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

test(
  'real DOCX create, preview update, save, save-as, reopen, and restart recovery form one file lifecycle',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office docx lifecycle '))
    const restoreAgentDir = withAgentDir(root)
    const service = createOfficeService()
    const outputReader = createOfficeService()
    let restarted: ReturnType<typeof createOfficeService> | undefined
    let draftPath = ''
    const outputPath = join(root, '交付文档.docx')
    try {
      const session = createSession(root)
      const created = await service.create({
        requestId: 'create-docx',
        sessionId: session.sessionId,
        projectId: null,
        kind: 'docx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      assert.equal(created.document.kind, 'docx')
      assert.equal(created.document.previewState, 'ready')
      draftPath = created.document.draftPath
      assert.equal(draftPath.endsWith('未命名文档.docx'), true)
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [session.dir]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      assert.equal(opened.document.artifactId, created.document.artifactId)
      const document = opened.document

      const blankHtml = await waitForHtml(document.previewUrl, 'class="page-body"')
      assert.doesNotMatch(blankHtml, /开始写作|示例段落|正文内容/u)
      const validation = await cli(['validate', draftPath])
      assert.equal(validation.success, true)

      const initialEvents = await readInitialDocxEvents(`${document.previewUrl}events`)
      assert.match(initialEvents, /selection-update/u)
      assert.match(initialEvents, /mark-update/u)
      assert.doesNotMatch(initialEvents, /"action":"(?:full|word-patch)"/u)
      const events = await fetch(`${document.previewUrl}events`)
      const eventReceived = waitForDocxEvent(events)
      const paragraph = '中文段落 & <Phi> 生命周期'
      await cli(['add', draftPath, '/body', '--type', 'paragraph', '--prop', `text=${paragraph}`])
      assert.match(await eventReceived, /"action":"(?:full|word-patch)"/u)
      await waitForHtml(document.previewUrl, '中文段落 &amp; &lt;Phi&gt; 生命周期')

      const saved = await service.saveDocument(document.artifactId, session.sessionId)
      assert.equal(saved.saved, true)
      const xml = wordDocumentXml(draftPath)
      assert.match(xml, /中文段落/u)
      assert.match(xml, /&amp;.*&lt;Phi&gt;/u)

      const output = await service.saveAsDocument(
        document.artifactId,
        session.sessionId,
        root,
        outputPath
      )
      assert.equal(output.outputPath, '交付文档.docx')
      assert.equal(output.sha256, digest(outputPath))
      assert.equal(digest(outputPath), digest(draftPath))
      await cli(['validate', outputPath])
      await releaseTransientOfficeResident(binary!, outputPath)

      const reopenedOutput = await outputReader.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: outputPath,
        allowRoots: [root]
      })
      assert.equal(reopenedOutput.state, 'ready')
      if (reopenedOutput.state !== 'ready') throw new Error(reopenedOutput.message)
      assert.equal(reopenedOutput.document.kind, 'docx')
      await waitForHtml(reopenedOutput.document.previewUrl, '中文段落 &amp; &lt;Phi&gt; 生命周期')

      const reused = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [session.dir]
      })
      assert.equal(reused.state, 'ready')
      if (reused.state === 'ready')
        assert.equal(reused.document.artifactId, created.document.artifactId)

      await outputReader.dispose()
      await service.dispose()
      restarted = createOfficeService()
      const recovered = await restarted.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [session.dir]
      })
      assert.equal(recovered.state, 'ready')
      if (recovered.state !== 'ready') throw new Error(recovered.message)
      assert.equal(recovered.document.artifactId, created.document.artifactId)
      assert.equal(recovered.restoreNotice?.kind, 'recovered')
      assert.equal(recovered.document.kind, 'docx')
    } finally {
      await restarted?.dispose().catch(() => undefined)
      await outputReader.dispose().catch(() => undefined)
      await service.dispose().catch(() => undefined)
      if (draftPath) await releaseTransientOfficeResident(binary!, draftPath).catch(() => undefined)
      await releaseTransientOfficeResident(binary!, outputPath).catch(() => undefined)
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'a real Chinese multi-paragraph DOCX opens as isolated drafts in two sessions',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office docx source '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, '项目文档.docx')
    const service = createOfficeService()
    try {
      await cli(['create', sourcePath])
      await cli(['add', sourcePath, '/body', '--type', 'paragraph', '--prop', 'text=第一段中文'])
      await cli(['add', sourcePath, '/body', '--type', 'paragraph', '--prop', 'text=第二段中文'])
      await cli(['save', sourcePath])
      await releaseTransientOfficeResident(binary!, sourcePath)
      const sourceHash = digest(sourcePath)
      const firstSession = createSession(root)
      const secondSession = createSession(root)

      const [first, second] = await Promise.all(
        [firstSession, secondSession].map((session) =>
          service.open({
            sessionId: session.sessionId,
            projectId: null,
            sourcePath,
            allowRoots: [root]
          })
        )
      )
      assert.equal(first.state, 'ready')
      assert.equal(second.state, 'ready')
      if (first.state !== 'ready' || second.state !== 'ready') throw new Error('DOCX open failed')
      assert.notEqual(first.document.artifactId, second.document.artifactId)
      assert.notEqual(first.document.draftPath, second.document.draftPath)
      assert.equal(first.document.kind, 'docx')
      assert.equal(second.document.kind, 'docx')
      await waitForHtml(first.document.previewUrl, '第一段中文')
      await waitForHtml(second.document.previewUrl, '第二段中文')
      assert.equal(digest(sourcePath), sourceHash)
    } finally {
      await service.dispose().catch(() => undefined)
      await releaseTransientOfficeResident(binary!, sourcePath).catch(() => undefined)
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'a renamed XLSX is rejected as DOCX before creating an artifact directory',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office docx mismatch '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, '伪装.docx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    const service = createOfficeService()
    try {
      const session = createSession(root)
      const result = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      assert.equal(result.state, 'error')
      if (result.state !== 'error') throw new Error('mismatched package unexpectedly opened')
      assert.equal(result.code, 'inspection_failed')
      const artifactRoot = join(session.dir, 'artifacts', 'office')
      assert.deepEqual(existsSync(artifactRoot) ? readdirSync(artifactRoot) : [], [])
    } finally {
      await service.dispose().catch(() => undefined)
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
