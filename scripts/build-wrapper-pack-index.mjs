#!/usr/bin/env node

// Writes a wrapper pack's `index.json` (every file's sha256 + a pack digest)
// from its `pack.json` and current contents. See
// src/main/agent/wrappers/composition/pack-index.ts for the format.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run wrappers:index                       # the bundled resources/wrappers
//   npm run wrappers:index -- path/to/pack       # another pack root (e.g. an overlay)
//   npm run wrappers:index -- --check [path]     # verify only, exit 1 on mismatch

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { buildWrapperPackIndex, verifyWrapperPack, PACK_INDEX_FILE } = await import(
  new URL('../src/main/agent/wrappers/composition/pack-index.ts', import.meta.url).href
)

const args = process.argv.slice(2)
const check = args.includes('--check')
const target = args.find((arg) => !arg.startsWith('--'))
const packRoot = target ? resolve(target) : join(repoRoot, 'resources', 'wrappers')

if (check) {
  const result = verifyWrapperPack(packRoot)
  if (!result.ok) {
    console.error(`wrapper 包校验失败 (${packRoot})：${result.reason}`)
    process.exit(1)
  }
  console.log(
    `wrapper 包校验通过：${result.index.name}@${result.index.version} ${result.index.digest}`
  )
} else {
  const index = buildWrapperPackIndex(packRoot)
  writeFileSync(join(packRoot, PACK_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf-8')
  const count = Object.keys(index.files).length
  console.log(
    `已写入 ${PACK_INDEX_FILE}：${index.name}@${index.version}，${count} 个文件，digest ${index.digest}`
  )
}
