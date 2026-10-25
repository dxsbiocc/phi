/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ENGINE_DIRECTORY = 'src/main/agent/engine/'
const KERNEL_OMP_DIRECTORY = 'src/kernel/omp/'
const KERNEL_DIRECTORY = 'src/kernel/'
const KERNEL_ENTRY = 'src/kernel/main.ts'
const SHARED_PROTOCOL_DIRECTORY = 'src/shared/kernel-protocol/'
const OMP_SCOPE = '@oh-my-pi/'
const SCAN_DIRECTORIES = ['src', 'tests', 'scripts']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])

const OUTSIDE_ENGINE_MESSAGE =
  'OMP module references outside src/main/agent/engine/ must be allowlisted.'
const ENGINE_INTERNAL_MESSAGE =
  'OMP internal subpaths inside src/main/agent/engine/ must be allowlisted.'
const KERNEL_OMP_INTERNAL_MESSAGE =
  'OMP internal subpaths inside src/kernel/omp/ must be allowlisted.'

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

// Type-only imports and exports are erased when compiling (verbatimModuleSyntax is
// off), so they never load the target module at run time.
function isTypeOnlyDeclaration(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return false
    if (clause.isTypeOnly) return true
    const bindings = clause.namedBindings
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    )
  }
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  )
}

function moduleReferences(filePath, options = {}) {
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
    if (specifier) references.add(specifier)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!(options.runtimeOnly === true && isTypeOnlyDeclaration(node))) {
        record(node.moduleSpecifier)
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (options.runtimeOnly !== true) record(node.argument.literal)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      !(options.runtimeOnly === true && node.isTypeOnly)
    ) {
      record(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        node.arguments.length === 1 &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      const isRequireResolve =
        node.arguments.length === 1 &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' &&
        node.expression.name.text === 'resolve'
      const isImportMetaResolve =
        node.arguments.length === 1 &&
        options.includeImportMetaResolve === true &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.expression.expression.name.text === 'meta' &&
        node.expression.name.text === 'resolve'
      if (isDynamicImport || isRequire || isRequireResolve || isImportMetaResolve) {
        record(node.arguments[0])
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

function isWithin(directory, target) {
  const relative = path.relative(directory, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function resolvesWithinSharedProtocol(repoRoot, file, specifier) {
  if (!specifier.startsWith('.')) return false
  const sourceFile = path.resolve(repoRoot, ...file.split('/'))
  const target = path.resolve(path.dirname(sourceFile), specifier)
  const sharedDirectory = path.resolve(repoRoot, ...SHARED_PROTOCOL_DIRECTORY.split('/'))
  return isWithin(sharedDirectory, target)
}

function packageOrSubpath(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`)
}

function resolvedRepositoryPath(repoRoot, file, specifier) {
  if (specifier.startsWith('.')) {
    return normalizePath(
      path.relative(
        repoRoot,
        path.resolve(path.dirname(path.resolve(repoRoot, ...file.split('/'))), specifier)
      )
    )
  }
  return specifier.startsWith('src/') ? specifier : undefined
}

function forbiddenKernelImport(repoRoot, file, specifier, resolvedFile) {
  if (packageOrSubpath(specifier, 'electron')) return 'electron'
  if (packageOrSubpath(specifier, 'react') || packageOrSubpath(specifier, 'react-dom')) {
    return 'react'
  }
  if (specifier === '@renderer' || specifier.startsWith('@renderer/')) return 'renderer'

  const target = resolvedRepositoryPath(repoRoot, file, specifier)
  if (target === 'src/renderer' || target?.startsWith('src/renderer/')) return 'renderer'
  if (target === 'src/preload' || target?.startsWith('src/preload/')) return 'preload'
  if (target === 'src/main/ipc' || target?.startsWith('src/main/ipc/')) return 'main-ipc'
  const resolvedTarget = resolvedFile ? relativePath(repoRoot, resolvedFile) : target
  if (
    resolvedTarget === 'src/main/index.ts' ||
    resolvedTarget?.replace(/\.(?:[cm]?[jt]sx?)$/, '') === 'src/main/index'
  ) {
    return 'main-index'
  }
  return undefined
}

function sourceFileCandidate(filePath) {
  return (
    existsSync(filePath) &&
    statSync(filePath).isFile() &&
    SOURCE_EXTENSIONS.has(path.extname(filePath))
  )
}

function resolveRelativeSourceFile(repoRoot, filePath, specifier) {
  if (!specifier.startsWith('.')) return undefined

  const basePath = path.resolve(path.dirname(filePath), specifier)
  const extension = path.extname(basePath)
  const candidates = [basePath]
  if (extension.length === 0) {
    candidates.push(`${basePath}.ts`, path.join(basePath, 'index.ts'))
  } else if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    candidates.push(
      `${basePath.slice(0, -extension.length)}${
        extension === '.mjs' ? '.mts' : extension === '.cjs' ? '.cts' : '.ts'
      }`
    )
  }

  for (const candidate of candidates) {
    if (!isWithin(repoRoot, candidate) || !sourceFileCandidate(candidate)) continue
    return candidate
  }
  return undefined
}

function transitiveKernelFailures(repoRoot) {
  const entryPath = path.resolve(repoRoot, ...KERNEL_ENTRY.split('/'))
  if (!sourceFileCandidate(entryPath)) return []

  const pending = [{ filePath: entryPath, chain: [KERNEL_ENTRY] }]
  const visited = new Set([entryPath])
  const failures = []

  while (pending.length > 0) {
    const current = pending.shift()
    const file = relativePath(repoRoot, current.filePath)
    const references = moduleReferences(current.filePath, {
      includeImportMetaResolve: true,
      runtimeOnly: true
    })

    for (const specifier of [...references].sort()) {
      const resolvedFile = resolveRelativeSourceFile(repoRoot, current.filePath, specifier)
      const forbiddenArea = forbiddenKernelImport(repoRoot, file, specifier, resolvedFile)
      if (forbiddenArea) {
        const terminal = resolvedFile
          ? relativePath(repoRoot, resolvedFile)
          : (resolvedRepositoryPath(repoRoot, file, specifier) ?? specifier)
        failures.push({
          ...failure(
            file,
            specifier,
            `kernel-${forbiddenArea}-import-forbidden`,
            'Kernel code may not depend on Electron, React, renderer, preload, or main-process IPC.'
          ),
          chain: [...current.chain, terminal]
        })
        continue
      }

      if (!resolvedFile || visited.has(resolvedFile)) continue
      visited.add(resolvedFile)
      pending.push({
        filePath: resolvedFile,
        chain: [...current.chain, relativePath(repoRoot, resolvedFile)]
      })
    }
  }

  return failures
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
      new Set([...moduleReferences(filePath)].filter(ompSpecifierDetails))
    ])
  )
  const validation = validateAllowlist(allowlist)
  const allowedByFile = allowlistedSpecifiers(validation.entries)
  const failures = [...validation.failures]

  for (const [file, references] of referencesByFile) {
    const allowed = allowedByFile.get(file) ?? new Set()
    const insideEngine = file.startsWith(ENGINE_DIRECTORY)
    const insideKernelOmp = file.startsWith(KERNEL_OMP_DIRECTORY)
    for (const specifier of [...references].sort()) {
      if (allowed.has(specifier)) continue

      const details = ompSpecifierDetails(specifier)
      if ((insideEngine || insideKernelOmp) && !details.isInternalSubpath) continue
      failures.push(
        insideEngine
          ? failure(
              file,
              specifier,
              'engine-internal-subpath-unallowlisted',
              ENGINE_INTERNAL_MESSAGE
            )
          : insideKernelOmp
            ? failure(
                file,
                specifier,
                'kernel-omp-internal-subpath-unallowlisted',
                KERNEL_OMP_INTERNAL_MESSAGE
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

export function checkKernelBoundary({ repoRoot, stats }) {
  const absoluteRepoRoot = path.resolve(repoRoot)
  const sourceFiles = [SHARED_PROTOCOL_DIRECTORY, KERNEL_DIRECTORY]
    .flatMap((directory) => listSourceFiles(path.join(absoluteRepoRoot, directory)))
    .sort()
  const failures = []

  for (const filePath of sourceFiles) {
    const file = relativePath(absoluteRepoRoot, filePath)
    const references = moduleReferences(filePath, { includeImportMetaResolve: true })
    for (const specifier of [...references].sort()) {
      if (file.startsWith(SHARED_PROTOCOL_DIRECTORY)) {
        if (
          specifier === 'zod' ||
          resolvesWithinSharedProtocol(absoluteRepoRoot, file, specifier)
        ) {
          continue
        }
        failures.push(
          failure(
            file,
            specifier,
            'shared-protocol-import-forbidden',
            'Kernel protocol DTOs may import only zod or files within src/shared/kernel-protocol/.'
          )
        )
        continue
      }

      const forbiddenArea = forbiddenKernelImport(absoluteRepoRoot, file, specifier)
      if (forbiddenArea) {
        failures.push(
          failure(
            file,
            specifier,
            `kernel-${forbiddenArea}-import-forbidden`,
            'Kernel code may not depend on Electron, React, renderer, preload, or main-process IPC.'
          )
        )
      }

      if (specifier.startsWith(OMP_SCOPE) && !file.startsWith(KERNEL_OMP_DIRECTORY)) {
        failures.push(
          failure(
            file,
            specifier,
            'kernel-omp-import-outside-adapter',
            'OMP module references under src/kernel/ are allowed only in src/kernel/omp/.'
          )
        )
      }
    }
  }

  const failureIndexes = new Map(
    failures.map((item, index) => [`${item.file}\0${item.specifier}\0${item.rule}`, index])
  )
  for (const item of transitiveKernelFailures(absoluteRepoRoot)) {
    const key = `${item.file}\0${item.specifier}\0${item.rule}`
    const existingIndex = failureIndexes.get(key)
    if (existingIndex === undefined) {
      failureIndexes.set(key, failures.length)
      failures.push(item)
    } else {
      failures[existingIndex] = { ...failures[existingIndex], chain: item.chain }
    }
  }

  if (stats) stats.scannedFiles = sourceFiles.length
  return failures.sort(compareFailures)
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const allowlistPath = path.join(repoRoot, 'scripts/engine-boundary-allowlist.json')
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  const stats = {}
  const kernelStats = {}
  const failures = [
    ...checkEngineBoundary({ repoRoot, allowlist, stats }),
    ...checkKernelBoundary({ repoRoot, stats: kernelStats })
  ]

  if (failures.length > 0) {
    console.error('Engine boundary check failed:')
    for (const item of failures) {
      console.error(`- ${item.file} | ${item.specifier} | ${item.rule}: ${item.message}`)
      if (item.chain) console.error(`  import chain: ${item.chain.join(' -> ')}`)
    }
    process.exit(1)
  }

  console.log(
    `Engine boundary check passed: ${stats.scannedFiles} files scanned, ${stats.allowlistedFiles} allowlisted files; kernel boundary passed: ${kernelStats.scannedFiles} files scanned.`
  )
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
}
