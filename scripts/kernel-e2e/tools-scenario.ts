import assert from 'node:assert/strict'

export const TOOLS_READ_MARKERS = {
  pdf: 'PDF_NATIVE_READ_MARKER',
  docx: 'DOCX_NATIVE_READ_MARKER',
  directory: 'DIRECTORY_NATIVE_READ_MARKER',
  home: 'HOME_NATIVE_READ_MARKER'
} as const

export type ToolsReadKind = keyof typeof TOOLS_READ_MARKERS | 'image'
export type ToolsReadOutcome = 'passed' | 'converter-missing' | 'failed'

export interface MissingToolsConverter {
  format: 'pdf' | 'docx'
  dependency: string
  reason: string
}

export interface ToolsReadEvidence {
  nativeReads?: Partial<Record<ToolsReadKind, ToolsReadOutcome>>
  missingConverters?: MissingToolsConverter[]
}

interface ToolsScenarioFiles {
  readonly projectRoot: string
  projectPath(relativePath: string): string
  homePath(relativePath: string): string
  write(path: string, content: Uint8Array | string): Promise<void>
}

interface ToolsScenarioClient {
  create(cwd: string, approval: boolean): Promise<string>
  prompt(sessionId: string, text: string): Promise<{ runId: string; status: string }>
  snapshot(sessionId: string): Promise<Record<string, unknown>>
}

interface ToolsScenarioProvider {
  enqueue(
    ...replies: Array<{
      text?: string
      tool?: { name: string; id: string; args: Record<string, unknown> }
    }>
  ): void
}

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

const TOOL_CALL_IDS: Record<ToolsReadKind, string> = {
  pdf: 'tools-read-pdf',
  docx: 'tools-read-docx',
  image: 'tools-read-image',
  directory: 'tools-read-directory',
  home: 'tools-read-home'
}

const TOOL_TARGETS: Record<ToolsReadKind, string> = {
  pdf: 'native-read.pdf',
  docx: 'native-read.docx',
  image: 'native-read.png',
  directory: 'native-read-directory',
  home: '~/native-read-home.txt'
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2+XcAAAAASUVORK5CYII=',
  'base64'
)

function createPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ]
  const chunks = [Buffer.from('%PDF-1.4\n%Phi fixture\n')]
  const offsets: number[] = []
  let length = chunks[0].length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`)
    chunks.push(chunk)
    length += chunk.length
  }
  const xrefOffset = length
  chunks.push(
    Buffer.from(
      [
        `xref\n0 ${objects.length + 1}`,
        '0000000000 65535 f ',
        ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
        `startxref\n${xrefOffset}`,
        '%%EOF\n'
      ].join('\n')
    )
  )
  return Buffer.concat(chunks)
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createStoredZip(entries: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content)
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function createDocx(text: string): Buffer {
  return createStoredZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    },
    {
      name: 'word/document.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body>` +
        '</w:document>'
    }
  ])
}

export function createToolsReadFixtures(): ReadonlyArray<{
  root: 'project' | 'home'
  path: string
  content: Uint8Array | string
}> {
  return [
    { root: 'project', path: TOOL_TARGETS.pdf, content: createPdf(TOOLS_READ_MARKERS.pdf) },
    { root: 'project', path: TOOL_TARGETS.docx, content: createDocx(TOOLS_READ_MARKERS.docx) },
    { root: 'project', path: TOOL_TARGETS.image, content: PNG_1X1 },
    {
      root: 'project',
      path: `${TOOL_TARGETS.directory}/${TOOLS_READ_MARKERS.directory}.txt`,
      content: `${TOOLS_READ_MARKERS.directory}\n`
    },
    { root: 'home', path: 'native-read-home.txt', content: `${TOOLS_READ_MARKERS.home}\n` }
  ]
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  return typeof item.text === 'string' ? item.text : contentText(item.content)
}

function toolResult(
  snapshot: Record<string, unknown>,
  toolCallId: string
): { text: string; isError: boolean } | undefined {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  const message = messages.find((candidate): candidate is Record<string, unknown> =>
    Boolean(
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).role === 'toolResult' &&
      (candidate as Record<string, unknown>).toolCallId === toolCallId
    )
  )
  return message
    ? { text: contentText(message.content), isError: message.isError === true }
    : undefined
}

function converterFailure(kind: 'pdf' | 'docx', text: string): MissingToolsConverter | undefined {
  if (!new RegExp(`Cannot read \\.${kind} file:`, 'i').test(text)) return undefined
  return {
    format: kind,
    dependency:
      kind === 'pdf' ? '@oh-my-pi/pi-natives pdfToMarkdown' : '@oh-my-pi/pi-utils/docx converter',
    reason: text.replace(/\s+/g, ' ').trim()
  }
}

function validateRead(
  kind: ToolsReadKind,
  result: { text: string; isError: boolean }
): string | null {
  if (result.isError) return `${kind} native read returned an error: ${result.text}`
  if (kind === 'image') {
    return /Image metadata:/i.test(result.text) &&
      /MIME:\s*image\/png/i.test(result.text) &&
      /Dimensions:\s*1x1/i.test(result.text)
      ? null
      : `image native read omitted PNG metadata: ${result.text}`
  }
  const normalizedText = result.text.replaceAll('\\_', '_')
  return normalizedText.includes(TOOLS_READ_MARKERS[kind])
    ? null
    : `${kind} native read omitted ${TOOLS_READ_MARKERS[kind]}: ${result.text}`
}

export async function runToolsScenario(options: {
  provider: ToolsScenarioProvider
  client: ToolsScenarioClient
  files: ToolsScenarioFiles
  report: { evidence: ToolsReadEvidence }
  step: Step
}): Promise<void> {
  await options.step('native read fixtures prepared on execution host', async () => {
    for (const fixture of createToolsReadFixtures()) {
      const path =
        fixture.root === 'home'
          ? options.files.homePath(fixture.path)
          : options.files.projectPath(fixture.path)
      await options.files.write(path, fixture.content)
    }
  })

  const sessionId = await options.step('tools scenario session created', () =>
    options.client.create(options.files.projectRoot, false)
  )
  for (const kind of ['pdf', 'docx', 'image', 'directory', 'home'] as const) {
    options.provider.enqueue({
      tool: {
        name: 'read',
        id: TOOL_CALL_IDS[kind],
        args: { path: TOOL_TARGETS[kind] }
      }
    })
  }
  options.provider.enqueue({ text: 'TOOLS_NATIVE_READ_COMPLETE' })
  await options.step('native read turn completed', async () => {
    const completion = await options.client.prompt(
      sessionId,
      'Read the generated PDF, DOCX, PNG, directory, and home-directory fixtures in order.'
    )
    assert.equal(completion.status, 'completed')
  })

  await options.step('native PDF, DOCX, image, and directory reads verified', async () => {
    const snapshot = await options.client.snapshot(sessionId)
    const outcomes: Partial<Record<ToolsReadKind, ToolsReadOutcome>> = {}
    const missingConverters: MissingToolsConverter[] = []
    const failures: string[] = []
    for (const kind of ['pdf', 'docx', 'image', 'directory', 'home'] as const) {
      const result = toolResult(snapshot, TOOL_CALL_IDS[kind])
      if (!result) {
        outcomes[kind] = 'failed'
        failures.push(`${kind} native read result is missing from the session snapshot`)
        continue
      }
      if (kind === 'pdf' || kind === 'docx') {
        const missing = converterFailure(kind, result.text)
        if (missing) {
          outcomes[kind] = 'converter-missing'
          missingConverters.push(missing)
          failures.push(
            `Missing ${kind.toUpperCase()} converter dependency (${missing.dependency}) on execution host: ${missing.reason}`
          )
          continue
        }
      }
      const failure = validateRead(kind, result)
      outcomes[kind] = failure ? 'failed' : 'passed'
      if (failure) failures.push(failure)
    }
    options.report.evidence.nativeReads = outcomes
    options.report.evidence.missingConverters = missingConverters
    if (failures.length > 0) throw new Error(failures.join('\n'))
  })
}
