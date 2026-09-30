// Validates every bundled agent under resources/agents/ and each bundled plugin's agents/.
// Exits 1 when any agent has errors. Wired into `npm run lint`.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgent } from '../../src/main/agent/agents/definition'
import { listBundledPlugins } from '../../src/main/agent/plugins/bundled'

const root = fileURLToPath(new URL('../..', import.meta.url))

function agentFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
}

const files: Array<{ label: string; path: string }> = agentFiles(
  join(root, 'resources', 'agents')
).map((name) => ({
  label: name,
  path: join(root, 'resources', 'agents', name)
}))

for (const plugin of listBundledPlugins(join(root, 'resources', 'plugins'))) {
  if (!plugin.agentsDir) continue
  for (const name of agentFiles(plugin.agentsDir)) {
    files.push({
      label: `${plugin.id}/${name}`,
      path: join(plugin.agentsDir, name)
    })
  }
}

let errorTotal = 0
let warningTotal = 0
for (const file of files) {
  const result = validateAgent(file.path)
  errorTotal += result.errors.length
  warningTotal += result.warnings.length
  console.log(
    `${file.label}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
  )
  for (const problem of [...result.errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${files.length} agents, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
