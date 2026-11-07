// Bundles the registry builder into a directory that runs on plain Node.js:
//   bun run build:registry-builder [-- --out <dir>]   (default: dist/registry-builder)
// Output: registry-builder-lib.mjs (the bundled builder) and phi-registry-builder.mjs (the CLI).
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

function outDirFrom(argv: string[]): string {
  const index = argv.indexOf('--out')
  const value = index >= 0 ? argv[index + 1] : undefined
  return resolve(value ?? join(repoRoot, 'dist/registry-builder'))
}

const outDir = outDirFrom(process.argv.slice(2))
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(here, 'build-registry.ts')],
  target: 'node',
  format: 'esm',
  naming: 'registry-builder-lib.mjs',
  outdir: outDir
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const cli = join(outDir, 'phi-registry-builder.mjs')
copyFileSync(join(here, 'registry-builder-cli.mjs'), cli)
chmodSync(cli, 0o755)
console.log(`Standalone registry builder written to ${outDir}`)
