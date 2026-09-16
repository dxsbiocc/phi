import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import type { SkillSummary } from '../../types'

const SkillIcon = PhiIcons.entity.skill
const SearchIcon = PhiIcons.action.search

type SidebarWidth = number | string

export type SkillViewProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth: number
  onSelectSkill: (id: string) => void
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void
}

export type SkillSidebarProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth?: SidebarWidth
  onSelectSkill: (skill: SkillSummary) => void
}

export type SkillDetailProps = {
  selectedSkill: SkillSummary | null
}

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const plainSidebarRowSx = {
  alignItems: 'flex-start',
  py: 1.25,
  backgroundColor: 'transparent !important',
  '&:hover': { backgroundColor: 'transparent !important' },
  '&.Mui-selected': {
    backgroundColor: 'transparent !important',
    boxShadow: (theme: Theme) => `inset 3px 0 0 ${theme.palette.primary.main}`
  },
  '&.Mui-selected:hover': { backgroundColor: 'transparent !important' }
} as const

function sourceLabel(skill: SkillSummary): string {
  return `${skill.scope} · ${skill.source}`
}

function selectedSkillFromList(
  skills: SkillSummary[],
  activeSkillId: string | null
): SkillSummary | null {
  return skills.find((skill) => skill.id === activeSkillId) ?? skills[0] ?? null
}

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
      }}
    />
  )
}

function DetailPage({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          height: macTitlebarHeight,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
          zIndex: 7
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

export function SkillSidebar({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth = '100%',
  onSelectSkill
}: SkillSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.source, skill.filePath, skill.scope]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, skills])
  const selectedSkill = selectedSkillFromList(filteredSkills, activeSkillId)
  const enabledCount = skills.filter((skill) => !skill.disabled).length

  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Typography variant="subtitle1" sx={{ display: 'block', mb: 1.5, fontWeight: 700 }}>
          技能
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索技能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ WebkitAppRegion: 'no-drag' }}
        />
      </Box>

      <Box sx={{ px: 2, pb: 1, WebkitAppRegion: 'no-drag' }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${skills.length} 个技能`} />
          <Chip size="small" color="success" variant="outlined" label={`${enabledCount} 可用`} />
        </Stack>
      </Box>

      <Divider />

      <List
        disablePadding
        sx={{
          overflowY: 'auto',
          flex: 1,
          py: 1,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isLoading && skills.length === 0 ? (
          <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取技能
            </Typography>
          </Stack>
        ) : (
          filteredSkills.map((skill) => (
            <ListItemButton
              key={skill.id}
              selected={selectedSkill?.id === skill.id}
              onClick={() => onSelectSkill(skill)}
              sx={plainSidebarRowSx}
            >
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  mr: 1.25,
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: skill.disabled ? 'background.paper' : 'primary.main',
                  border: skill.disabled ? 1 : 0,
                  borderColor: 'divider',
                  color: skill.disabled ? 'text.secondary' : 'primary.contrastText',
                  flexShrink: 0
                }}
              >
                <SkillIcon fontSize="small" />
              </Box>
              <ListItemText
                primary={skill.name}
                secondary={skill.description || sourceLabel(skill)}
                slotProps={{
                  primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 600 } },
                  secondary: {
                    sx: {
                      fontSize: '0.8rem',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }
                  }
                }}
              />
            </ListItemButton>
          ))
        )}
      </List>
    </Box>
  )
}

export function SkillDetail({ selectedSkill }: SkillDetailProps): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {selectedSkill ? (
        <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: 1,
                bgcolor: selectedSkill.disabled ? 'action.disabledBackground' : 'primary.main',
                color: selectedSkill.disabled ? 'text.secondary' : 'primary.contrastText',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <SkillIcon />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selectedSkill.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {sourceLabel(selectedSkill)}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip
                  size="small"
                  color={selectedSkill.disabled ? 'default' : 'success'}
                  label={selectedSkill.disabled ? '仅手动调用' : '可自动调用'}
                />
                <Chip size="small" variant="outlined" label={selectedSkill.scope} />
              </Stack>
            </Box>
          </Stack>

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            说明
          </Typography>
          <Typography variant="body1" sx={{ maxWidth: 720 }}>
            {selectedSkill.description || '这个技能没有提供说明。'}
          </Typography>

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
            {selectedSkill.filePath}
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1} sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <SkillIcon color="disabled" />
          <Typography color="text.secondary">没有找到技能</Typography>
        </Stack>
      )}
    </Box>
  )
}

export default function SkillView({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth,
  onSelectSkill,
  onStartSidebarResize
}: SkillViewProps): React.JSX.Element {
  const selectedSkill = selectedSkillFromList(skills, activeSkillId)

  return (
    <>
      <SkillSidebar
        skills={skills}
        isLoading={isLoading}
        activeSkillId={activeSkillId}
        sidebarWidth={sidebarWidth}
        onSelectSkill={(skill) => onSelectSkill(skill.id)}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selectedSkill?.name ?? '技能'}>
        <SkillDetail selectedSkill={selectedSkill} />
      </DetailPage>
    </>
  )
}
