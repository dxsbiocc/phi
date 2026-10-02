import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import type { SkillSourceCategory, SkillSummary } from '../../../types'
import {
  skillIsEnabled,
  skillSourceCategoryLabels,
  skillSourceCategoryOrder,
  skillSourceLabel
} from '../lib/skillCatalog'

const SkillIcon = PhiIcons.entity.skill
const SearchIcon = PhiIcons.action.search
const BuiltInIcon = PhiIcons.state.verified
const ExpandIcon = PhiIcons.action.expand
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const MAC_TITLEBAR_HEIGHT = 44
const CONTENT_TOP_GAP = 8
const ACCORDION_HEADER_HEIGHT = 34
const LIST_VERTICAL_PADDING = 16
const EXPANDED_BODY_MIN_HEIGHT = 96

const categoryMarkerColors: Record<SkillSourceCategory, string> = {
  bundled: 'info.main',
  'installed-package': 'secondary.main',
  user: 'success.main',
  project: 'primary.main',
  plugin: 'warning.main'
}

const plainSidebarRowSx = {
  alignItems: 'center',
  borderRadius: 1.5,
  mx: 1,
  my: 0.25,
  py: 1.25,
  backgroundColor: 'transparent !important',
  transition: 'background-color 120ms ease',
  '&:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.06)} !important`
  },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)} !important`,
    boxShadow: 'none'
  },
  '&.Mui-selected:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)} !important`
  }
} as const

export type SkillSidebarProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth?: number | string
  onSelectSkill: (skill: SkillSummary) => void
  onOpenCatalog?: () => void
}

type SkillSection = {
  category: SkillSourceCategory
  label: string
  skills: SkillSummary[]
}

function groupedSkills(skills: SkillSummary[]): SkillSection[] {
  return skillSourceCategoryOrder
    .map((category) => ({
      category,
      label: skillSourceCategoryLabels[category],
      skills: skills.filter((skill) => skill.sourceCategory === category)
    }))
    .filter((section) => section.skills.length > 0)
}

function useExpandedBodyMaxHeight(
  listRef: RefObject<HTMLUListElement | null>,
  groupCount: number
): number {
  const [listHeight, setListHeight] = useState(0)

  useEffect(() => {
    const node = listRef.current
    if (!node) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setListHeight(rect.height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef])

  return Math.max(
    EXPANDED_BODY_MIN_HEIGHT,
    listHeight - groupCount * ACCORDION_HEADER_HEIGHT - LIST_VERTICAL_PADDING
  )
}

export function SkillSidebar({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth = '100%',
  onSelectSkill,
  onOpenCatalog
}: SkillSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.source, skill.filePath, skillSourceLabel(skill)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, skills])
  const sections = useMemo(() => groupedSkills(filteredSkills), [filteredSkills])
  const selectedSkill = filteredSkills.find((skill) => skill.id === activeSkillId) ?? null
  const enabledCount = skills.filter(skillIsEnabled).length
  const listRef = useRef<HTMLUListElement | null>(null)
  const selectedCategory = selectedSkill?.sourceCategory ?? null
  const [manualExpandedCategory, setManualExpandedCategory] = useState<
    SkillSourceCategory | null | undefined
  >(undefined)
  const [trackedSelectedCategory, setTrackedSelectedCategory] = useState(selectedCategory)
  if (selectedCategory !== trackedSelectedCategory) {
    setTrackedSelectedCategory(selectedCategory)
    if (selectedCategory) setManualExpandedCategory(selectedCategory)
  }
  const expandedCategory =
    manualExpandedCategory !== undefined
      ? manualExpandedCategory
      : (selectedCategory ?? sections[0]?.category ?? null)
  const expandedBodyMaxHeight = useExpandedBodyMaxHeight(listRef, sections.length)
  const handleExpandedChange = useCallback(
    (category: SkillSourceCategory, isExpanded: boolean): void => {
      setManualExpandedCategory(isExpanded ? category : null)
    },
    []
  )

  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${MAC_TITLEBAR_HEIGHT + CONTENT_TOP_GAP}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 700 }}>
            技能
          </Typography>
          {onOpenCatalog ? (
            <Button
              size="small"
              variant="outlined"
              startIcon={<PhiIcons.action.add size={15} />}
              onClick={onOpenCatalog}
              sx={{ WebkitAppRegion: 'no-drag', whiteSpace: 'nowrap' }}
            >
              从目录添加
            </Button>
          ) : null}
        </Stack>
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

      <Box sx={{ px: 2, pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${skills.length} 个技能`} />
          <Chip size="small" color="success" variant="outlined" label={`${enabledCount} 已启用`} />
        </Stack>
      </Box>

      <Divider />
      <List
        ref={listRef}
        disablePadding
        sx={{ overflow: 'hidden', flex: 1, py: 1, backgroundColor: 'transparent !important' }}
      >
        {isLoading && skills.length === 0 ? (
          <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取技能
            </Typography>
          </Stack>
        ) : sections.length > 0 ? (
          sections.map((section) => (
            <Accordion
              key={section.category}
              expanded={section.category === expandedCategory}
              onChange={(_event, isExpanded) => handleExpandedChange(section.category, isExpanded)}
              disableGutters
              elevation={0}
              slotProps={{ transition: { timeout: { enter: 200, exit: 120 } } }}
              sx={{ bgcolor: 'transparent', border: 0, '&::before': { display: 'none' } }}
            >
              <AccordionSummary
                expandIcon={<ExpandIcon fontSize="small" />}
                sx={{
                  height: ACCORDION_HEADER_HEIGHT,
                  minHeight: `${ACCORDION_HEADER_HEIGHT}px !important`,
                  px: 2,
                  py: 0,
                  '& .MuiAccordionSummary-content': { alignItems: 'center', my: 0.5, minWidth: 0 }
                }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', width: '100%' }}>
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      bgcolor: categoryMarkerColors[section.category],
                      flexShrink: 0
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>
                    {section.label}
                  </Typography>
                  {section.category === 'bundled' ? (
                    <BuiltInIcon title="内置" size={14} sx={{ color: 'info.main' }} />
                  ) : null}
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 'auto !important', fontWeight: 700 }}
                  >
                    {section.skills.length}
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  p: 0,
                  ...(section.category === expandedCategory
                    ? { maxHeight: expandedBodyMaxHeight, overflowY: 'auto' }
                    : {})
                }}
              >
                {section.skills.map((skill) => {
                  const enabled = skillIsEnabled(skill)
                  return (
                    <ListItemButton
                      key={skill.id}
                      selected={selectedSkill?.id === skill.id}
                      onClick={() => onSelectSkill(skill)}
                      sx={plainSidebarRowSx}
                    >
                      <Box
                        sx={{
                          width: 46,
                          height: 46,
                          mr: 1.5,
                          borderRadius: 1.75,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: enabled ? 'primary.main' : 'background.paper',
                          border: enabled ? 0 : 1,
                          borderColor: 'divider',
                          color: enabled ? 'primary.contrastText' : 'text.secondary',
                          flexShrink: 0
                        }}
                      >
                        <SkillIcon sx={{ fontSize: 28 }} />
                      </Box>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography
                          noWrap
                          title={skill.name}
                          sx={{ fontSize: '0.92rem', fontWeight: 700, lineHeight: 1.25 }}
                        >
                          {skill.name}
                        </Typography>
                        <Typography
                          noWrap
                          title={skill.description || skillSourceLabel(skill)}
                          color="text.secondary"
                          sx={{ mt: 0.25, fontSize: '0.84rem', lineHeight: 1.25 }}
                        >
                          {skill.description || '这个技能没有提供说明。'}
                        </Typography>
                      </Box>
                    </ListItemButton>
                  )
                })}
              </AccordionDetails>
            </Accordion>
          ))
        ) : (
          <Stack spacing={1} sx={{ py: 4, alignItems: 'center' }}>
            <SkillIcon color="disabled" />
            <Typography variant="body2" color="text.secondary">
              没有找到技能
            </Typography>
          </Stack>
        )}
      </List>
    </Box>
  )
}
