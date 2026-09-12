import { HighlightStyle } from '@codemirror/language'
import type { Theme } from '@mui/material/styles'
import { tags } from '@lezer/highlight'
import type { SyntaxTokenKind } from './syntaxHighlight'

export function syntaxTokenColor(theme: Theme, kind: SyntaxTokenKind): string {
  const isDark = theme.palette.mode === 'dark'
  const colors: Record<SyntaxTokenKind, string> = isDark
    ? {
        boolean: '#569CD6',
        comment: '#6A9955',
        function: '#DCDCAA',
        keyword: '#C586C0',
        number: '#B5CEA8',
        operator: '#D4D4D4',
        plain: theme.palette.text.primary,
        property: '#9CDCFE',
        punctuation: '#D4D4D4',
        string: '#CE9178',
        type: '#4EC9B0'
      }
    : {
        boolean: '#0000FF',
        comment: '#008000',
        function: '#795E26',
        keyword: '#AF00DB',
        number: '#098658',
        operator: '#000000',
        plain: theme.palette.text.primary,
        property: '#001080',
        punctuation: '#000000',
        string: '#A31515',
        type: '#267F99'
      }

  return colors[kind]
}

export function codeMirrorHighlightStyle(theme: Theme): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.comment, color: syntaxTokenColor(theme, 'comment') },
    { tag: tags.keyword, color: syntaxTokenColor(theme, 'keyword') },
    { tag: [tags.atom, tags.bool], color: syntaxTokenColor(theme, 'boolean') },
    { tag: tags.number, color: syntaxTokenColor(theme, 'number') },
    { tag: tags.string, color: syntaxTokenColor(theme, 'string') },
    { tag: [tags.typeName, tags.className], color: syntaxTokenColor(theme, 'type') },
    { tag: [tags.propertyName, tags.attributeName], color: syntaxTokenColor(theme, 'property') },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: syntaxTokenColor(theme, 'function')
    },
    { tag: tags.operator, color: syntaxTokenColor(theme, 'operator') },
    { tag: tags.punctuation, color: syntaxTokenColor(theme, 'punctuation') },
    { tag: tags.variableName, color: syntaxTokenColor(theme, 'plain') }
  ])
}
