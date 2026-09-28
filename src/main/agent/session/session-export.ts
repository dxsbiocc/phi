import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SessionExportResult } from '../../../shared/sessionExportTypes'
import { getPhiAgentDir } from '../runtime-paths'
import { findPhiSessionById, getSessionDir } from './session-store'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BLOB_REFERENCE = /blob:sha256:([0-9a-f]{64})/g

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

async function copyRegularTree(
  source: string,
  destination: string,
  totals: { fileCount: number; bytes: number }
): Promise<void> {
  const info = await lstat(source)
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    const entries = (await readdir(source)).sort()
    for (const name of entries) {
      await copyRegularTree(join(source, name), join(destination, name), totals)
    }
    const afterEntries = (await readdir(source)).sort()
    if (entries.join('\0') !== afterEntries.join('\0')) {
      throw new Error('导出期间会话资源发生变化，请重试')
    }
    return
  }
  if (!info.isFile()) throw new Error('会话包含无法安全导出的链接或特殊文件')
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  const after = await lstat(source)
  if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new Error('导出期间会话资源发生变化，请重试')
  }
  totals.fileCount += 1
  totals.bytes += info.size
}

async function existingDirectory(path: string): Promise<string> {
  const real = await realpath(path)
  if (!(await stat(real)).isDirectory()) throw new Error('请选择导出目录')
  return real
}

async function copyRuntimeHistory(
  runtimePath: string | undefined,
  agentDir: string,
  destination: string,
  totals: { fileCount: number; bytes: number }
): Promise<{ runtimeIncluded: boolean; blobCount: number }> {
  if (!runtimePath) return { runtimeIncluded: false, blobCount: 0 }
  let source: string
  try {
    source = await realpath(runtimePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('底层会话历史文件已不存在，无法完整导出')
    }
    throw error
  }
  if (!inside(agentDir, source) || !(await stat(source)).isFile()) {
    throw new Error('底层会话历史位于 Phi 数据目录之外，无法安全导出')
  }

  const runtimeDir = join(destination, 'runtime')
  const before = await stat(source)
  await copyRegularTree(source, join(runtimeDir, basename(source)), totals)
  if (source.endsWith('.jsonl')) {
    const artifactsPath = source.slice(0, -'.jsonl'.length)
    try {
      if (!(await lstat(artifactsPath)).isDirectory()) {
        throw new Error('底层会话资源目录无法安全导出')
      }
      await copyRegularTree(artifactsPath, join(runtimeDir, 'artifacts'), totals)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  const hashes = new Set<string>()
  let carry = ''
  for await (const chunk of createReadStream(join(runtimeDir, basename(source)), {
    encoding: 'utf8'
  })) {
    const content = carry + chunk
    for (const match of content.matchAll(BLOB_REFERENCE)) hashes.add(match[1])
    carry = content.slice(-100)
  }
  for (const hash of hashes) {
    const blobPath = join(agentDir, 'blobs', hash)
    const copiedPath = join(runtimeDir, 'blobs', hash)
    await copyRegularTree(blobPath, copiedPath, totals)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(copiedPath)) digest.update(chunk)
    if (digest.digest('hex') !== hash) throw new Error('底层图片资源校验失败，无法完整导出')
  }
  const after = await stat(source)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('导出期间底层会话历史发生变化，请重试')
  }
  return { runtimeIncluded: true, blobCount: hashes.size }
}

/** A local, explicit snapshot. Project files are never copied into this export. */
export async function exportPhiSession(
  sessionId: string,
  parentDirectory: string
): Promise<SessionExportResult> {
  if (!SESSION_ID.test(sessionId)) throw new Error('会话编号无效')
  const manifest = findPhiSessionById(sessionId)
  if (!manifest) throw new Error('会话不存在')
  if (
    manifest.status === 'running' ||
    manifest.status === 'needs_approval' ||
    manifest.status === 'needs_input' ||
    manifest.currentRunId
  ) {
    throw new Error('请等待会话运行结束后再导出')
  }

  const agentDir = await existingDirectory(getPhiAgentDir())
  const parent = await existingDirectory(parentDirectory)
  if (inside(agentDir, parent)) throw new Error('请选择 Phi 数据目录之外的位置')
  const sourceDir = await realpath(getSessionDir(sessionId))
  if (!inside(agentDir, sourceDir)) throw new Error('会话目录不在 Phi 数据目录内')
  const messagesPath = join(sourceDir, 'messages.jsonl')
  const before = await stat(messagesPath)
  const temporary = await mkdtemp(join(parent, '.phi-session-export-'))
  const totals = { fileCount: 0, bytes: 0 }

  try {
    await copyRegularTree(sourceDir, join(temporary, 'phi-session'), totals)
    const runtime = await copyRuntimeHistory(
      manifest.runtimeSessionPath,
      agentDir,
      temporary,
      totals
    )
    const after = await stat(messagesPath)
    const latest = findPhiSessionById(sessionId)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      latest?.updatedAt !== manifest.updatedAt ||
      latest.status === 'running' ||
      latest.status === 'needs_approval' ||
      latest.status === 'needs_input'
    ) {
      throw new Error('导出期间会话发生变化，请等待后重试')
    }

    const info = {
      format: 'phi-session-export-v1',
      exportedAt: new Date().toISOString(),
      sessionId,
      runtimeIncluded: runtime.runtimeIncluded,
      blobCount: runtime.blobCount,
      note: '包含完整会话内容、思考内容、工具输出和图片；仅作本地备份，不可直接导入 Phi。'
    }
    const infoText = `${JSON.stringify(info, null, 2)}\n`
    await writeFile(join(temporary, 'export-info.json'), infoText, 'utf8')
    totals.fileCount += 1
    totals.bytes += Buffer.byteLength(infoText)

    const name = `phi-session-${sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const outputPath = resolve(parent, name)
    await rename(temporary, outputPath)
    return { path: outputPath, ...totals, ...runtime }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
