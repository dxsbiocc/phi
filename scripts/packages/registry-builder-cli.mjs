#!/usr/bin/env node
// Standalone Phi registry builder, shipped next to registry-builder-lib.mjs by
// `bun run build:registry-builder`. It needs only Node.js, so a server without Bun or a Phi
// checkout can rebuild the package registry:
//   phi-registry-builder.mjs --source <phi-packages checkout> --out <registry dir>
// The library is imported from a separate file on purpose: inside one bundled file every
// module shares import.meta.url, so their "run when executed directly" guards would all fire.
import { buildRegistryWithReport } from './registry-builder-lib.mjs'

const USAGE = 'usage: phi-registry-builder.mjs --source <phi-packages> --out <registry dir>'

const argv = process.argv.slice(2)
const values = new Map()
for (const name of ['--source', '--out']) {
  const value = argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined
  if (value && !value.startsWith('--')) values.set(name, value)
}
const source = values.get('--source')
const out = values.get('--out')
if (!source || !out) {
  console.error(USAGE)
  process.exit(2)
}

try {
  const { index, report } = buildRegistryWithReport({ repoRoot: source, outDir: out })
  const totalSize = index.packages.reduce((sum, item) => sum + item.size, 0)
  console.log(`Built ${index.packages.length} packages (${totalSize} bytes).`)
  for (const type of Object.keys(report.countsByType).sort()) {
    console.log(`  ${type}: ${report.countsByType[type]} packages`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
