import { Alert, Box, CircularProgress, Divider, Stack, Typography } from '@mui/material'

import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import MarkdownContent from '../../../components/MarkdownContent'
import { ResourceIcon } from '../../../components/ResourceIcon'

export interface SkillMarkdownState {
  content: string | null
  isLoading: boolean
  error: string | null
}

export interface SkillDetailBodyProps {
  name: string
  icon?: ResourceIconRef
  /** Draws the icon tile in the active colour. */
  enabled: boolean
  /** One-line origin shown under the name. */
  sourceLabel: string
  chips?: React.ReactNode
  /** A line under the chips, e.g. a deprecation notice. */
  notice?: React.ReactNode
  /** Controls at the right of the header. */
  actions?: React.ReactNode
  description: string
  sourceText: string
  /** The skill's folder on disk; omitted for a package that is not installed. */
  location?: string
  markdown: SkillMarkdownState
  markdownCwd?: string
}

/** Everything the installed skill page and the catalog preview show about one skill. */
export function SkillDetailBody({
  name,
  icon,
  enabled,
  sourceLabel,
  chips,
  notice,
  actions,
  description,
  sourceText,
  location,
  markdown,
  markdownCwd
}: SkillDetailBodyProps): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
      <Box sx={{ width: '100%', maxWidth: 860, mx: 'auto', px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Box
            sx={{
              width: 72,
              height: 72,
              borderRadius: 1,
              bgcolor: enabled ? 'primary.main' : 'action.disabledBackground',
              color: enabled ? 'primary.contrastText' : 'text.secondary',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <ResourceIcon icon={icon} kind="skill" size={72} fallbackSize={24} />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {name}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {sourceLabel}
            </Typography>
            {chips ? (
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                {chips}
              </Stack>
            ) : null}
            {notice}
          </Box>
          {actions ? (
            <Stack spacing={1} sx={{ alignItems: 'flex-end', flexShrink: 0 }}>
              {actions}
            </Stack>
          ) : null}
        </Stack>

        <Divider sx={{ my: 4 }} />
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          说明
        </Typography>
        <Typography variant="body1" sx={{ maxWidth: 720 }}>
          {description || '这个技能没有提供说明。'}
        </Typography>

        <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
          来源
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {sourceText}
        </Typography>

        {location ? (
          <>
            <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
              文件
            </Typography>
            <Typography
              component="code"
              sx={{
                display: 'block',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.84rem',
                color: 'text.secondary',
                overflowWrap: 'anywhere'
              }}
            >
              {location}
            </Typography>
          </>
        ) : null}

        <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
          SKILL.md
        </Typography>
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
                ? 'rgba(255, 255, 255, 0.03)'
                : 'rgba(15, 42, 48, 0.025)',
            overflow: 'auto',
            maxHeight: '62vh'
          }}
        >
          {markdown.isLoading ? (
            <Stack spacing={1} sx={{ py: 4, alignItems: 'center' }}>
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                正在读取 SKILL.md
              </Typography>
            </Stack>
          ) : markdown.error ? (
            <Alert severity="warning" sx={{ m: 2 }}>
              {markdown.error}
            </Alert>
          ) : markdown.content !== null ? (
            <Box
              sx={{
                p: 2,
                minWidth: 0,
                '& [data-phi-markdown-code-language="markdown"]': { whiteSpace: 'pre-wrap' }
              }}
            >
              <MarkdownContent text={markdown.content} cwd={markdownCwd} />
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              选择技能后会在这里显示完整源文。
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}
