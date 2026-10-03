import { isDeepStrictEqual } from 'node:util'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

export interface WrapperDefaultConflict {
  wrapper: string
  param: string
  manifestValue: unknown
  paramsValue: unknown
}

export interface WrapperDefaultMigrationReport {
  wrapperFiles: number
  defaultsFound: number
  defaultsRemoved: number
  paramsAdded: number
  paramsMatched: number
  conflicts: WrapperDefaultConflict[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wrapperManifestPaths(root: string): string[] {
  const paths: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'wrapper.yaml') paths.push(path)
    }
  }
  visit(root)
  return paths.sort()
}

function removeParamDefaults(source: string, paramNames: ReadonlySet<string>): string {
  let inParams = false
  let currentParam: string | undefined
  let removed = 0
  const lines = source.match(/[^\n]*(?:\n|$)/g) ?? []
  const result = lines.filter((line) => {
    if (/^params:\s*(?:#.*)?(?:\r?\n)?$/.test(line)) {
      inParams = true
      currentParam = undefined
      return true
    }
    if (inParams && /^\S/.test(line)) {
      inParams = false
      currentParam = undefined
    }
    if (!inParams) return true
    const param = /^ {2}([a-z][a-z0-9_]*):\s*(?:#.*)?(?:\r?\n)?$/.exec(line)
    if (param) {
      currentParam = param[1]
      return true
    }
    if (currentParam && paramNames.has(currentParam) && /^ {4}default:/.test(line)) {
      removed += 1
      return false
    }
    return true
  })
  if (removed !== paramNames.size) {
    throw new Error(`Expected to remove ${paramNames.size} defaults, removed ${removed}`)
  }
  return result.join('')
}

/**
 * Move legacy `wrapper.yaml` defaults into the sibling `params.json`.
 *
 * A conflicting `params.json` value is never overwritten: the conflict is
 * reported and the forbidden manifest default is removed, leaving
 * `params.json` as the sole defaults authority.
 */
export function migrateWrapperDefaults(root: string): WrapperDefaultMigrationReport {
  const absoluteRoot = resolve(root)
  const wrapperFiles = wrapperManifestPaths(absoluteRoot)
  const report: WrapperDefaultMigrationReport = {
    wrapperFiles: wrapperFiles.length,
    defaultsFound: 0,
    defaultsRemoved: 0,
    paramsAdded: 0,
    paramsMatched: 0,
    conflicts: []
  }

  for (const manifestPath of wrapperFiles) {
    const manifestText = readFileSync(manifestPath, 'utf8')
    const manifest = parse(manifestText) as unknown
    if (!isRecord(manifest) || !isRecord(manifest.params)) continue

    const paramsPath = resolve(manifestPath, '..', 'params.json')
    const params = JSON.parse(readFileSync(paramsPath, 'utf8')) as unknown
    if (!isRecord(params)) throw new Error(`${paramsPath}: params.json must contain an object`)
    let manifestChanged = false
    let paramsChanged = false
    const migratedParams = new Set<string>()

    for (const [paramName, rawParam] of Object.entries(manifest.params)) {
      if (!isRecord(rawParam) || !Object.hasOwn(rawParam, 'default')) continue
      report.defaultsFound += 1
      const manifestValue = rawParam.default
      if (Object.hasOwn(params, paramName)) {
        if (isDeepStrictEqual(params[paramName], manifestValue)) {
          report.paramsMatched += 1
        } else {
          report.conflicts.push({
            wrapper: relative(absoluteRoot, manifestPath).split(sep).join('/'),
            param: paramName,
            manifestValue,
            paramsValue: params[paramName]
          })
        }
      } else {
        params[paramName] = manifestValue
        paramsChanged = true
        report.paramsAdded += 1
      }
      migratedParams.add(paramName)
      manifestChanged = true
      report.defaultsRemoved += 1
    }

    if (paramsChanged) writeFileSync(paramsPath, `${JSON.stringify(params, null, 2)}\n`, 'utf8')
    if (manifestChanged) {
      writeFileSync(manifestPath, removeParamDefaults(manifestText, migratedParams), 'utf8')
    }
  }

  return report
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  const root = process.argv[2] ?? 'resources/wrappers'
  const report = migrateWrapperDefaults(root)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.conflicts.length > 0) process.exitCode = 1
}
