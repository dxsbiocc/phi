import { type ReactNode } from 'react'

import { PhiIcons } from '../../../icons'
import { type SyntaxLanguage } from '../../../lib/syntaxHighlight'

const CodeIcon = PhiIcons.tool.command
const PythonIcon = PhiIcons.file.python
const RIcon = PhiIcons.file.r

export function notebookInsertCodeAction(language: SyntaxLanguage): {
  label: string
  renderIcon: (disabled: boolean) => ReactNode
  language: 'code' | 'python' | 'r'
} {
  if (language === 'python') {
    return {
      label: 'Python',
      language: 'python',
      renderIcon: (disabled) => (
        <PythonIcon
          data-phi-notebook-insert-brand-icon="python"
          sx={{ fontSize: 18, opacity: disabled ? 0.58 : 1 }}
        />
      )
    }
  }
  if (language === 'r') {
    return {
      label: 'R',
      language: 'r',
      renderIcon: (disabled) => (
        <RIcon
          data-phi-notebook-insert-brand-icon="r"
          sx={{ fontSize: 19, opacity: disabled ? 0.58 : 1 }}
        />
      )
    }
  }
  return {
    label: 'Code',
    language: 'code',
    renderIcon: (disabled) => (
      <CodeIcon
        data-phi-notebook-insert-brand-icon="code"
        sx={{ fontSize: 18, color: disabled ? 'text.disabled' : '#546E7A' }}
      />
    )
  }
}
