import assert from 'node:assert/strict'
import test from 'node:test'
import { carouselSlideMotion } from '../src/renderer/src/features/home/lib/homeCarouselMotion'

test('carousel parks the next card offscreen, then slides it across the frame', () => {
  const parkedNext = carouselSlideMotion(1, 0, 1, 1, false)
  assert.equal(parkedNext.transform, 'translateX(100%)')
  assert.equal(parkedNext.transition, 'none')
  const parkedCurrent = carouselSlideMotion(0, 0, 1, 1, false)
  assert.equal(parkedCurrent.transform, 'translateX(0)')
  assert.equal(parkedCurrent.transition, 'none')

  const entered = carouselSlideMotion(1, 1, null, 1, true)
  assert.equal(entered.transform, 'translateX(0)')
  assert.match(entered.transition, /transform 480ms/)
  const exited = carouselSlideMotion(0, 1, null, 1, true)
  assert.equal(exited.transform, 'translateX(-100%)')
  assert.match(exited.transition, /transform 480ms/)
})

test('carousel reverse sends the incoming card in from the left', () => {
  const parked = carouselSlideMotion(0, 1, 0, -1, false)
  assert.equal(parked.transform, 'translateX(-100%)')
  const exited = carouselSlideMotion(1, 0, null, -1, true)
  assert.equal(exited.transform, 'translateX(100%)')
})
