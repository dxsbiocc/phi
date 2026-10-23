/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Main-process structure guard.
 *
 * `src/main/index.ts` is the largest file in the repository and the place every
 * IPC domain used to live. The renderer equivalent
 * (check-frontend-boundaries.mjs) is absolute: it rejects a new oversized file
 * outright. That cannot work here yet, so this check is a ratchet: the numbers
 * in main-boundaries-baseline.json are a ceiling that may only come down.
 *
 * Rules:
 *  - src/main/index.ts may not grow past its frozen line count.
 *  - src/main/index.ts may not register more ipcMain.handle channels than frozen.
 *  - A file under src/main may not exceed the oversized limit unless it is frozen.
 *
 * Usage:
 *   node scripts/check-main-boundaries.mjs            verify
 *   node scripts/check-main-boundaries.mjs --update   lower the baseline to today's numbers
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(repoRoot, 'scripts/main-boundaries-baseline.json')
const mainDir = path.join(repoRoot, 'src/main')

const update = process.argv.includes('--update')

function lineCount(filePath) {
  const contents = readFileSync(filePath, 'utf8')
  if (contents.length === 0) return 0
  // Match `wc -l`: a trailing newline terminates the last line, it does not add one.
  const lines = contents.split(/\r?\n/).length
  return contents.endsWith('\n') ? lines - 1 : lines
}

function ipcHandleCount(filePath) {
  const contents = readFileSync(filePath, 'utf8')
  return (contents.match(/ipcMain\.handle\(/g) ?? []).length
}

function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(entryPath))
    else if (entry.name.endsWith('.ts')) out.push(entryPath)
  }
  return out
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const indexFile = path.join(repoRoot, baseline.index.path)
const failures = []
const improvements = []

const indexLines = lineCount(indexFile)
const indexHandles = ipcHandleCount(indexFile)

if (indexLines > baseline.index.lines) {
  failures.push(
    `${baseline.index.path} grew to ${indexLines} lines (ceiling ${baseline.index.lines}). ` +
      'Move a domain out instead of adding to it.'
  )
} else if (indexLines < baseline.index.lines) {
  improvements.push(
    `${baseline.index.path}: ${indexLines} lines, ${baseline.index.lines - indexLines} below the ceiling`
  )
}

if (indexHandles > baseline.index.ipcHandles) {
  failures.push(
    `${baseline.index.path} registers ${indexHandles} ipcMain.handle channels (ceiling ${baseline.index.ipcHandles}). ` +
      'Register new channels from a module under src/main/ipc/.'
  )
} else if (indexHandles < baseline.index.ipcHandles) {
  improvements.push(
    `${baseline.index.path}: ${indexHandles} channels, ${baseline.index.ipcHandles - indexHandles} below the ceiling`
  )
}

const limit = baseline.oversized.lineLimit
const frozen = baseline.oversized.files
const currentOversized = new Map()

for (const file of listSourceFiles(mainDir)) {
  const lines = lineCount(file)
  if (lines <= limit) continue
  const rel = relative(file)
  currentOversized.set(rel, lines)
  const allowed = frozen[rel]
  if (allowed === undefined) {
    failures.push(
      `${rel} has ${lines} lines and is not in the frozen list. Files over ${limit} lines need a split or an explicit baseline entry.`
    )
  } else if (lines > allowed) {
    failures.push(`${rel} grew to ${lines} lines (ceiling ${allowed}).`)
  } else if (lines < allowed) {
    improvements.push(`${rel}: ${lines} lines, ${allowed - lines} below the ceiling`)
  }
}

if (update) {
  const next = {
    ...baseline,
    frozenAt: new Date().toISOString().slice(0, 10),
    index: { ...baseline.index, lines: indexLines, ipcHandles: indexHandles },
    oversized: { ...baseline.oversized, files: Object.fromEntries([...currentOversized].sort()) }
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `Baseline lowered: index ${indexLines} lines / ${indexHandles} channels, ${currentOversized.size} oversized file(s).`
  )
  process.exit(0)
}

for (const note of improvements) console.log(`ratchet available: ${note}`)
if (improvements.length > 0) {
  console.log('Run with --update to lock the lower numbers in.')
}

if (failures.length > 0) {
  console.error('Main-process boundary check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Main-process boundaries hold: index ${indexLines}/${baseline.index.lines} lines, ` +
    `${indexHandles}/${baseline.index.ipcHandles} channels, ${currentOversized.size} oversized file(s) at or below their ceiling.`
)
