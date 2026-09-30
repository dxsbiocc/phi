// Validates every bundled skill under resources/skills/ and each bundled plugin's skills/.
// Plugin skills are validated with insidePlugin. Exits 1 when any skill has errors.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSkill } from '../../src/main/agent/content/skill'
import { listBundledPlugins } from '../../src/main/agent/plugins/bundled'

const root = fileURLToPath(new URL('../..', import.meta.url))

interface SkillCheck {
  label: string
  dir: string
  insidePlugin: boolean
}

function skillDirs(skillsRoot: string): string[] {
  return readdirSync(skillsRoot)
    .filter((name) => {
      try {
        return statSync(join(skillsRoot, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

const checks: SkillCheck[] = skillDirs(join(root, 'resources', 'skills')).map((name) => ({
  label: name,
  dir: join(root, 'resources', 'skills', name),
  insidePlugin: false
}))

for (const plugin of listBundledPlugins(join(root, 'resources', 'plugins'))) {
  if (!plugin.skillsDir) continue
  for (const name of skillDirs(plugin.skillsDir)) {
    checks.push({
      label: `${plugin.id}/${name}`,
      dir: join(plugin.skillsDir, name),
      insidePlugin: true
    })
  }
}

let errorTotal = 0
let warningTotal = 0
for (const check of checks) {
  const result = validateSkill(check.dir, { insidePlugin: check.insidePlugin })
  errorTotal += result.errors.length
  warningTotal += result.warnings.length
  console.log(
    `${check.label}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
  )
  for (const problem of [...result.errors, ...result.warnings]) {
    console.log(`  ${problem.level} ${problem.path}: ${problem.message}`)
  }
}

console.log(`${checks.length} skills, ${errorTotal} errors, ${warningTotal} warnings`)
if (errorTotal > 0) process.exit(1)
