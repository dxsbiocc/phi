import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Box, CircularProgress, List, Stack, Typography } from '@mui/material'
import { PhiIcons } from '../../../icons'
import { CatalogSidebar } from '../../../components/CatalogSidebar'
import { CatalogResourceRow } from '../../../components/CatalogResourceRow'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { DiscoverButton } from '../../../components/DiscoverButton'
import {
  SidebarAccordionGroup,
  SIDEBAR_GROUP_HEADER_HEIGHT
} from '../../../components/SidebarAccordionGroup'
import type { SkillSourceCategory, SkillSummary } from '../../../types'
import {
  skillIsEnabled,
  skillSourceCategoryLabels,
  skillSourceCategoryOrder,
  skillSourceLabel
} from '../lib/skillCatalog'

const SkillIcon = PhiIcons.entity.skill
const BuiltInIcon = PhiIcons.state.verified
const LIST_VERTICAL_PADDING = 16
const EXPANDED_BODY_MIN_HEIGHT = 96

const categoryMarkerColors: Record<SkillSourceCategory, string> = {
  bundled: 'info.main',
  'installed-package': 'secondary.main',
  user: 'success.main',
  project: 'primary.main',
  plugin: 'warning.main'
}

export type SkillSidebarProps = {
  visible?: boolean
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth?: number | string
  onSelectSkill: (skill: SkillSummary) => void
  onSetEnabled?: (skill: SkillSummary, enabled: boolean) => void | Promise<void | boolean>
  busySkillId?: string | null
  onOpenCatalog?: () => void
  notice?: string
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
  groupCount: number,
  visible: boolean
): number {
  const [listHeight, setListHeight] = useState(0)

  useLayoutEffect(() => {
    const node = listRef.current
    if (!node || !visible) return undefined
    // Measure before paint so a newly shown catalog never starts at its minimum height.
    const height = node.offsetHeight
    if (height > 0) setListHeight(height)
    const observer = new ResizeObserver(() => {
      const height = node.offsetHeight
      if (height > 0) setListHeight(height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef, visible, listHeight])

  return Math.max(
    EXPANDED_BODY_MIN_HEIGHT,
    listHeight - groupCount * SIDEBAR_GROUP_HEADER_HEIGHT - LIST_VERTICAL_PADDING
  )
}

export function SkillSidebar({
  visible = true,
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth = '100%',
  onSelectSkill,
  onSetEnabled,
  busySkillId,
  onOpenCatalog,
  notice
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
  const expandedBodyMaxHeight = useExpandedBodyMaxHeight(listRef, sections.length, visible)
  const handleExpandedChange = useCallback(
    (category: SkillSourceCategory, isExpanded: boolean): void => {
      setManualExpandedCategory(isExpanded ? category : null)
    },
    []
  )

  return (
    <CatalogSidebar
      title="技能"
      resource="skills"
      width={sidebarWidth}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="搜索技能"
      summary={`${skills.length} 个技能 · ${enabledCount} 已启用`}
      notice={notice}
      action={
        onOpenCatalog ? <DiscoverButton expanded={false} onClick={onOpenCatalog} /> : undefined
      }
    >
      <List ref={listRef} disablePadding sx={{ overflow: 'hidden', minHeight: 0, flex: 1, py: 1 }}>
        {isLoading && skills.length === 0 ? (
          <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取技能
            </Typography>
          </Stack>
        ) : sections.length > 0 ? (
          sections.map((section) => (
            <SidebarAccordionGroup
              key={section.category}
              expanded={section.category === expandedCategory}
              onExpandedChange={(isExpanded) => handleExpandedChange(section.category, isExpanded)}
              title={section.label}
              count={section.skills.length}
              expandedBodyMaxHeight={expandedBodyMaxHeight}
              leading={
                <Box
                  component="span"
                  sx={{
                    width: 7,
                    height: 7,
                    mr: 0.75,
                    borderRadius: 999,
                    bgcolor: categoryMarkerColors[section.category],
                    flexShrink: 0
                  }}
                />
              }
              titleExtras={
                section.category === 'bundled' ? (
                  <BuiltInIcon title="内置" size={14} sx={{ ml: 0.75, color: 'info.main' }} />
                ) : null
              }
            >
              {section.skills.map((skill) => {
                const enabled = skillIsEnabled(skill)
                return (
                  <CatalogResourceRow
                    key={skill.id}
                    id={skill.id}
                    resource="skills"
                    label={skill.name}
                    enabled={enabled}
                    selected={selectedSkill?.id === skill.id}
                    busy={busySkillId === skill.id}
                    disabledReason={
                      skill.core
                        ? '核心技能由 Phi 依赖，不可关闭'
                        : skill.sourceCategory === 'plugin'
                          ? '由所属插件管理，请在插件中切换'
                          : undefined
                    }
                    onSelect={() => onSelectSkill(skill)}
                    onEnabledChange={
                      onSetEnabled ? (checked) => onSetEnabled(skill, checked) : undefined
                    }
                    icon={
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: 1.25,
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
                        <ResourceIcon icon={skill.icon} kind="skill" size={32} fallbackSize={20} />
                      </Box>
                    }
                  >
                    <Typography
                      noWrap
                      title={skill.name}
                      sx={{ fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.25 }}
                    >
                      {skill.name}
                    </Typography>
                    <Typography
                      noWrap
                      title={skill.description || skillSourceLabel(skill)}
                      color="text.secondary"
                      sx={{ mt: 0.25, fontSize: '0.75rem', lineHeight: 1.25 }}
                    >
                      {skill.description || '这个技能没有提供说明。'}
                    </Typography>
                  </CatalogResourceRow>
                )
              })}
            </SidebarAccordionGroup>
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
    </CatalogSidebar>
  )
}
