import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from '@mui/material'
import { PhiMark } from '../src/renderer/src/features/home/components/PhiMark'
import {
  PHI_MARK_CYCLE_MS,
  phiMarkFrameAt
} from '../src/renderer/src/features/home/lib/phiMarkMotion'
import { createAppTheme } from '../src/renderer/src/theme'

test('home mark uses one clock for brush position and painted distance', () => {
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createAppTheme('light') }, createElement(PhiMark))
  )

  assert.doesNotMatch(markup, /<animateMotion\b/)
  assert.doesNotMatch(markup, /phi-mark-trace/)
})

test('brush tip stays at the revealed stroke endpoint for every drawing phase', () => {
  const pathLength = 503.75
  for (const elapsedMs of [0, 320, 640, 1200, 2624, 3600, 4608, 5200, 6000, 6399]) {
    const frame = phiMarkFrameAt(elapsedMs, pathLength)
    assert.ok(Math.abs(pathLength - frame.strokeDashOffset - frame.brushDistance) < 1e-9)
    assert.ok(frame.brushDistance >= 0 && frame.brushDistance <= pathLength)
  }

  const midpoint = phiMarkFrameAt(PHI_MARK_CYCLE_MS * 0.41, pathLength)
  assert.ok(Math.abs(midpoint.brushDistance - pathLength / 2) < 1e-9)
  assert.equal(phiMarkFrameAt(PHI_MARK_CYCLE_MS * 0.1, pathLength).brushOpacity, 1)
  assert.equal(phiMarkFrameAt(PHI_MARK_CYCLE_MS * 0.72, pathLength).brushOpacity, 1)
  assert.equal(phiMarkFrameAt(PHI_MARK_CYCLE_MS * 0.76, pathLength).brushOpacity, 0)
  assert.equal(phiMarkFrameAt(PHI_MARK_CYCLE_MS, pathLength).brushDistance, 0)
})
