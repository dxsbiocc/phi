import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

import {
  PHI_PLATFORMS,
  parseEnvironmentSpec,
  parseExplicitLock,
  parseLockPackage,
  type CondaDependency,
  type EnvironmentSpec
} from '../../src/main/agent/envs'

import { packageContentPath } from '../helpers/packageContent'

const REPO_ROOT = process.cwd()
const PHI_R_DIR = join(REPO_ROOT, 'resources/runtime/environments/phi-r')

const VIZ_R_DIR = packageContentPath(
  'plugins',
  'visualization',
  'skills',
  'omics-visualization',
  'scripts'
)

// These namespaces ship inside r-base rather than as separate conda packages.
const R_BASE_NAMESPACES = [
  'base',
  'compiler',
  'datasets',
  'grDevices',
  'graphics',
  'grid',
  'methods',
  'parallel',
  'splines',
  'stats',
  'stats4',
  'tcltk',
  'tools',
  'utils'
] as const

function normalizedPackage(name: string): string {
  return name.toLowerCase()
}

function condaDependencyName(dependency: CondaDependency): string | undefined {
  if (typeof dependency !== 'string') return undefined
  const match = /^(?:[^:]+::)?([^\s<>=!]+)/.exec(dependency.trim())
  return match?.[1]?.toLowerCase()
}

function rNamespacesForCondaPackage(condaPackage: string): string[] {
  if (condaPackage === 'r-base') return [...R_BASE_NAMESPACES]
  if (condaPackage.startsWith('r-')) return [condaPackage.slice('r-'.length)]
  if (condaPackage.startsWith('bioconductor-')) {
    return [condaPackage.slice('bioconductor-'.length)]
  }
  return []
}

function parsePhiR(): EnvironmentSpec {
  const parsed = parseEnvironmentSpec(readFileSync(join(PHI_R_DIR, 'environment.yml'), 'utf8'))
  if (!parsed.ok) assert.fail(parsed.errors.join('\n'))
  return parsed.spec
}

function declaredRNamespaces(spec: EnvironmentSpec): Set<string> {
  const names = new Set<string>()
  for (const dependency of spec.dependencies) {
    const condaPackage = condaDependencyName(dependency)
    if (!condaPackage) continue
    for (const namespace of rNamespacesForCondaPackage(condaPackage)) {
      names.add(normalizedPackage(namespace))
    }
  }
  for (const sourcePackage of spec.sourcePackages ?? []) {
    names.add(normalizedPackage(sourcePackage.name))
  }
  return names
}

function lockedRNamespaces(platform: (typeof PHI_PLATFORMS)[number]): Set<string> {
  const lockPath = join(PHI_R_DIR, 'locks', `${platform}.txt`)
  const parsed = parseExplicitLock(readFileSync(lockPath, 'utf8'))
  if (!parsed.ok) assert.fail(`${lockPath}: ${parsed.errors.join('\n')}`)

  const names = new Set<string>()
  for (const entry of parsed.entries) {
    const condaPackage = parseLockPackage(entry.url).name.toLowerCase()
    for (const namespace of rNamespacesForCondaPackage(condaPackage)) {
      names.add(normalizedPackage(namespace))
    }
  }
  return names
}

function rFiles(directory: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.R')) files.push(path)
    }
  }
  walk(directory)
  return files.sort()
}

function withoutRComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      let quote: '"' | "'" | undefined
      let escaped = false
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index]
        if (escaped) {
          escaped = false
          continue
        }
        if (quote && character === '\\') {
          escaped = true
          continue
        }
        if (character === '"' || character === "'") {
          if (quote === character) quote = undefined
          else if (!quote) quote = character
          continue
        }
        if (!quote && character === '#') return line.slice(0, index)
      }
      return line
    })
    .join('\n')
}

function importedRNamespaces(source: string): Set<string> {
  const code = withoutRComments(source)
  const imports = new Set<string>()

  const libraryCall =
    /\b(?:library|require)\s*\(\s*(?:package\s*=\s*)?(?:(['"])([A-Za-z][A-Za-z0-9._]*)\1|([A-Za-z][A-Za-z0-9._]*))([^)]*)\)/g
  for (const match of code.matchAll(libraryCall)) {
    const quoted = match[2]
    const bare = match[3]
    const options = match[4] ?? ''
    if (bare && /\bcharacter\.only\s*=\s*TRUE\b/.test(options)) continue
    imports.add(normalizedPackage(quoted ?? bare))
  }

  for (const match of code.matchAll(/\b([A-Za-z][A-Za-z0-9._]*)\s*:{2,3}/g)) {
    imports.add(normalizedPackage(match[1]))
  }

  // Visualization templates centralize library() behind this literal package loader.
  for (const call of code.matchAll(/\bload_packages\s*\(\s*c\s*\(([\s\S]*?)\)\s*\)/g)) {
    for (const quoted of call[1].matchAll(/['"]([A-Za-z][A-Za-z0-9._]*)['"]/g)) {
      imports.add(normalizedPackage(quoted[1]))
    }
  }

  return imports
}

test('R import scanning recognizes template dependency forms without treating variables as packages', () => {
  const imports = importedRNamespaces(`
    library(alpha)
    require(package = "Bravo")
    charlie::function_name()
    load_packages(c("delta", 'Echo'))
    library(package, character.only = TRUE)
    # ignored::function_name()
  `)
  assert.deepEqual([...imports].sort(), ['alpha', 'bravo', 'charlie', 'delta', 'echo'])
})

test('every visualization R template import is provided by phi-r declarations or lock closures', () => {
  const spec = parsePhiR()
  const declared = declaredRNamespaces(spec)
  const lockedByPlatform = new Map(
    PHI_PLATFORMS.map((platform) => [platform, lockedRNamespaces(platform)] as const)
  )
  const files = rFiles(VIZ_R_DIR)
  assert.ok(files.length > 0, `no R templates found under ${VIZ_R_DIR}`)

  const uncovered: string[] = []
  let scannedImports = 0
  for (const file of files) {
    for (const imported of importedRNamespaces(readFileSync(file, 'utf8'))) {
      scannedImports += 1
      if (declared.has(imported)) continue
      const missingFromLocks = PHI_PLATFORMS.filter(
        (platform) => !lockedByPlatform.get(platform)?.has(imported)
      )
      if (missingFromLocks.length === 0) continue
      uncovered.push(
        `${relative(REPO_ROOT, file)}: ${imported} (missing from phi-r declarations and ${missingFromLocks.join(', ')} lock closures)`
      )
    }
  }

  assert.ok(scannedImports > 0, `no R package imports found under ${VIZ_R_DIR}`)
  assert.deepEqual(uncovered, [])
})

test('phi-r keeps its notebook and scanpy interoperability declarations', () => {
  const dependencies = new Set(parsePhiR().dependencies.map(condaDependencyName))
  assert.deepEqual(
    ['r-irkernel', 'bioconductor-singlecellexperiment', 'r-seurat'].filter(
      (dependency) => !dependencies.has(dependency)
    ),
    []
  )
})
