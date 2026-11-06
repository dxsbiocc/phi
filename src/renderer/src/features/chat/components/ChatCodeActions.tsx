import { Button } from '@mui/material'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { MarkdownCodeActionsContext } from '../../../components/markdown/MarkdownCodeActionsContext'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { chatCodeCopy } from '../lib/chatCodeCopy'

function CreateNotebookButton({
  source,
  create
}: {
  source: string
  create: (source: string) => Promise<void>
}): React.JSX.Element {
  useUiLanguage()
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  return (
    <Button
      size="small"
      startIcon={<PhiIcons.nav.analysis sx={{ fontSize: 15 }} />}
      sx={{ minHeight: 28, textTransform: 'none' }}
      disabled={pending}
      onClick={() => {
        if (submitting.current) return
        submitting.current = true
        setPending(true)
        void create(source).finally(() => {
          submitting.current = false
          setPending(false)
        })
      }}
    >
      {chatCodeCopy.createNotebook}
    </Button>
  )
}

export function ChatCodeActions({
  children,
  onRunBash,
  onCreateNotebook
}: {
  children?: ReactNode
  onRunBash?: (source: string) => void
  onCreateNotebook?: (source: string) => Promise<void>
}): React.JSX.Element {
  useUiLanguage()
  const renderAction = useCallback(
    (language: string, source: string): ReactNode => {
      switch (language.toLowerCase()) {
        case 'bash':
        case 'sh':
        case 'shell':
          return onRunBash ? (
            <Button
              size="small"
              startIcon={<PhiIcons.action.run sx={{ fontSize: 15 }} />}
              sx={{ minHeight: 28, textTransform: 'none' }}
              onClick={() => onRunBash(source)}
            >
              {chatCodeCopy.run}
            </Button>
          ) : null
        case 'python':
        case 'python3':
        case 'py':
          return onCreateNotebook ? (
            <CreateNotebookButton source={source} create={onCreateNotebook} />
          ) : null
        default:
          return null
      }
    },
    [onCreateNotebook, onRunBash]
  )

  return (
    <MarkdownCodeActionsContext.Provider value={renderAction}>
      {children}
    </MarkdownCodeActionsContext.Provider>
  )
}
