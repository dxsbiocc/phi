import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { build } from 'vite'

// The renderer reads folder and file icons from material-icon-theme through `import.meta.glob`,
// which only Vite understands. Tests run outside Vite and fall back to reading the disk, so a
// real Vite build is the only way to see what the app gets.
const workdir = mkdtempSync(join(process.cwd(), '.tmp-material-icon-bundling-'))
after(() => rmSync(workdir, { recursive: true, force: true }))

const ENTRY = `
import { directoryIconForPath, fileIconForPath } from '../src/renderer/src/icons'

type Named = { Icon: { displayName?: string } }
const isMissing = (meta: Named): boolean => (meta.Icon.displayName ?? '').endsWith('MissingMaterialIcon')
const missing = [
  ...['data', 'images', 'docs', 'logs', 'reference', 'src'].filter((name) =>
    isMissing(directoryIconForPath('/p/' + name, false) as Named)
  ),
  ...['a.py', 'notes.md', 'x.tsv', 'a.bam', 'cfg.yaml', 'a.R', 'a.ipynb', 'a.fastq', 'a.xlsx'].filter((file) =>
    isMissing(fileIconForPath('/p/' + file) as Named)
  )
]
console.log(JSON.stringify(missing))
`

test('the built renderer finds the folder and file icons that the theme provides', async () => {
  writeFileSync(join(workdir, 'entry.ts'), ENTRY)
  await build({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    build: {
      ssr: join(workdir, 'entry.ts'),
      outDir: join(workdir, 'out'),
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { format: 'esm', entryFileNames: 'entry.mjs' } }
    },
    ssr: { noExternal: true }
  })
  // Run from elsewhere so the on-disk fallback cannot hide icons that were not bundled.
  const output = execFileSync(process.execPath, [join(workdir, 'out', 'entry.mjs')], {
    cwd: tmpdir(),
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1) ?? '[]'), [])
})
