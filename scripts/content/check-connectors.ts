// Explicit package-content check; defaults to the sibling phi-packages checkout.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { validatePackage, type PackageProblem } from '../../src/main/agent/packages/manifest'
import { parseContentSourceArgs, requireSourceDirectory } from './source-roots.mjs'

const root = parseContentSourceArgs(process.argv.slice(2), { defaultToPackages: true })
const connectorsRoot = requireSourceDirectory(root, 'resources/connectors')
const ids = readdirSync(connectorsRoot)
  .filter((id) => {
    try {
      return statSync(join(connectorsRoot, id)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

let errorTotal = 0
let warningTotal = 0
for (const id of ids) {
  const result = validatePackage(join(connectorsRoot, id))
  const extraErrors: PackageProblem[] = []
  if (result.package && result.package.manifest.type !== 'mcp') {
    extraErrors.push({
      level: 'error',
      path: 'type',
      message: `connector must have type 'mcp', got '${result.package.manifest.type}'`
    })
  }
  if (result.package && result.package.manifest.id !== id) {
    extraErrors.push({
      level: 'error',
      path: 'id',
      message: `package id '${result.package.manifest.id}' must equal directory name '${id}'`
    })
  }
  const errors = [...result.errors, ...extraErrors]
  errorTotal += errors.length
  warningTotal += result.warnings.length
  console.log(`${id}: ${errors.length} error(s), ${result.warnings.length} warning(s)`)
  for (const problem of [...errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${ids.length} connectors, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
