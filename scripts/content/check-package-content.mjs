import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseContentSourceArgs, phiSourceRoot } from './source-roots.mjs'

const source = parseContentSourceArgs(process.argv.slice(2), { defaultToPackages: true })
for (const name of ['connectors', 'plugins', 'skills']) {
  execFileSync(
    process.execPath,
    [
      '--import',
      join(phiSourceRoot, 'scripts/test-loader.mjs'),
      join(phiSourceRoot, `scripts/content/check-${name}.ts`),
      '--source',
      source
    ],
    { cwd: phiSourceRoot, stdio: 'inherit' }
  )
}
execFileSync(
  process.execPath,
  [join(phiSourceRoot, 'scripts/content/sync-plugin-palettes.mjs'), '--check', '--source', source],
  { cwd: phiSourceRoot, stdio: 'inherit' }
)
