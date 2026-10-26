import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createToolsReadFixtures,
  runToolsScenario,
  TOOLS_READ_MARKERS,
  type ToolsReadEvidence
} from '../scripts/kernel-e2e/tools-scenario'
import { kernelE2eUsage, parseKernelE2eArgs } from '../scripts/kernel-e2e/options'

function fixture(extension: string): Buffer {
  const entry = createToolsReadFixtures().find((candidate) => candidate.path.endsWith(extension))
  assert.ok(entry, `missing ${extension} fixture`)
  return Buffer.from(entry.content)
}

test('tools scenario fixtures have real PDF, DOCX ZIP, and PNG container signatures', () => {
  const pdf = fixture('.pdf')
  const docx = fixture('.docx')
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.match(pdf.toString(), /startxref/)
  assert.match(pdf.toString(), new RegExp(TOOLS_READ_MARKERS.pdf))
  assert.deepEqual([...docx.subarray(0, 4)], [80, 75, 3, 4])
  assert.match(docx.toString(), /word\/document\.xml/)
  assert.match(docx.toString(), new RegExp(TOOLS_READ_MARKERS.docx))
  assert.deepEqual([...fixture('.png').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})

test('tools scenario writes every fixture, drives native read, and records per-format evidence', async () => {
  const writes = new Map<string, Buffer>()
  const replies: Array<{ text?: string; tool?: { name: string; id: string } }> = []
  const report: { evidence: ToolsReadEvidence } = { evidence: {} }
  await runToolsScenario({
    provider: {
      enqueue: (...items) => replies.push(...items)
    },
    client: {
      async create(cwd, approval) {
        assert.equal(cwd, '/execution/project')
        assert.equal(approval, false)
        return 'tools-session'
      },
      async prompt(sessionId) {
        assert.equal(sessionId, 'tools-session')
        return { runId: 'tools-run', status: 'completed' }
      },
      async snapshot() {
        return {
          messages: [
            result('tools-read-pdf', TOOLS_READ_MARKERS.pdf),
            result('tools-read-docx', 'DOCX\\_NATIVE\\_READ\\_MARKER'),
            result('tools-read-image', 'Image metadata:\n- MIME: image/png\n- Dimensions: 1x1'),
            result('tools-read-directory', TOOLS_READ_MARKERS.directory),
            result('tools-read-home', TOOLS_READ_MARKERS.home)
          ]
        }
      }
    },
    files: {
      projectRoot: '/execution/project',
      projectPath: (relativePath) => `/execution/project/${relativePath}`,
      homePath: (relativePath) => `/execution/home/${relativePath}`,
      async write(path, content) {
        writes.set(path, Buffer.from(content))
      }
    },
    report,
    step: async (_name, action) => action()
  })

  assert.equal(writes.size, 5)
  assert.deepEqual(
    replies.flatMap((reply) => (reply.tool ? [reply.tool.id] : [])),
    [
      'tools-read-pdf',
      'tools-read-docx',
      'tools-read-image',
      'tools-read-directory',
      'tools-read-home'
    ]
  )
  assert.deepEqual(report.evidence.nativeReads, {
    pdf: 'passed',
    docx: 'passed',
    image: 'passed',
    directory: 'passed',
    home: 'passed'
  })
  assert.deepEqual(report.evidence.missingConverters, [])
})

test('tools scenario reports a missing execution-host converter explicitly', async () => {
  const report: { evidence: ToolsReadEvidence } = { evidence: {} }
  await assert.rejects(
    runToolsScenario({
      provider: { enqueue: () => undefined },
      client: {
        async create() {
          return 'tools-session'
        },
        async prompt() {
          return { runId: 'tools-run', status: 'completed' }
        },
        async snapshot() {
          return {
            messages: [
              result(
                'tools-read-pdf',
                '[Cannot read .pdf file: Conversion failed: pdf: native addon was not found]'
              ),
              result('tools-read-docx', TOOLS_READ_MARKERS.docx),
              result('tools-read-image', 'Image metadata:\n- MIME: image/png\n- Dimensions: 1x1'),
              result('tools-read-directory', TOOLS_READ_MARKERS.directory),
              result('tools-read-home', TOOLS_READ_MARKERS.home)
            ]
          }
        }
      },
      files: {
        projectRoot: '/execution/project',
        projectPath: (relativePath) => `/execution/project/${relativePath}`,
        homePath: (relativePath) => `/execution/home/${relativePath}`,
        write: () => Promise.resolve()
      },
      report,
      step: async (_name, action) => action()
    }),
    /Missing PDF converter dependency \(@oh-my-pi\/pi-natives pdfToMarkdown\) on execution host/
  )
  assert.equal(report.evidence.nativeReads?.pdf, 'converter-missing')
  assert.deepEqual(report.evidence.missingConverters, [
    {
      format: 'pdf',
      dependency: '@oh-my-pi/pi-natives pdfToMarkdown',
      reason: '[Cannot read .pdf file: Conversion failed: pdf: native addon was not found]'
    }
  ])
})

test('kernel E2E CLI accepts tools on either execution host without changing lifecycle gates', () => {
  assert.equal(
    parseKernelE2eArgs(
      ['--target', 'local', '--runtime-root', '/tmp/kernel-e2e', '--scenario', 'tools'],
      '0.1.0'
    ).scenario,
    'tools'
  )
  assert.equal(
    parseKernelE2eArgs(
      [
        '--target',
        'ssh',
        '--host',
        'node3',
        '--runtime-root',
        '/tmp/kernel-e2e',
        '--scenario',
        'tools'
      ],
      '0.1.0'
    ).scenario,
    'tools'
  )
  assert.throws(
    () =>
      parseKernelE2eArgs(
        ['--target', 'local', '--runtime-root', '/tmp/kernel-e2e', '--scenario', 'reconnect'],
        '0.1.0'
      ),
    /--scenario reconnect requires --target ssh/
  )
  assert.match(kernelE2eUsage(), /baseline\|tools\|reconnect\|grace-expiry/)
})

function result(toolCallId: string, text: string): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    isError: false,
    content: [{ type: 'text', text }]
  }
}
