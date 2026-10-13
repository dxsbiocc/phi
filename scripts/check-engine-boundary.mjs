/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ENGINE_DIRECTORY = 'src/main/agent/engine/'
const OMP_SCOPE = '@oh-my-pi/'
const SCAN_DIRECTORIES = ['src', 'tests', 'scripts']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])

const OUTSIDE_ENGINE_MESSAGE =
  'OMP module references outside src/main/agent/engine/ must be allowlisted.'
const ENGINE_INTERNAL_MESSAGE =
  'OMP internal subpaths inside src/main/agent/engine/ must be allowlisted.'

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/')
}

function relativePath(repoRoot, filePath) {
  return normalizePath(path.relative(repoRoot, filePath))
}

function listSourceFiles(directory) {
  if (!existsSync(directory)) return []

  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name.startsWith('.'))) {
      continue
    }

    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath))
      continue
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath)
    }
  }
  return files
}

function ompSpecifierDetails(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith(OMP_SCOPE)) return undefined

  const remainder = specifier.slice(OMP_SCOPE.length)
  const slashIndex = remainder.indexOf('/')
  const packageName = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex)
  if (packageName.length === 0) return undefined

  return { isInternalSubpath: slashIndex !== -1 }
}

function stringLiteralText(node) {
  // A backtick string without substitutions names a module exactly like a quoted one.
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function moduleReferences(filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(filePath)
  )
  const references = new Set()

  function record(node) {
    const specifier = stringLiteralText(node)
    if (ompSpecifierDetails(specifier)) references.add(specifier)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) record(node.arguments[0])
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

function failure(file, specifier, rule, message) {
  return { file, specifier, rule, message }
}

function entrySpecifier(entry) {
  if (!Array.isArray(entry?.specifiers) || entry.specifiers.length === 0) return '(none)'
  return typeof entry.specifiers[0] === 'string' ? entry.specifiers[0] : '(invalid)'
}

function validateAllowlist(allowlist) {
  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : []
  const failures = []
  const seenFiles = new Set()

  for (const entry of entries) {
    const file = typeof entry?.file === 'string' ? entry.file : '(missing file)'
    if (seenFiles.has(file)) {
      failures.push(
        failure(
          file,
          entrySpecifier(entry),
          'allowlist-duplicate-file',
          'Allowlist file entries must be unique.'
        )
      )
    }
    seenFiles.add(file)

    if (!Array.isArray(entry?.specifiers) || entry.specifiers.length === 0) {
      failures.push(
        failure(
          file,
          '(none)',
          'allowlist-empty-specifiers',
          'Allowlist entries must contain at least one specifier.'
        )
      )
    } else {
      const seenSpecifiers = new Set()
      for (const specifier of entry.specifiers) {
        const displayedSpecifier =
          typeof specifier === 'string' ? specifier : JSON.stringify(specifier)
        if (seenSpecifiers.has(specifier)) {
          failures.push(
            failure(
              file,
              displayedSpecifier,
              'allowlist-duplicate-specifier',
              'Allowlist specifiers within an entry must be unique.'
            )
          )
        }
        seenSpecifiers.add(specifier)

        if (!ompSpecifierDetails(specifier)) {
          failures.push(
            failure(
              file,
              displayedSpecifier,
              'allowlist-invalid-specifier',
              'Allowlist specifiers must name an @oh-my-pi package or subpath.'
            )
          )
        }
      }
    }

    if (typeof entry?.purpose !== 'string' || entry.purpose.trim().length === 0) {
      failures.push(
        failure(
          file,
          entrySpecifier(entry),
          'allowlist-missing-purpose',
          'Allowlist entries must have a non-empty purpose.'
        )
      )
    }

    if (entry?.plan !== 'remove' && entry?.plan !== 'keep') {
      failures.push(
        failure(
          file,
          entrySpecifier(entry),
          'allowlist-invalid-plan',
          'Allowlist plan must be either "remove" or "keep".'
        )
      )
    }
  }

  return { entries, failures }
}

function allowlistedSpecifiers(entries) {
  const byFile = new Map()
  for (const entry of entries) {
    if (typeof entry?.file !== 'string' || !Array.isArray(entry.specifiers)) continue
    let specifiers = byFile.get(entry.file)
    if (!specifiers) {
      specifiers = new Set()
      byFile.set(entry.file, specifiers)
    }
    for (const specifier of entry.specifiers) {
      if (typeof specifier === 'string') specifiers.add(specifier)
    }
  }
  return byFile
}

function compareFailures(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.specifier.localeCompare(right.specifier) ||
    left.rule.localeCompare(right.rule)
  )
}

export function checkEngineBoundary({ repoRoot, allowlist, stats }) {
  const absoluteRepoRoot = path.resolve(repoRoot)
  const sourceFiles = SCAN_DIRECTORIES.flatMap((directory) =>
    listSourceFiles(path.join(absoluteRepoRoot, directory))
  ).sort()
  const referencesByFile = new Map(
    sourceFiles.map((filePath) => [
      relativePath(absoluteRepoRoot, filePath),
      moduleReferences(filePath)
    ])
  )
  const validation = validateAllowlist(allowlist)
  const allowedByFile = allowlistedSpecifiers(validation.entries)
  const failures = [...validation.failures]

  for (const [file, references] of referencesByFile) {
    const allowed = allowedByFile.get(file) ?? new Set()
    const insideEngine = file.startsWith(ENGINE_DIRECTORY)
    for (const specifier of [...references].sort()) {
      if (allowed.has(specifier)) continue

      const details = ompSpecifierDetails(specifier)
      if (insideEngine && !details.isInternalSubpath) continue
      failures.push(
        insideEngine
          ? failure(
              file,
              specifier,
              'engine-internal-subpath-unallowlisted',
              ENGINE_INTERNAL_MESSAGE
            )
          : failure(file, specifier, 'outside-engine-unallowlisted', OUTSIDE_ENGINE_MESSAGE)
      )
    }
  }

  for (const [file, specifiers] of allowedByFile) {
    const absoluteFile = path.resolve(absoluteRepoRoot, ...file.split('/'))
    const references = referencesByFile.get(file) ?? new Set()
    for (const specifier of [...specifiers].filter(ompSpecifierDetails).sort()) {
      if (!existsSync(absoluteFile)) {
        failures.push(
          failure(
            file,
            specifier,
            'stale-file',
            'Allowlist file does not exist; delete this entry.'
          )
        )
      } else if (!references.has(specifier)) {
        failures.push(
          failure(
            file,
            specifier,
            'stale-specifier',
            'File no longer references this specifier; delete it from the allowlist.'
          )
        )
      }
    }
  }

  if (stats) {
    stats.scannedFiles = sourceFiles.length
    stats.allowlistedFiles = allowedByFile.size
  }
  return failures.sort(compareFailures)
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const allowlistPath = path.join(repoRoot, 'scripts/engine-boundary-allowlist.json')
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  const stats = {}
  const failures = checkEngineBoundary({ repoRoot, allowlist, stats })

  if (failures.length > 0) {
    console.error('Engine boundary check failed:')
    for (const item of failures) {
      console.error(`- ${item.file} | ${item.specifier} | ${item.rule}: ${item.message}`)
    }
    process.exit(1)
  }

  console.log(
    `Engine boundary check passed: ${stats.scannedFiles} files scanned, ${stats.allowlistedFiles} allowlisted files.`
  )
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
}
