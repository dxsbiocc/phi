// Validates every bundled Phi plugin under resources/plugins/. Exits 1 on errors.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validatePlugin } from '../../src/main/agent/plugins/validate'

const root = fileURLToPath(new URL('../..', import.meta.url))
const pluginsRoot = join(root, 'resources', 'plugins')
const ids = readdirSync(pluginsRoot)
  .filter((id) => {
    try {
      return statSync(join(pluginsRoot, id)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

let errorTotal = 0
let warningTotal = 0
for (const id of ids) {
  const result = validatePlugin(join(pluginsRoot, id))
  errorTotal += result.errors.length
  warningTotal += result.warnings.length
  console.log(`${id}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`)
  for (const problem of [...result.errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${ids.length} plugins, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
