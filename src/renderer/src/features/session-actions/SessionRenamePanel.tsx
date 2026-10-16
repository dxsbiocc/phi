import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { GoX } from 'react-icons/go'
import { TbSparkles } from 'react-icons/tb'

type SessionRenamePanelProps = {
  open: boolean
  title: string
  compactHoverPreview: boolean
  onTitleChange: (title: string) => void
  onClose: () => void
  onSave: () => void
  onGenerateTitle?: () => Promise<string>
  generateTitleDisabledReason?: string
}

export function SessionRenamePanel(props: SessionRenamePanelProps): React.JSX.Element {
  return <SessionRenameDialog key={props.open ? 'open' : 'closed'} {...props} />
}

function SessionRenameDialog({
  open,
  title,
  compactHoverPreview,
  onTitleChange,
  onClose,
  onSave,
  onGenerateTitle,
  generateTitleDisabledReason
}: SessionRenamePanelProps): React.JSX.Element {
  const [generating, setGenerating] = useState(false)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const generationRequestRef = useRef(0)
  const generationPendingRef = useRef(false)

  useEffect(() => {
    return () => {
      generationRequestRef.current += 1
      generationPendingRef.current = false
    }
  }, [])

  const close = (): void => {
    generationRequestRef.current += 1
    generationPendingRef.current = false
    onClose()
  }
  const generateTitle = async (): Promise<void> => {
    if (!open || !onGenerateTitle || generateTitleDisabledReason || generationPendingRef.current) {
      return
    }
    const request = ++generationRequestRef.current
    generationPendingRef.current = true
    setGenerating(true)
    setGenerationError(null)
    try {
      const suggestion = (await onGenerateTitle()).trim()
      if (request !== generationRequestRef.current) return
      if (!suggestion) throw new Error('未生成有效标题，请重试')
      onTitleChange(suggestion)
    } catch (error) {
      if (request !== generationRequestRef.current) return
      setGenerationError(error instanceof Error ? error.message : '标题生成失败，请重试')
    } finally {
      if (request === generationRequestRef.current) {
        generationPendingRef.current = false
        setGenerating(false)
      }
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="xs"
      aria-labelledby="session-rename-title"
      aria-describedby="session-rename-description"
      data-phi-session-rename-dialog="true"
      slotProps={{
        paper: {
          sx: {
            borderRadius: 2.5,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper'
          }
        }
      }}
      sx={compactHoverPreview ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 2 } : undefined}
    >
      <DialogTitle
        id="session-rename-title"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 3,
          pt: 2.5,
          pb: 0.5,
          fontSize: '1.25rem',
          fontWeight: 700
        }}
      >
        <Box component="span">重命名聊天</Box>
        <IconButton
          size="small"
          aria-label="关闭重命名窗口"
          onClick={close}
          sx={{ color: 'text.secondary' }}
        >
          <GoX aria-hidden size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 1 }}>
        <DialogContentText id="session-rename-description" sx={{ fontSize: '0.875rem', mb: 2 }}>
          保持简短且易于识别
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          label="对话标题"
          aria-label="新的对话标题"
          value={title}
          disabled={generating}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 1.5 } }}
          onChange={(event) => onTitleChange(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              !generating &&
              title.trim()
            ) {
              event.preventDefault()
              onSave()
            }
          }}
        />
        {onGenerateTitle && (
          <Box sx={{ mt: 1.5 }}>
            <Tooltip title={generateTitleDisabledReason ?? ''}>
              <span>
                <Button
                  size="small"
                  disabled={generating || Boolean(generateTitleDisabledReason)}
                  onClick={() => void generateTitle()}
                  startIcon={
                    generating ? (
                      <CircularProgress size={15} color="inherit" aria-label="正在生成标题" />
                    ) : (
                      <TbSparkles size={17} aria-hidden />
                    )
                  }
                  sx={{ textTransform: 'none' }}
                >
                  AI 生成标题
                </Button>
              </span>
            </Tooltip>
            {generationError && (
              <Typography role="alert" color="error" sx={{ mt: 0.5, fontSize: '0.8125rem' }}>
                {generationError}
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pt: 1, pb: 2.5, gap: 1 }}>
        <Button variant="outlined" onClick={close} sx={{ minWidth: 76 }}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={generating || !title.trim()}
          onClick={onSave}
          sx={{ minWidth: 76 }}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  )
}
