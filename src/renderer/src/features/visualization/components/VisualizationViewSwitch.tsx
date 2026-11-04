import { useUiLanguage } from '../../../lib/i18n'
import { visualizationCopy } from '../lib/visualizationCopy'
import { ToggleButton, ToggleButtonGroup } from '@mui/material'

import { PhiIcons } from '../../../icons'

const viewSwitchSx = {
  flexShrink: 0,
  p: 0.25,
  bgcolor: 'action.hover',
  borderRadius: 999,
  '& .MuiToggleButtonGroup-grouped': {
    border: 0,
    borderRadius: '999px !important',
    mx: 0,
    px: 1.25,
    py: 0.4,
    gap: 0.75,
    textTransform: 'none',
    fontSize: 13,
    fontWeight: 650,
    color: 'text.secondary',
    lineHeight: 1.4
  },
  '& .MuiToggleButton-root:hover': { bgcolor: 'transparent' },
  '& .MuiToggleButton-root.Mui-selected': {
    bgcolor: 'background.paper',
    color: 'primary.main',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.12)'
  },
  '& .MuiToggleButton-root.Mui-selected:hover': { bgcolor: 'background.paper' }
}

export function VisualizationViewSwitch({
  segment,
  onChange
}: {
  segment: 'overview' | 'templates'
  onChange: (segment: 'overview' | 'templates') => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={segment}
      aria-label={visualizationCopy.viewMode}
      data-phi-visualization-segment={segment}
      onChange={(_event, value: 'overview' | 'templates' | null) => {
        if (value) onChange(value)
      }}
      sx={viewSwitchSx}
    >
      <ToggleButton value="overview">
        <PhiIcons.file.document size={14} />
        <span>{visualizationCopy.overview}</span>
      </ToggleButton>
      <ToggleButton value="templates">
        <PhiIcons.file.image size={14} />
        <span>{visualizationCopy.templates}</span>
      </ToggleButton>
    </ToggleButtonGroup>
  )
}
