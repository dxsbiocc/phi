// Validates every bundled skill under resources/skills/.
// Exits 1 when any skill has errors. Not part of `npm run lint` until bundled
// skills declare phi.environment.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSkill } from '../../src/main/agent/content/skill'

const root = fileURLToPath(new URL('../..', import.meta.url))
const skillsRoot = join(root, 'resources', 'skills')

const dirs = readdirSync(skillsRoot)
  .filter((name) => {
    try {
      return statSync(join(skillsRoot, name)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

let errorTotal = 0
let warningTotal = 0
for (const name of dirs) {
  const result = validateSkill(join(skillsRoot, name))
  errorTotal += result.errors.length
  warningTotal += result.warnings.length
  console.log(`${name}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`)
  for (const problem of [...result.errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${dirs.length} skills, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
