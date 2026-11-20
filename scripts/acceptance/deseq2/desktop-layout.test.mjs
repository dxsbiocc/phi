import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDesktopGeometry } from './desktop-layout.mjs'

test('desktop tab clearance and actual hit targets are independent checks', () => {
  const geometry = {
    tabs: 7,
    strip: { left: 300, right: 720 },
    active: { left: 550, right: 710, hit: true },
    toolbar: { left: 728 },
    buttons: ['messages', 'jobs', 'terminal', 'browser'].map((name) => ({ name, hit: true }))
  }
  assert.doesNotThrow(() => assertDesktopGeometry(geometry))
  assert.throws(() => assertDesktopGeometry({ ...geometry, toolbar: { left: 700 } }), /overlaps/)
  assert.throws(
    () => assertDesktopGeometry({ ...geometry, active: { left: 660, right: 816, hit: true } }),
    /clipped/
  )
  assert.throws(
    () =>
      assertDesktopGeometry({
        ...geometry,
        buttons: geometry.buttons.map((b) => ({ ...b, hit: b.name !== 'jobs' }))
      }),
    /intercepted/
  )
})
