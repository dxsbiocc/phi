/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(repoRoot, 'src/renderer/src')
const componentsDir = path.join(rendererRoot, 'components')
const featuresDir = path.join(rendererRoot, 'features')

const legacyComponentViews = new Set([
  'ChatView.tsx',
  'McpView.tsx',
  'PermissionView.tsx',
  'PluginView.tsx',
  'SkillView.tsx',
  'WrapperView.tsx'
])

const legacyOversizedFiles = new Set([
  'src/renderer/src/App.tsx',
  // Temporary legacy exception: split as part of the notebook canvas boundary cleanup.
  'src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx',
  'src/renderer/src/icons.ts'
])

const failures = []
const warnings = []

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function listFiles(dir) {
  const entries = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue
    }

    const entryPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      entries.push(...listFiles(entryPath))
      continue
    }

    entries.push(entryPath)
  }

  return entries
}

function lineCount(filePath) {
  const contents = readFileSync(filePath, 'utf8')
  if (contents.length === 0) {
    return 0
  }

  return contents.split(/\r?\n/).length
}

function checkSharedComponentViews() {
  const viewFiles = readdirSync(componentsDir)
    .filter((name) => name.endsWith('View.tsx'))
    .filter((name) => !legacyComponentViews.has(name))

  for (const name of viewFiles) {
    failures.push(
      `${relativePath(path.join(componentsDir, name))} is a page-level view in the shared components directory. Put new page features under src/renderer/src/features/<feature>/.`
    )
  }
}

function checkFeatureEntries() {
  for (const entry of readdirSync(featuresDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }

    const featurePath = path.join(featuresDir, entry.name)
    const rootFiles = readdirSync(featurePath, { withFileTypes: true })
      .filter((child) => child.isFile())
      .map((child) => child.name)

    const hasFeatureEntry = rootFiles.some(
      (name) => name.endsWith('View.tsx') || name.endsWith('Panel.tsx')
    )
    if (!hasFeatureEntry) {
      failures.push(
        `${relativePath(featurePath)} is missing a root <Feature>View.tsx or <Feature>Panel.tsx entry file.`
      )
    }
  }
}

function checkFileSizes() {
  const files = listFiles(rendererRoot)
    .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
    .filter((filePath) => statSync(filePath).isFile())

  for (const filePath of files) {
    const lines = lineCount(filePath)
    const rel = relativePath(filePath)

    if (lines > 1000 && !legacyOversizedFiles.has(rel)) {
      failures.push(
        `${rel} has ${lines} lines. Files over 1000 lines must be split or documented as a temporary legacy exception.`
      )
      continue
    }

    if (lines > 600) {
      warnings.push(
        `${rel} has ${lines} lines. Revisit its feature boundary when making substantial changes.`
      )
    }
  }
}

checkSharedComponentViews()
checkFeatureEntries()
checkFileSizes()

for (const warning of warnings) {
  console.warn(`frontend-boundaries warning: ${warning}`)
}

if (failures.length > 0) {
  console.error('Frontend boundary check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Frontend boundary check passed.')
