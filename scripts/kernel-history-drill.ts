import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  readAndPlanKernelHistory,
  rollbackAdoptedSession,
  writeKernelOwner
} from '../src/main/agent/engine/kernel-history'
import { makeSessionManager } from '../src/main/agent/engine/in-process/session-factory'
import { PINNED_OMP_VERSION } from '../src/main/agent/engine/omp-version'
import { readManifestFile, writeManifestFile } from '../src/main/agent/session/manifest-file'
import { KernelSessionRepository, kernelSessionMigrationPaths } from '../src/kernel/sessions'

type DrillAction = 'adopt-local' | 'adopt-remote' | 'read-only'

type DrillSessionResult = {
  phiSessionId: string
  action: DrillAction
  reason: string
  sourceKind: 'real-copy' | 'synthetic' | 'unavailable'
  sourcePath?: string
  kernelSessionId?: string
  hashes?: {
    sourceBefore: string
    sourceAfter: string
    backup: string
    adoptedBeforeContinuation: string
    adoptedAfterContinuation: string
    rollbackExport: string
  }
  sourceMtimeUnchanged?: boolean
  messageCounts?: { before: number; snapshot: number; afterContinuation: number; rollback: number }
  rollback?: { status: 'rolled-back' | 'incompatible'; exportPath?: string; reason?: string }
  error?: string
}

type DrillReport = {
  schemaVersion: 1
  generatedAt: string
  input: string
  copyFirst: boolean
  summary: {
    total: number
    adoptedLocal: number
    adoptedRemote: number
    readOnly: number
    passed: number
    failed: number
  }
  sessions: DrillSessionResult[]
}

type CliOptions = {
  phiSessions: string
  out: string
  copyFirst: boolean
}

function drillPassed(item: DrillSessionResult): boolean {
  const hashes = item.hashes
  const counts = item.messageCounts
  return Boolean(
    item.rollback?.status === 'rolled-back' &&
    item.sourceMtimeUnchanged &&
    hashes &&
    hashes.sourceBefore === hashes.sourceAfter &&
    hashes.sourceBefore === hashes.backup &&
    hashes.sourceBefore === hashes.adoptedBeforeContinuation &&
    hashes.adoptedAfterContinuation === hashes.rollbackExport &&
    counts &&
    counts.snapshot === counts.before &&
    counts.afterContinuation === counts.before + 1 &&
    counts.rollback === counts.afterContinuation
  )
}

function usage(): never {
  throw new Error(
    'Usage: bun scripts/kernel-history-drill.ts --phi-sessions <dir> --out <report.json> [--copy-first|--no-copy-first]'
  )
}

function parseArgs(argv: readonly string[]): CliOptions {
  let phiSessions: string | undefined
  let out: string | undefined
  let copyFirst = true
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--phi-sessions') phiSessions = argv[++index]
    else if (argument === '--out') out = argv[++index]
    else if (argument === '--copy-first') copyFirst = true
    else if (argument === '--no-copy-first') copyFirst = false
    else usage()
  }
  if (!phiSessions || !out) usage()
  return { phiSessions: resolve(phiSessions), out: resolve(out), copyFirst }
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function prospectiveRealPath(path: string): Promise<string> {
  let cursor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return join(await realpath(cursor), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function countMessages(path: string, cwd: string): Promise<number> {
  const manager = await makeSessionManager(
    { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
    cwd,
    ''
  )
  try {
    return manager.buildSessionContext().messages.length
  } finally {
    await manager.close()
  }
}

async function validateDrillJournal(path: string, cwd: string): Promise<void> {
  const manager = await makeSessionManager(
    { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
    cwd,
    ''
  )
  try {
    if (manager.getCwd() !== cwd) throw new Error('drill journal cwd changed during validation')
  } finally {
    await manager.close()
  }
}

async function appendDrillContinuation(path: string, cwd: string): Promise<number> {
  const manager = await makeSessionManager(
    { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
    cwd,
    ''
  )
  try {
    manager.appendMessage({
      role: 'user',
      content: '[kernel history drill continuation]',
      synthetic: true,
      timestamp: Date.now()
    })
  } finally {
    await manager.close()
  }
  return countMessages(path, cwd)
}

async function writeReportAtomic(path: string, report: DrillReport): Promise<void> {
  const realPhiRoot = await realpath(join(homedir(), '.phi')).catch(() => join(homedir(), '.phi'))
  if (within(realPhiRoot, await prospectiveRealPath(path))) {
    throw new Error('Refusing to write a drill report inside ~/.phi')
  }
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true }))
  const realParent = await realpath(dirname(path))
  if (within(realPhiRoot, join(realParent, basename(path)))) {
    throw new Error('Refusing to write a drill report inside ~/.phi')
  }
  const temporary = `${path}.tmp.${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

function mapCopiedPath(
  originalRoot: string,
  workingRoot: string,
  originalPath: string
): string | undefined {
  if (!isAbsolute(originalPath) || !within(originalRoot, originalPath)) return undefined
  return join(workingRoot, relative(originalRoot, originalPath))
}

async function prepareWorkingRoot(options: CliOptions): Promise<{
  originalRoot: string
  workingRoot: string
  temporaryRoot?: string
}> {
  const originalRoot = await realpath(options.phiSessions)
  const realPhiRoot = await realpath(join(homedir(), '.phi')).catch(() => join(homedir(), '.phi'))
  if (within(realPhiRoot, await prospectiveRealPath(options.out))) {
    throw new Error('Refusing to write a drill report inside ~/.phi')
  }
  if (within(realPhiRoot, originalRoot) && !options.copyFirst) {
    throw new Error('Refusing to drill inside ~/.phi without --copy-first')
  }
  if (!options.copyFirst) return { originalRoot, workingRoot: originalRoot }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'phi-kernel-history-drill-'))
  const workingRoot = join(temporaryRoot, 'sessions')
  await cp(originalRoot, workingRoot, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    dereference: false
  })
  return { originalRoot, workingRoot, temporaryRoot }
}

async function sessionDirectories(root: string): Promise<Array<{ id: string; directory: string }>> {
  const entries = await readdir(root, { withFileTypes: true })
  const sessions: Array<{ id: string; directory: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = join(root, entry.name)
    if (await regularFile(join(directory, 'manifest.json'))) {
      sessions.push({ id: entry.name, directory })
    }
  }
  return sessions.sort((left, right) => left.id.localeCompare(right.id))
}

async function drillOne(options: {
  originalRoot: string
  workingRoot: string
  agentDir: string
  phiSessionId: string
  phiSessionDirectory: string
}): Promise<DrillSessionResult> {
  const manifest = readManifestFile(
    join(options.phiSessionDirectory, 'manifest.json'),
    options.phiSessionId
  )
  const plan = await readAndPlanKernelHistory({
    phiSessionDirectory: options.phiSessionDirectory,
    phiSessionId: options.phiSessionId,
    localJournalReadable: async (path) => {
      const copied = mapCopiedPath(options.originalRoot, options.workingRoot, path)
      return copied ? regularFile(copied) : false
    }
  })
  const base: DrillSessionResult = {
    phiSessionId: options.phiSessionId,
    action: plan.action,
    reason: plan.reason,
    sourceKind: plan.action === 'adopt-local' ? 'real-copy' : 'unavailable'
  }
  if (plan.action !== 'adopt-local') return base
  const source = mapCopiedPath(options.originalRoot, options.workingRoot, plan.source.path)
  if (!source || !(await regularFile(source))) {
    return { ...base, action: 'read-only', reason: 'copied local journal is unavailable' }
  }

  const sourceBefore = await sha256File(source)
  const sourceInfo = await lstat(source)
  const before = await countMessages(source, manifest.cwd)
  const repository = new KernelSessionRepository(
    options.agentDir,
    `history-drill-${options.phiSessionId}`,
    undefined,
    'history-drill-process',
    validateDrillJournal
  )
  let kernelSessionId: string | undefined
  try {
    const adopted = await repository.adopt(
      {
        source: { ...plan.source, path: source },
        ...(manifest.title ? { title: manifest.title } : {}),
        ...(manifest.model
          ? { model: { provider: manifest.model.providerId, id: manifest.model.modelId } }
          : {}),
        ...(manifest.thinkingLevel ? { thinkingLevel: manifest.thinkingLevel } : {})
      },
      { allowedSourceRoots: [options.workingRoot] }
    )
    kernelSessionId = adopted.sessionId
    const paths = kernelSessionMigrationPaths(options.agentDir, kernelSessionId)
    const snapshot = await countMessages(paths.journal, manifest.cwd)
    const adoptedBeforeContinuation = await sha256File(paths.journal)
    const afterContinuation = await appendDrillContinuation(paths.journal, manifest.cwd)
    const adoptedAfterContinuation = await sha256File(paths.journal)
    // Rollback exports a stable journal. Quiesce the K2-1 writer before hashing.
    await repository.close(kernelSessionId)
    // This is the disposable Phi copy. Rebind its old-app locator to the copied
    // source so rollback can never resolve the authoritative ~/.phi path.
    writeManifestFile(options.phiSessionDirectory, {
      ...manifest,
      runtimeSessionPath: source
    })

    await writeKernelOwner(options.phiSessionDirectory, {
      schemaVersion: 1,
      kernelSessionId,
      host: hostname(),
      runtimeRoot: options.agentDir,
      migratedAt: new Date().toISOString(),
      sourceSha256: sourceBefore
    })
    const rolledBack = await rollbackAdoptedSession({
      phiSessionDirectory: options.phiSessionDirectory,
      originalRuntimeSessionPath: source,
      kernelJournalPath: paths.journal,
      compatibility: {
        kernelSdkVersion: PINNED_OMP_VERSION,
        oldAppSdkVersion: PINNED_OMP_VERSION,
        oldAppJournalVersion: 3
      }
    })
    if (rolledBack.status !== 'rolled-back') {
      return {
        ...base,
        sourcePath: source,
        kernelSessionId,
        rollback: { status: 'incompatible', reason: rolledBack.reason }
      }
    }
    const rollbackMessages = await countMessages(rolledBack.exportPath, manifest.cwd)
    const reparsed = readManifestFile(
      join(options.phiSessionDirectory, 'manifest.json'),
      options.phiSessionId
    )
    if (reparsed.runtimeSessionPath !== rolledBack.exportPath) {
      throw new Error('Phi manifest reader did not observe the rollback export')
    }
    const sourceAfter = await sha256File(source)
    return {
      ...base,
      sourcePath: source,
      kernelSessionId,
      hashes: {
        sourceBefore,
        sourceAfter,
        backup: await sha256File(paths.sourceBackup),
        adoptedBeforeContinuation,
        adoptedAfterContinuation,
        rollbackExport: await sha256File(rolledBack.exportPath)
      },
      sourceMtimeUnchanged: (await lstat(source)).mtimeMs === sourceInfo.mtimeMs,
      messageCounts: { before, snapshot, afterContinuation, rollback: rollbackMessages },
      rollback: { status: 'rolled-back', exportPath: rolledBack.exportPath }
    }
  } finally {
    if (kernelSessionId) await repository.close(kernelSessionId)
  }
}

export async function runKernelHistoryDrill(options: CliOptions): Promise<DrillReport> {
  const prepared = await prepareWorkingRoot(options)
  if (prepared.temporaryRoot && within(prepared.temporaryRoot, options.out)) {
    throw new Error('The drill report must be written outside the disposable copy root')
  }
  const results: DrillSessionResult[] = []
  try {
    const agentDir = join(prepared.workingRoot, '.kernel-drill-agent')
    for (const candidate of await sessionDirectories(prepared.workingRoot)) {
      try {
        results.push(
          await drillOne({
            originalRoot: prepared.originalRoot,
            workingRoot: prepared.workingRoot,
            agentDir,
            phiSessionId: candidate.id,
            phiSessionDirectory: candidate.directory
          })
        )
      } catch (error) {
        results.push({
          phiSessionId: candidate.id,
          action: 'read-only',
          reason: 'drill failed',
          sourceKind: 'unavailable',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const report: DrillReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      input: prepared.originalRoot,
      copyFirst: options.copyFirst,
      summary: {
        total: results.length,
        adoptedLocal: results.filter((item) => item.action === 'adopt-local').length,
        adoptedRemote: results.filter((item) => item.action === 'adopt-remote').length,
        readOnly: results.filter((item) => item.action === 'read-only').length,
        passed: results.filter(drillPassed).length,
        failed: results.filter(
          (item) => Boolean(item.error) || (item.action === 'adopt-local' && !drillPassed(item))
        ).length
      },
      sessions: results
    }
    await writeReportAtomic(options.out, report)
    return report
  } finally {
    if (prepared.temporaryRoot) {
      await rm(prepared.temporaryRoot, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const report = await runKernelHistoryDrill(options)
  process.stdout.write(`${JSON.stringify(report.summary)}\n`)
}
