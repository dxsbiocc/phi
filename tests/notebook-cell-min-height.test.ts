import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookCodeCellSource from '../src/renderer/src/features/analysis/notebook/NotebookCodeCellSource'
import NotebookCodeEditor from '../src/renderer/src/features/analysis/notebook/NotebookCodeEditor'
import {
  notebookCodeContentPaddingBottom,
  notebookCodeContentPaddingTop,
  notebookCodeGutterPaddingRight,
  notebookCodeMinHeight,
  notebookCodeVisualCenterOffset,
  notebookCodeVerticalPadding
} from '../src/renderer/src/features/analysis/notebook/notebookCellLayout'

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

test('notebookCodeMinHeight reserves roughly one line, not several', () => {
  // Previously hard-coded to 78px per copy -- about 3 lines' worth of
  // reserved blank space -- which left a large empty gap under a one-line
  // cell and meant the editor's visible height didn't budge until you'd
  // typed past line 3. It should now be close to a single code line
  // (fontSize * lineHeight) plus the cell's own vertical padding.
  assert.ok(notebookCodeMinHeight > 20, 'still tall enough for one comfortable line + padding')
  assert.ok(notebookCodeMinHeight < 60, 'no longer reserves several lines of blank space')
})

test('the read-only highlighted source view uses the shared min-height constant', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookCodeCellSource, {
        source: 'print(1)',
        language: 'python',
        editable: true,
        onEdit: () => undefined
      })
    )
  )

  assert.match(markup, new RegExp(`min-height:${notebookCodeMinHeight}px`))
  assert.match(markup, /box-sizing:border-box/)
})

test('the CodeMirror editor mount wrapper uses the shared min-height constant', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookCodeEditor, {
        value: 'print(1)',
        language: 'python',
        onChange: () => undefined
      })
    )
  )

  assert.match(markup, new RegExp(`min-height:${notebookCodeMinHeight}px`))
})

test('both CodeMirror-internal min-heights reference the shared constant, not a hard-coded number', () => {
  const source = readSource('src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx')

  assert.match(source, /'&': \{[\s\S]*?minHeight: `\$\{notebookCodeMinHeight\}px`/)
  assert.match(source, /'&': \{[\s\S]*?boxSizing: 'border-box'/)
  assert.match(source, /'\.cm-content': \{[\s\S]*?minHeight: `\$\{notebookCodeMinHeight\}px`/)
})

test('notebookCodeVerticalPadding is the geometric one-line padding within notebookCodeMinHeight', () => {
  // (minHeight - oneLineHeight) / 2, not a guess.
  const oneLineHeightPx = 16 * 0.82 * 1.65
  const expected = (notebookCodeMinHeight - oneLineHeightPx) / 2
  assert.ok(Math.abs(notebookCodeVerticalPadding - expected) < 0.01)
})

test('code content padding keeps one-line cells optically centered', () => {
  assert.equal(notebookCodeVisualCenterOffset, 3)
  assert.equal(
    notebookCodeContentPaddingTop + notebookCodeContentPaddingBottom,
    notebookCodeVerticalPadding * 2
  )
  assert.ok(
    notebookCodeContentPaddingTop > notebookCodeContentPaddingBottom,
    'font ink is shifted down while total code padding stays stable'
  )
})

test('the read view and the CodeMirror editor align source text identically', () => {
  // This is the actual bug report, not a hypothetical: the read-only view
  // (NotebookCodeCellSource) and the live editor (NotebookCodeEditor) must
  // render source text at the exact same offset. Selection itself must keep
  // the source view mounted and only change the outer cell chrome; explicit
  // edit mode is the only component swap.
  //
  // Note this is deliberately verified as STATIC padding, not
  // flex/justify-content: an earlier attempt centered both with flex, and
  // it silently failed for the editor specifically -- CodeMirror's own
  // .cm-scroller sizing logic force-fills its container regardless of
  // justify-content, which was only caught by actually mounting real
  // CodeMirror in a browser and measuring getBoundingClientRect (see PR
  // discussion). Static padding is the one technique both views equally
  // respect.
  const readViewMarkup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookCodeCellSource, {
        source: 'print(1)',
        language: 'python',
        editable: true,
        onEdit: () => undefined
      })
    )
  )
  assert.doesNotMatch(readViewMarkup, /justify-content:center/)

  const editorSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'
  )
  const editorRootRule = editorSource.match(/'&':\s*\{[^}]*\}/)?.[0] ?? ''
  assert.doesNotMatch(editorRootRule, /justifyContent/)
  assert.doesNotMatch(editorRootRule, /display:/)

  const readViewPaddingTop = readViewMarkup.match(/padding-top:([\d.]+)px/)?.[1]
  const readViewPaddingBottom = readViewMarkup.match(/padding-bottom:([\d.]+)px/)?.[1]
  assert.ok(readViewPaddingTop, 'read view renders a padding-top')
  assert.ok(readViewPaddingBottom, 'read view renders a padding-bottom')
  assert.equal(Number(readViewPaddingTop), notebookCodeContentPaddingTop)
  assert.equal(Number(readViewPaddingBottom), notebookCodeContentPaddingBottom)
  assert.match(readViewMarkup, /box-sizing:border-box/)

  assert.match(
    editorSource,
    /padding:\s*`\$\{notebookCodeContentPaddingTop\}px \$\{notebookCodeActionPaddingRight\}px \$\{notebookCodeContentPaddingBottom\}px/
  )
  assert.match(editorSource, /'&': \{[\s\S]*?boxSizing: 'border-box'/)
})

test('the cell gutter columns (drag handle, run button) no longer force a taller row than a one-line cell needs', () => {
  // Both gutters sit in the same CSS grid row as the code content (grid
  // rows stretch to their tallest cell), so even after the content area
  // itself was shrunk, these two were still separately hard-coded to 54px
  // -- taller than a single code line -- silently re-imposing the same
  // "empty space under one line" bug from the outside.
  const source = readSource('src/renderer/src/features/analysis/notebook/NotebookCell.tsx')
  const minHeight54 = source.match(/minHeight:\s*54\b/g) ?? []
  const gutterMinHeights = source.match(/minHeight:\s*notebookCodeMinHeight/g) ?? []

  assert.equal(minHeight54.length, 0, 'no more hard-coded 54px gutter heights')
  assert.ok(
    gutterMinHeights.length >= 2,
    'left and right gutter columns both use the shared constant'
  )
})

test('line number gutters keep identical width and padding across read and edit states', () => {
  const readViewSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeCellSource.tsx'
  )
  const cellSource = readSource('src/renderer/src/features/analysis/notebook/NotebookCell.tsx')
  const editorSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'
  )

  assert.match(readViewSource, /notebookCodeGutterPaddingRight/)
  assert.match(editorSource, /notebookCodeGutterPaddingRight/)
  assert.doesNotMatch(readViewSource, /notebookCodeGutterDividerWidth/)
  assert.match(cellSource, /notebookCodeGutterDividerWidth/)
  assert.match(editorSource, /notebookCodeGutterDividerWidth/)
  assert.match(readViewSource, /boxSizing: 'border-box'/)
  assert.match(editorSource, /'\.cm-gutters': \{[\s\S]*?boxSizing: 'border-box'/)
  assert.match(editorSource, /'\.cm-gutters': \{[\s\S]*?borderRight: 0/)
  assert.match(editorSource, /'\.cm-gutters': \{[\s\S]*?position: 'relative'/)
  assert.doesNotMatch(editorSource, /boxShadow: `inset -/)
  assert.match(
    editorSource,
    /'\.cm-gutters::after': \{[\s\S]*?top: `\$\{notebookCodeContentPaddingTop\}px`[\s\S]*?bottom: `\$\{notebookCodeContentPaddingBottom\}px`/
  )
  assert.match(editorSource, /'\.cm-activeLineGutter': \{[\s\S]*?boxSizing: 'border-box'/)
  assert.match(editorSource, /padding: `0 \$\{notebookCodeGutterPaddingRight\}px 0 0`/)
  assert.equal(notebookCodeGutterPaddingRight, 8)
})

test('clicking a code cell enters edit mode at the clicked source position', () => {
  const cellSource = readSource('src/renderer/src/features/analysis/notebook/NotebookCell.tsx')
  const codeSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeCellSource.tsx'
  )

  assert.match(cellSource, /const showEditor = editable && isEditing && isCellSelected/)
  assert.match(codeSource, /data-phi-notebook-code-edit-trigger="single-click"/)
  assert.doesNotMatch(codeSource, /data-phi-notebook-code-select-trigger/)
  assert.doesNotMatch(codeSource, /onDoubleClick=/)
  assert.match(
    codeSource,
    /onClick=\{\(event: MouseEvent<HTMLElement>\) => \{\s*if \(editable\) onEdit\(codeSelectionFromClick\(event, source\)\)\s*\}\}/
  )
})

test('the CodeMirror editor keeps long code lines horizontally scrollable instead of wrapping', () => {
  const editorSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'
  )

  assert.match(editorSource, /'\.cm-scroller': \{[\s\S]*?overflow: 'auto'/)
  assert.doesNotMatch(editorSource, /EditorView\.lineWrapping/)
})

test('line numbers are vertically centered without overriding CodeMirror line positioning', () => {
  const readViewSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeCellSource.tsx'
  )
  const editorSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeEditor.tsx'
  )

  assert.match(readViewSource, /display: 'flex'[\s\S]*?alignItems: 'center'/)
  assert.match(readViewSource, /justifyContent: 'flex-end'/)
  assert.match(readViewSource, /minHeight: `\$\{notebookCodeLineHeight\}em`/)
  const editorGutterRule =
    editorSource.match(
      /'\.cm-gutterElement, \.cm-lineNumbers \.cm-gutterElement, \.cm-gutterElement\.cm-activeLineGutter, \.cm-lineNumbers \.cm-gutterElement\.cm-activeLineGutter':[\s\S]*?\n\s*\},/
    )?.[0] ?? ''
  assert.match(editorGutterRule, /lineHeight: String\(notebookCodeLineHeight\)/)
  assert.doesNotMatch(editorGutterRule, /display: 'flex'/)
  assert.doesNotMatch(editorGutterRule, /alignItems/)
  assert.doesNotMatch(editorGutterRule, /minHeight/)
})

test('the read-only gutter divider is frame-level, not one line segment per row', () => {
  const readViewSource = readSource(
    'src/renderer/src/features/analysis/notebook/NotebookCodeCellSource.tsx'
  )
  const cellSource = readSource('src/renderer/src/features/analysis/notebook/NotebookCell.tsx')
  const lineNumberRule =
    readViewSource.match(/component="span"[\s\S]*?userSelect: 'none'[\s\S]*?\}\}/)?.[0] ?? ''

  assert.doesNotMatch(lineNumberRule, /boxShadow/)
  assert.doesNotMatch(readViewSource, /'&::before'/)
  assert.match(
    cellSource,
    /className="cell-source-frame"[\s\S]*?'&::after': \{[\s\S]*?top: `\$\{notebookCodeContentPaddingTop\}px`[\s\S]*?bottom: `\$\{notebookCodeContentPaddingBottom\}px`/
  )
  assert.match(
    cellSource,
    /left: `calc\(\$\{notebookCodeGutterWidth\}px - \$\{notebookCodeGutterDividerWidth\}px\)`/
  )
  assert.match(cellSource, /zIndex: 1/)
})
