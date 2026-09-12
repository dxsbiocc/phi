import { Box, Button, Tooltip } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { TbSparkles } from 'react-icons/tb'
import { PhiIcons } from '../../../icons'
import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import type { NotebookCellType } from '../../../../../shared/notebookDocument'
import { notebookInsertCodeAction } from './notebookInsertCodeAction'

const MarkdownIcon = PhiIcons.file.markdown

export default function NotebookInsertDock({
  disabled = false,
  codeLanguage = 'plain',
  onGenerateCode,
  onInsert
}: {
  disabled?: boolean
  codeLanguage?: SyntaxLanguage
  onGenerateCode?: () => void
  onInsert: (cellType: Extract<NotebookCellType, 'code' | 'markdown'>) => void | Promise<void>
}): React.JSX.Element {
  const codeAction = notebookInsertCodeAction(codeLanguage)
  const actions = [
    {
      action: 'code' as const,
      label: codeAction.label,
      ariaLabel: `添加 ${codeAction.label} cell`,
      tooltip: `添加 ${codeAction.label} cell`,
      minWidth: codeAction.label === 'R' ? 88 : 136,
      renderIcon: codeAction.renderIcon,
      onClick: () => onInsert('code')
    },
    {
      action: 'markdown' as const,
      label: 'Markdown',
      ariaLabel: '添加 Markdown cell',
      tooltip: '添加 Markdown cell',
      minWidth: 136,
      renderIcon: (disabled: boolean) => (
        <MarkdownIcon
          data-phi-notebook-insert-brand-icon="markdown"
          sx={{
            fontSize: 18,
            opacity: disabled ? 0.52 : 1,
            '& svg, & path': {
              opacity: 1
            }
          }}
        />
      ),
      onClick: () => onInsert('markdown')
    },
    {
      action: 'ai' as const,
      label: 'AI 生成',
      ariaLabel: 'AI 生成代码',
      tooltip: 'AI 生成代码',
      minWidth: 128,
      renderIcon: (disabled: boolean) => (
        <Box
          component="span"
          data-phi-notebook-insert-brand-icon="ai"
          sx={{
            display: 'inline-flex',
            color: disabled ? 'text.disabled' : 'primary.main'
          }}
        >
          <TbSparkles size={18} />
        </Box>
      ),
      onClick: () => {
        if (onGenerateCode) {
          onGenerateCode()
          return
        }
        onInsert('code')
      }
    }
  ]

  return (
    <Box
      data-phi-notebook-insert-dock="compact"
      data-phi-notebook-insert-language={codeAction.language}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pt: 1.7,
        pb: 1.2,
        opacity: disabled ? 0.62 : 1,
        transition: 'opacity 140ms ease',
        '&:hover': { opacity: disabled ? 0.62 : 1 }
      }}
    >
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          overflow: 'hidden',
          border: 1,
          borderColor: (theme) => alpha(theme.palette.text.primary, 0.12),
          borderRadius: 1.4,
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.background.paper, 0.82)
              : alpha(theme.palette.common.white, 0.94),
          boxShadow: (theme) => `0 2px 10px ${alpha(theme.palette.common.black, 0.08)}`
        }}
      >
        {actions.map(
          ({ action, label, ariaLabel, tooltip, minWidth, renderIcon, onClick }, actionIndex) => (
            <Tooltip key={action} title={disabled ? '打开 notebook 后添加 cell' : tooltip}>
              <span>
                <Button
                  size="small"
                  disabled={disabled}
                  aria-label={ariaLabel}
                  data-phi-notebook-insert-action={action}
                  onClick={onClick}
                  startIcon={renderIcon(disabled)}
                  sx={{
                    minWidth,
                    height: 38,
                    px: 1.7,
                    borderRadius: 0,
                    borderRight: actionIndex === actions.length - 1 ? 0 : 1,
                    borderColor: (theme) => alpha(theme.palette.text.primary, 0.1),
                    color: 'text.secondary',
                    fontSize: '0.78rem',
                    fontWeight: 800,
                    letterSpacing: 0,
                    textTransform: 'none',
                    '& .MuiButton-startIcon': {
                      mr: 0.8
                    },
                    '&:hover': {
                      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.06),
                      color: 'text.primary'
                    },
                    '&.Mui-disabled': {
                      color: 'text.disabled'
                    }
                  }}
                >
                  {label}
                </Button>
              </span>
            </Tooltip>
          )
        )}
      </Box>
    </Box>
  )
}
