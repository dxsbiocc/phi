import { type MouseEvent } from 'react'
import { Box } from '@mui/material'
import {
  notebookCodeActionPaddingRight,
  notebookCodeContentPaddingBottom,
  notebookCodeContentPaddingTop,
  notebookCodeContentPaddingX,
  notebookCodeGutterPaddingRight,
  notebookCodeFontSizeRem,
  notebookCodeGutterWidth,
  notebookCodeLineHeight,
  notebookCodeMinHeight
} from './notebookCellLayout'
import { highlightLine, type SyntaxLanguage } from '../../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../../lib/syntaxTheme'

function HighlightedCodeLines({
  source,
  language
}: {
  source: string
  language: SyntaxLanguage
}): React.JSX.Element {
  const lines = source.length > 0 ? source.split('\n') : ['']

  return (
    <Box
      data-phi-code-layout="fixed-gutter"
      sx={{
        display: 'grid',
        gridTemplateColumns: `${notebookCodeGutterWidth}px minmax(0, 1fr)`,
        minWidth: 0
      }}
    >
      <Box
        data-phi-code-line-gutter="true"
        aria-hidden="true"
        sx={{
          width: `${notebookCodeGutterWidth}px`,
          minWidth: `${notebookCodeGutterWidth}px`
        }}
      >
        {lines.map((_, lineIndex) => (
          <Box
            key={lineIndex}
            component="span"
            sx={{
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              width: `${notebookCodeGutterWidth}px`,
              minWidth: `${notebookCodeGutterWidth}px`,
              minHeight: `${notebookCodeLineHeight}em`,
              lineHeight: notebookCodeLineHeight,
              pr: `${notebookCodeGutterPaddingRight}px`,
              pl: 0,
              m: 0,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
              color: 'text.disabled',
              userSelect: 'none'
            }}
          >
            {lineIndex + 1}
          </Box>
        ))}
      </Box>
      <Box
        data-phi-code-scroll-pane="true"
        sx={{
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden'
        }}
      >
        {lines.map((line, lineIndex) => (
          <Box
            key={lineIndex}
            data-phi-code-line-index={lineIndex}
            sx={{
              width: 'max-content',
              minWidth: '100%',
              minHeight: `${notebookCodeLineHeight}em`,
              lineHeight: notebookCodeLineHeight
            }}
          >
            <Box
              component="code"
              data-phi-code-line-text="true"
              sx={{
                display: 'block',
                px: `${notebookCodeContentPaddingX}px`,
                whiteSpace: 'pre'
              }}
            >
              {highlightLine(line, language).map((token, tokenIndex) => (
                <Box
                  key={`${lineIndex}-${tokenIndex}`}
                  component="span"
                  data-phi-syntax-token={token.kind}
                  sx={{ color: (theme) => syntaxTokenColor(theme, token.kind) }}
                >
                  {token.value}
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function lineStartOffset(source: string, lineIndex: number): number {
  const lines = source.split('\n')
  return lines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0)
}

function textOffsetWithinNode(root: Node, target: Node, targetOffset: number): number | null {
  const document = root.ownerDocument
  if (!document) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let node = walker.nextNode()
  while (node) {
    if (node === target) {
      return offset + Math.max(0, Math.min(targetOffset, node.textContent?.length ?? 0))
    }
    offset += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  return null
}

function caretOffsetFromPoint(root: HTMLElement, x: number, y: number): number | null {
  const document = root.ownerDocument
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = caretDocument.caretPositionFromPoint?.(x, y)
  if (position && root.contains(position.offsetNode)) {
    return textOffsetWithinNode(root, position.offsetNode, position.offset)
  }
  const range = caretDocument.caretRangeFromPoint?.(x, y)
  if (range && root.contains(range.startContainer)) {
    return textOffsetWithinNode(root, range.startContainer, range.startOffset)
  }
  return null
}

function approximateLineOffsetFromPoint(root: HTMLElement, line: string, x: number): number {
  const rect = root.getBoundingClientRect()
  const computedStyle = root.ownerDocument.defaultView?.getComputedStyle(root)
  const fontSize = Number.parseFloat(computedStyle?.fontSize ?? '') || 13
  const columnWidth = fontSize * 0.62
  const rawColumn = Math.round((x - rect.left - notebookCodeContentPaddingX) / columnWidth)
  return Math.max(0, Math.min(line.length, rawColumn))
}

function codeSelectionFromClick(
  event: MouseEvent<HTMLElement>,
  source: string
): number | undefined {
  const target = event.target instanceof HTMLElement ? event.target : null
  const lineElement = target?.closest<HTMLElement>('[data-phi-code-line-index]')
  if (!lineElement) return undefined
  const lineIndex = Number(lineElement.dataset.phiCodeLineIndex)
  if (!Number.isFinite(lineIndex)) return undefined
  const line = source.split('\n')[lineIndex] ?? ''
  const codeElement = lineElement.querySelector<HTMLElement>('[data-phi-code-line-text="true"]')
  if (!codeElement) return lineStartOffset(source, lineIndex)
  const offsetInLine = caretOffsetFromPoint(codeElement, event.clientX, event.clientY)
  const resolvedOffset =
    offsetInLine ?? approximateLineOffsetFromPoint(codeElement, line, event.clientX)
  return lineStartOffset(source, lineIndex) + resolvedOffset
}

export default function NotebookCodeCellSource({
  source,
  language,
  editable,
  onEdit,
  onRun
}: {
  source: string
  language: SyntaxLanguage
  editable: boolean
  onEdit: (selection?: number) => void
  onRun?: () => void
}): React.JSX.Element {
  return (
    <Box
      data-phi-notebook-code="highlighted"
      data-phi-syntax-language={language}
      data-phi-notebook-code-edit-trigger="single-click"
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (editable) onEdit(codeSelectionFromClick(event, source))
      }}
      onKeyDown={(event) => {
        if (!editable) return
        if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.stopPropagation()
          onRun?.()
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
      sx={{
        boxSizing: 'border-box',
        minHeight: notebookCodeMinHeight,
        // CodeMirror uses the same static top/bottom values when the user
        // explicitly enters edit mode; simple selection keeps this source view
        // mounted, so only the outer cell chrome changes.
        pt: `${notebookCodeContentPaddingTop}px`,
        pb: `${notebookCodeContentPaddingBottom}px`,
        pr: `${notebookCodeActionPaddingRight}px`,
        cursor: editable ? 'text' : 'default',
        overflowX: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: `${notebookCodeFontSizeRem}rem`,
        lineHeight: notebookCodeLineHeight,
        '&:focus-visible': {
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2
        }
      }}
    >
      <HighlightedCodeLines source={source} language={language} />
    </Box>
  )
}
