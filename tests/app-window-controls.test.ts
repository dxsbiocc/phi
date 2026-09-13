import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import MacWindowControls from '../src/renderer/src/components/MacWindowControls'

function renderControls(): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MacWindowControls, {
        onClose: () => {},
        onMinimize: () => {},
        onToggleFullscreen: () => {}
      })
    )
  )
}

test('the macOS traffic-light window controls are sized close to native ones, not the old cramped 12px', () => {
  // The window is frameless with native buttons hidden
  // (window.setWindowButtonVisibility(false) in main/index.ts) -- the
  // renderer draws its own close/minimize/fullscreen dots. They were
  // originally 12px with a 10px glyph, which read as visibly smaller than
  // other macOS apps' traffic lights and, being a small target, made hover
  // feel unresponsive.
  const markup = renderControls()

  assert.match(markup, /width:14px/)
  assert.match(markup, /height:14px/)
  assert.match(markup, /font-size:13px/)
  assert.match(markup, /font-weight:900/)
  // font-weight:900 alone still rendered thin -- most fonts fake bold for
  // symbol glyphs like ×/−/⤢ rather than shipping a true black cut, so a
  // text-stroke paints an outline on top to guarantee real thickness.
  assert.match(markup, /-webkit-text-stroke:0\.5px currentcolor/i)
})

test('all three window control buttons exist with distinct macOS colors and correct glyphs', () => {
  const markup = renderControls()

  assert.match(markup, /aria-label="关闭"/)
  assert.match(markup, /background-color:#FF5F57/)
  assert.match(markup, />×</)

  assert.match(markup, /aria-label="最小化"/)
  assert.match(markup, /background-color:#FFBD2E/)
  assert.match(markup, />−</)

  assert.match(markup, /aria-label="全屏"/)
  assert.match(markup, /background-color:#28C840/)
  // Not a plus sign: macOS's real "enter full screen" glyph is a diagonal
  // double-arrow, and a bare "+" reads as "add"/"zoom in", not fullscreen.
  assert.doesNotMatch(markup, />\+</)
  assert.match(markup, />⤢</)
})

test('the reveal-on-hover glyphs start hidden and are not the hover trigger themselves', () => {
  // pointer-events:none on the symbol is load-bearing: the circle (the
  // whole button) must be what receives the hover, not the tiny glyph
  // inside it, or the effective hoverable target shrinks to a few pixels.
  const markup = renderControls()

  const symbolMatches = [...markup.matchAll(/data-phi-mac-window-control-symbol="true"[^>]*>/g)]
  assert.equal(symbolMatches.length, 3)

  const styleBlock = markup.match(/<style[^>]*>([^<]*opacity:0[^<]*)<\/style>/)
  assert.ok(styleBlock, 'expected a style rule with opacity:0 for the hidden glyphs')
  assert.match(styleBlock![1], /pointer-events:none/)
})

test('hover state is tracked on the group so hovering any one dot would reveal all three (native behavior)', () => {
  const markup = renderControls()

  assert.match(markup, /data-phi-mac-window-controls="true"/)
  // Real source uses onMouseEnter/onMouseLeave (JS state), not a CSS
  // `:hover` selector -- see MacWindowControls.tsx for why: elements with
  // -webkit-app-region can miss CSS :hover recalculation in Electron's
  // frameless-window drag-region hit-testing path.
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/MacWindowControls.tsx'),
    'utf8'
  )
  assert.match(source, /onMouseEnter=\{.*setIsHovered\(true\)/)
  assert.match(source, /onMouseLeave=\{.*setIsHovered\(false\)/)
  assert.doesNotMatch(source, /:hover \.window-control-symbol/)
})
