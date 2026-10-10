import { Box, ListItemButton, ListItemIcon, ListItemText, Paper, Typography } from '@mui/material'
import type { ResourceIconRef } from '../../../../shared/resourceIconTypes'
import type { InputInvocationReferenceKind } from '../../lib/inputReferences'
import { ResourceIcon } from '../ResourceIcon'

export type InputInvocationReferenceCandidate = {
  icon?: ResourceIconRef
  kind: InputInvocationReferenceKind
  name: string
  description: string
  referenceText: string
}

export type InputInvocationReferenceMenuState = {
  kind: InputInvocationReferenceKind
  query: string
  operator: string
  candidates: InputInvocationReferenceCandidate[]
}

type InputInvocationReferenceMenuProps = {
  state: InputInvocationReferenceMenuState
  highlightedIndex: number
  onHighlight: (index: number) => void
  onSelect: (candidate: InputInvocationReferenceCandidate) => void
}

function menuTitle(state: InputInvocationReferenceMenuState): string {
  const label = state.kind === 'skill' ? 'Skill' : '智能体'
  return `${state.operator}${state.query || label}`
}

function emptyText(kind: InputInvocationReferenceKind): string {
  return kind === 'skill' ? '没有匹配 Skill' : '没有匹配智能体'
}

function InputInvocationReferenceRow({
  candidate,
  highlighted,
  onHighlight,
  onSelect
}: {
  candidate: InputInvocationReferenceCandidate
  highlighted: boolean
  onHighlight: () => void
  onSelect: () => void
}): React.JSX.Element {
  return (
    <ListItemButton
      dense
      role="option"
      aria-selected={highlighted}
      selected={highlighted}
      title={candidate.description || candidate.name}
      onMouseEnter={onHighlight}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      sx={{
        borderRadius: 1.5,
        minHeight: 42,
        gap: 0.75,
        px: 1,
        py: 0.5,
        '&.Mui-selected': {
          bgcolor: 'action.hover',
          '&:hover': { bgcolor: 'action.selected' }
        }
      }}
    >
      <ListItemIcon sx={{ minWidth: 30, color: 'primary.main' }}>
        <ResourceIcon icon={candidate.icon} kind={candidate.kind} size={24} fallbackSize={18} />
      </ListItemIcon>
      <ListItemText
        primary={candidate.name}
        secondary={candidate.description || undefined}
        slotProps={{
          primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 750 } },
          secondary: { noWrap: true, sx: { fontSize: '0.78rem' } }
        }}
      />
    </ListItemButton>
  )
}

export function InputInvocationReferenceMenu({
  state,
  highlightedIndex,
  onHighlight,
  onSelect
}: InputInvocationReferenceMenuProps): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      role="listbox"
      aria-label="引用 Skill 或智能体"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        bgcolor: 'background.paper',
        maxHeight: 'min(300px, calc(100vh - 260px))',
        overflowY: 'auto',
        p: 0.75
      }}
    >
      <Box sx={{ px: 1, pt: 0.5, pb: 0.75 }}>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontSize: '0.8rem', fontWeight: 800, letterSpacing: 0 }}
        >
          {menuTitle(state)}
        </Typography>
      </Box>
      {state.candidates.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            px: 1.25,
            py: 1,
            minHeight: 38,
            display: 'flex',
            alignItems: 'center'
          }}
        >
          {emptyText(state.kind)}
        </Typography>
      ) : (
        state.candidates.map((candidate, index) => (
          <InputInvocationReferenceRow
            key={`${candidate.kind}-${candidate.name}`}
            candidate={candidate}
            highlighted={index === highlightedIndex}
            onHighlight={() => onHighlight(index)}
            onSelect={() => onSelect(candidate)}
          />
        ))
      )}
    </Paper>
  )
}
