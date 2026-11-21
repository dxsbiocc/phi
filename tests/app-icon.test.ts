import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('application icon sources use the Minimal palette and one phi stroke', () => {
  const svg = readFileSync('build/icon.svg', 'utf8')

  assert.match(svg, /#5BE49B/)
  assert.match(svg, /#00A76F/)
  assert.match(svg, /#007867/)
  assert.match(svg, /#004B50/)
  assert.match(svg, /translate\(46 46\) scale\(0\.82\)/)
  assert.match(svg, /feTurbulence type="fractalNoise"/)
  assert.match(svg, /feDisplacementMap/)
  assert.ok((svg.match(/<ellipse\b/g)?.length ?? 0) >= 10)
  assert.doesNotMatch(svg, /<linearGradient id="bg"/)
  assert.equal(svg.match(/<path\b/g)?.length, 1)
})

test('the shared app icon is a lightweight 1024px PNG', () => {
  const image = readFileSync('build/icon.png')

  assert.equal(image.toString('ascii', 1, 4), 'PNG')
  assert.equal(image.readUInt32BE(16), 1024)
  assert.equal(image.readUInt32BE(20), 1024)
  assert.ok(image.byteLength < 512 * 1024, 'startup icon data URL should stay lightweight')
})

test('macOS startup and activation apply the shared Phi icon to the Dock', () => {
  const bootstrap = readFileSync('src/main/bootstrap.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const startup = main.indexOf('function prepareStartupInterface')
  const activation = main.indexOf('function registerAppActivationHandler')

  assert.doesNotMatch(bootstrap, /setActivationPolicy\(['"]accessory['"]\)/)
  assert.match(main, /app\.dock\?\.setIcon\(appIcon\)/)
  assert.ok(startup >= 0 && activation > startup)
  assert.ok(main.slice(startup, activation).includes('applyDockIcon()'))
  assert.ok(main.slice(activation).includes('applyDockIcon()'))
})

test('macOS and Windows icon containers are present and valid', () => {
  const icns = readFileSync('build/icon.icns')
  const ico = readFileSync('build/icon.ico')

  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.ok(icns.byteLength < 1024 * 1024)
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0])
})

test('macOS menu bar template mark is monochrome, transparent, and optically simplified', () => {
  const svg = readFileSync('build/phiTemplate.svg', 'utf8')
  const oneX = readFileSync('build/phiTemplate.png')
  const twoX = readFileSync('build/phiTemplate@2x.png')

  assert.equal(svg.match(/<path\b/g)?.length, 1)
  assert.doesNotMatch(svg, /<(rect|circle|ellipse)\b/)
  assert.match(svg, /fill="none"/)
  assert.match(svg, /stroke="#000000"/)
  assert.match(svg, /stroke-width="3\.2"/)
  assert.equal(oneX.toString('ascii', 1, 4), 'PNG')
  assert.equal(oneX.readUInt32BE(16), 18)
  assert.equal(oneX.readUInt32BE(20), 18)
  assert.equal(twoX.toString('ascii', 1, 4), 'PNG')
  assert.equal(twoX.readUInt32BE(16), 36)
  assert.equal(twoX.readUInt32BE(20), 36)
})
