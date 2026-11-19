import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureSourceApp, sourceBundleId } from '../scripts/dev-app.mjs'

test(
  'a generated Dock app embeds the source entry and shares the package icon',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'phi-source-dock-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const sdk = join(root, 'Electron SDK.app')
    const contents = join(sdk, 'Contents')
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await mkdir(join(contents, 'Resources'))
    await mkdir(join(root, 'build'))
    const plist = join(contents, 'Info.plist')
    const original =
      '<plist version="1.0"><dict>' +
      [
        'CFBundleIdentifier',
        'CFBundleName',
        'CFBundleDisplayName',
        'CFBundleIconFile',
        'CFBundleShortVersionString'
      ]
        .map((key) => '<key>' + key + '</key><string>sdk</string>')
        .join('') +
      '</dict></plist>'
    await writeFile(plist, original)
    await writeFile(join(contents, 'MacOS', 'Electron'), 'fixture executable', { mode: 0o755 })
    await writeFile(join(contents, 'Resources', 'default_app.asar'), 'sample entry')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ main: './out/main/index.mjs', version: '0.1.7' })
    )
    const icon = join(root, 'build', 'icon.icns')
    await writeFile(icon, 'first canonical asset')

    const bundler = (): ReturnType<typeof ensureSourceApp> =>
      ensureSourceApp(root, { electronAppPath: sdk, sign: false })
    const source = bundler()
    const resources = join(source.appPath, 'Contents', 'Resources')
    assert.equal(source.prepared, true)
    assert.equal(source.bundleId, sourceBundleId(root))
    assert.notEqual(source.bundleId, 'cn.phiscience.phi')
    assert.equal(await readFile(join(resources, 'icon.icns'), 'utf8'), 'first canonical asset')
    assert.equal(existsSync(join(resources, 'default_app.asar')), false)
    assert.equal(existsSync(join(source.appPath, 'Contents', 'MacOS', 'Electron')), true)
    const embedded = join(resources, 'app')
    assert.equal(
      JSON.parse(await readFile(join(embedded, 'source.json'), 'utf8')).entry,
      'out/main/index.mjs'
    )
    assert.match(await readFile(join(embedded, 'main.mjs'), 'utf8'), /app\.setAppPath\(checkout\)/)
    assert.equal(bundler().prepared, false)

    await writeFile(icon, 'updated canonical asset')
    assert.equal(bundler().prepared, true)
    assert.equal(await readFile(join(resources, 'icon.icns'), 'utf8'), 'updated canonical asset')
    assert.equal(await readFile(plist, 'utf8'), original)
    assert.equal(
      await readFile(join(contents, 'Resources', 'default_app.asar'), 'utf8'),
      'sample entry'
    )
  }
)
