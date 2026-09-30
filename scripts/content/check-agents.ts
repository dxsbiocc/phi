// Validates every bundled agent under resources/agents/.
// Exits 1 when any agent has errors. Wired into `npm run lint`.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgent } from '../../src/main/agent/agents/definition'

const root = fileURLToPath(new URL('../..', import.meta.url))
const agentsRoot = join(root, 'resources', 'agents')

const files = readdirSync(agentsRoot)
  .filter((name) => name.endsWith('.md'))
  .sort()

let errorTotal = 0
let warningTotal = 0
for (const name of files) {
  const result = validateAgent(join(agentsRoot, name))
  errorTotal += result.errors.length
  warningTotal += result.warnings.length
  console.log(`${name}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`)
  for (const problem of [...result.errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${files.length} agents, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
