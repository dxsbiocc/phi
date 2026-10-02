// Validates every bundled MCP connector under resources/connectors/. Exits 1 on errors.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validatePackage, type PackageProblem } from '../../src/main/agent/packages/manifest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const connectorsRoot = join(root, 'resources', 'connectors')
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
      message: `bundled connector must have type 'mcp', got '${result.package.manifest.type}'`
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
