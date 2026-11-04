import { OverlayScroll } from './OverlayScroll'
import { useUiLanguage } from '../../../lib/i18n'
import { visualizationCopy, visualizationGroupLabel } from '../lib/visualizationCopy'
import { ButtonBase, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { VisualizationTemplateGroup } from '../../../../../shared/visualizationTemplateTypes'

export function VisualizationGroupPanel({
  groups,
  selectedGroupId,
  totalCount,
  onSelect
}: {
  groups: readonly VisualizationTemplateGroup[]
  selectedGroupId: string | null
  totalCount: number
  onSelect: (groupId: string | null) => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <OverlayScroll
      component="nav"
      aria-label={visualizationCopy.groups}
      data-phi-visualization-groups="true"
      sx={{ width: 168, flexShrink: 0, borderRight: 1, borderColor: 'divider' }}
      contentSx={{ py: 1 }}
    >
      <GroupButton
        label={visualizationCopy.allGroups}
        count={totalCount}
        selected={selectedGroupId === null}
        groupId="all"
        onClick={() => onSelect(null)}
      />
      {groups.map((group) => (
        <GroupButton
          key={group.id}
          label={visualizationGroupLabel(group.id, group.title)}
          count={group.templates.length}
          selected={selectedGroupId === group.id}
          groupId={group.id}
          onClick={() => onSelect(group.id)}
        />
      ))}
    </OverlayScroll>
  )
}

function GroupButton({
  label,
  count,
  selected,
  groupId,
  onClick
}: {
  label: string
  count: number
  selected: boolean
  groupId: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <ButtonBase
      onClick={onClick}
      aria-pressed={selected}
      data-phi-visualization-group={groupId}
      sx={{
        width: '100%',
        justifyContent: 'space-between',
        gap: 1,
        px: 1,
        py: 0.75,
        mt: 0.25,
        borderRadius: 1,
        textAlign: 'left',
        color: selected ? 'primary.main' : 'text.primary',
        bgcolor: (theme) =>
          selected
            ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
            : 'transparent',
        '&:hover': {
          bgcolor: (theme) =>
            alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.08)
        }
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: selected ? 650 : 500, minWidth: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {count}
      </Typography>
    </ButtonBase>
  )
}
