import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseContentSourceArgs, requireSourceDirectory } from './source-roots.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const argv = process.argv.slice(2)
const check = argv.includes('--check')
if (!check && !argv.includes('--source')) {
  throw new Error('Palette sync writes package content; pass --source <phi-packages checkout>.')
}
const sourceRoot = parseContentSourceArgs(
  argv.filter((arg) => arg !== '--check'),
  { defaultToPackages: true }
)
const pluginReferences = requireSourceDirectory(
  sourceRoot,
  'resources/plugins/visualization/skills/omics-visualization/references'
)
const copies = [
  ['resources/palettes/palettes.yaml', join(pluginReferences, 'palettes.yaml')],
  ['resources/palettes/colors.json', join(pluginReferences, 'palettes', 'colors.json')]
]

let drift = false
for (const [sourceRelative, destination] of copies) {
  const source = join(root, sourceRelative)
  if (check) {
    if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination))) {
      console.error(`Generated plugin palette differs from ${sourceRelative}: ${destination}`)
      drift = true
    }
    continue
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  console.log(`Synced ${sourceRelative} -> ${destination}`)
}

if (drift) {
  console.error(
    `Run \`bun run sync:plugin-palettes --source ${sourceRoot}\` and commit the generated copies.`
  )
  process.exit(1)
}
