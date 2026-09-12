export const notebookCodeGutterWidth = 36
export const notebookCodeGutterPaddingRight = 8
// The gutter divider is painted by the stable source/editor frame, not by
// individual line-number rows. A real border participates in width
// calculations differently across the read-only source and CodeMirror DOMs,
// which makes line numbers appear to shift when entering explicit edit mode.
export const notebookCodeGutterDividerWidth = 1
export const notebookCodeContentPaddingX = 9
export const notebookCodeActionPaddingRight = 44
export const notebookCodeFontSizeRem = 0.82
export const notebookCodeLineHeight = 1.65
// Roughly one code line (fontSize * lineHeight) plus the cell's own
// vertical padding, not several lines' worth of reserved blank space --
// used identically by both the read-only highlighted view
// (NotebookCodeCellSource) and the CodeMirror editor (NotebookCodeEditor)
// so toggling edit mode never jumps the cell's height.
export const notebookCodeMinHeight = 44

// MUI's default root font size is 16px, so this is the actual pixel height
// of one rendered code line at notebookCodeFontSizeRem/notebookCodeLineHeight.
const notebookCodeLineHeightPx = 16 * notebookCodeFontSizeRem * notebookCodeLineHeight

// The top/bottom padding that visually centers a single line within
// notebookCodeMinHeight. Deliberately a static number, not CSS
// flex/justify-content: CodeMirror's own layout engine actively resizes
// its internal .cm-scroller to fill its container, which silently defeats
// flex centering there (verified empirically -- the "centered" box
// measured identically to the un-centered one). Fixed padding is the one
// technique both the read-only view and CodeMirror equally respect, so it's
// the only way to make the two states genuinely pixel-identical instead of
// each drifting to its own idea of "centered".
export const notebookCodeVerticalPadding = Math.max(
  0,
  (notebookCodeMinHeight - notebookCodeLineHeightPx) / 2
)
