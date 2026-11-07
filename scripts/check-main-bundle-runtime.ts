import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

export const BUN_CHILD_ENTRY_ALLOWLIST = Object.freeze([
  'agent/engine/in-process/main.ts',
  'agent/engine/rpc/desktop-project-memory-sdk-worker.ts',
  'terminal/terminal-supervisor.ts',
  'terminal/terminal-worker.ts'
])

const RUNTIME_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.mts', '.ts', '.tsx'])
const RESOLUTION_EXTENSIONS = ['', '.cjs', '.js', '.mjs', '.mts', '.ts', '.tsx']

type RuntimeImport = { specifier: string; dynamic: boolean }

export type MainBundleRuntimeViolation = {
  readonly file: string
  readonly specifier?: string
  readonly reason: 'bun-only-import' | 'missing-allowlisted-entry' | 'unclassified-bun-output'
}

export type MainBundleRuntimeReport = {
  readonly mainDirectory: string
  readonly reachedFiles: readonly string[]
  readonly allowedBunFiles: readonly string[]
  readonly violations: readonly MainBundleRuntimeViolation[]
}

function runtimeImports(source: string, fileName: string): RuntimeImport[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const imports: RuntimeImport[] = []
  const allNamedTypes = (clause: ts.NamedImports | ts.NamedExports): boolean =>
    clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) return
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      let erased: boolean | undefined
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        erased =
          clause?.isTypeOnly ||
          (!clause?.name &&
            clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            allNamedTypes(clause.namedBindings))
      } else {
        const clause = node.exportClause
        erased =
          node.isTypeOnly || Boolean(clause && ts.isNamedExports(clause) && allNamedTypes(clause))
      }
      if (!erased && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({ specifier: node.moduleSpecifier.text, dynamic: false })
      }
      return
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, dynamic: false })
      return
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, dynamic: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function resolveLocalImport(fromFile: string, specifier: string, boundary: string): string {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [
    ...RESOLUTION_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLUTION_EXTENSIONS.slice(1).map((extension) => join(base, `index${extension}`))
  ]
  const found = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  if (!found || !inside(boundary, found)) {
    throw new Error(`Cannot resolve in-boundary import ${specifier} from ${fromFile}`)
  }
  return found
}

function runtimeFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && RUNTIME_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

function collectGraph(entries: readonly string[], boundary: string): Set<string> {
  const visited = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    for (const { specifier } of runtimeImports(readFileSync(file, 'utf8'), file)) {
      if (specifier.startsWith('.')) pending.push(resolveLocalImport(file, specifier, boundary))
    }
  }
  return visited
}

function isBunOnlyImport(specifier: string): boolean {
  return (
    specifier === 'bun' ||
    specifier.startsWith('bun:') ||
    specifier === '@oh-my-pi' ||
    specifier.startsWith('@oh-my-pi/')
  )
}

export function inspectMainBundleRuntime(
  mainDirectory = resolve('out/main'),
  bunChildEntries: readonly string[] = BUN_CHILD_ENTRY_ALLOWLIST
): MainBundleRuntimeReport {
  const absoluteMain = resolve(mainDirectory)
  const outputRoot = dirname(absoluteMain)
  const entry = join(absoluteMain, 'index.mjs')
  if (!existsSync(entry)) throw new Error(`Main bundle entry is missing: ${entry}`)

  const reached = collectGraph([entry], absoluteMain)
  const violations: MainBundleRuntimeViolation[] = []
  const allowedEntries: string[] = []
  for (const childEntry of bunChildEntries) {
    const path = resolve(absoluteMain, childEntry)
    if (!inside(absoluteMain, path) || !existsSync(path)) {
      violations.push({
        file: toPosix(relative(absoluteMain, path)),
        reason: 'missing-allowlisted-entry'
      })
    } else {
      allowedEntries.push(path)
    }
  }
  const allowedBunFiles = collectGraph(allowedEntries, outputRoot)

  for (const file of runtimeFiles(absoluteMain)) {
    for (const { specifier } of runtimeImports(readFileSync(file, 'utf8'), file)) {
      if (!isBunOnlyImport(specifier)) continue
      if (reached.has(file)) {
        violations.push({
          file: toPosix(relative(absoluteMain, file)),
          specifier,
          reason: 'bun-only-import'
        })
      } else if (!allowedBunFiles.has(file)) {
        violations.push({
          file: toPosix(relative(absoluteMain, file)),
          specifier,
          reason: 'unclassified-bun-output'
        })
      }
    }
  }

  return {
    mainDirectory: absoluteMain,
    reachedFiles: [...reached].map((file) => toPosix(relative(absoluteMain, file))).sort(),
    allowedBunFiles: [...allowedBunFiles]
      .filter((file) => inside(absoluteMain, file))
      .map((file) => toPosix(relative(absoluteMain, file)))
      .sort(),
    violations
  }
}

export function assertMainBundleRuntime(
  mainDirectory = resolve('out/main'),
  bunChildEntries: readonly string[] = BUN_CHILD_ENTRY_ALLOWLIST
): MainBundleRuntimeReport {
  const report = inspectMainBundleRuntime(mainDirectory, bunChildEntries)
  if (report.violations.length > 0) {
    const detail = report.violations
      .map(
        (violation) =>
          `  - ${violation.file}${violation.specifier ? ` -> ${violation.specifier}` : ''} (${violation.reason})`
      )
      .join('\n')
    throw new Error(`Electron main runtime boundary violations:\n${detail}`)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mainDirectory = process.argv[2] ? resolve(process.argv[2]) : resolve('out/main')
  try {
    const report = assertMainBundleRuntime(mainDirectory)
    process.stdout.write(
      `Electron main runtime graph is Node-safe (${report.reachedFiles.length} reached files; ${report.allowedBunFiles.length} allowlisted Bun-child files).\n`
    )
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
