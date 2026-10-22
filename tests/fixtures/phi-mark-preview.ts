import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from '@mui/material'
import { PhiMark } from '../../src/renderer/src/features/home/components/PhiMark'
import { createAppTheme, createPaletteTheme } from '../../src/renderer/src/theme'

const themes = [
  ['Phi light', createAppTheme('light')],
  ['Phi dark', createAppTheme('dark')],
  ['Asana light', createPaletteTheme('light', 'asana')],
  ['Asana dark', createPaletteTheme('dark', 'asana')]
] as const

const markup = renderToStaticMarkup(
  createElement(
    'main',
    null,
    ...themes.map(([name, theme]) =>
      createElement(
        ThemeProvider,
        { theme, key: name },
        createElement(
          'section',
          { className: 'sample', style: { background: theme.palette.background.default, color: theme.palette.text.primary } },
          createElement('h2', null, name),
          createElement('div', { className: 'icons' }, createElement(PhiMark, { size: 240 }), createElement(PhiMark, { size: 76 }))
        )
      )
    )
  )
)

writeFileSync(
  '/tmp/phi-mark-preview.html',
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px system-ui;background:#eee}main{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px}.sample{height:310px;padding:18px;border-radius:12px}.sample h2{font-size:18px;margin:0 0 14px}.icons{display:flex;align-items:center;gap:24px}</style></head><body>${markup}</body></html>`
)
