import { Box, Chip } from '@mui/material'
import { PhiIcons } from '../../icons'
import type { InputInvocationReference } from '../../lib/inputReferences'

const AgentIcon = PhiIcons.entity.agent
const SkillIcon = PhiIcons.entity.skill

function referenceLabel(reference: InputInvocationReference): string {
  return reference.name
}

function referenceAriaLabel(reference: InputInvocationReference): string {
  return reference.kind === 'skill'
    ? `移除 Skill 引用 ${reference.name}`
    : `移除智能体引用 ${reference.name}`
}

export function InputReferenceChips({
  references,
  onRemove
}: {
  references: readonly InputInvocationReference[]
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  if (references.length === 0) return null

  return (
    <Box
      data-phi-slot="composer-reference-chips"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        mb: 1.25,
        maxWidth: '100%'
      }}
    >
      {references.map((reference, index) => {
        const Icon = reference.kind === 'skill' ? SkillIcon : AgentIcon
        return (
          <Chip
            key={`${reference.kind}-${reference.name}`}
            data-phi-reference-kind={reference.kind}
            icon={<Icon />}
            label={referenceLabel(reference)}
            variant="outlined"
            onDelete={() => onRemove(index)}
            aria-label={referenceAriaLabel(reference)}
            sx={{
              height: 36,
              maxWidth: '100%',
              borderRadius: 2,
              borderColor: 'divider',
              bgcolor: 'action.hover',
              color: 'text.primary',
              fontWeight: 700,
              fontSize: '0.95rem',
              lineHeight: 1.25,
              '& .MuiChip-icon': {
                color: 'primary.main',
                fontSize: 22,
                ml: 1
              },
              '& .MuiChip-label': {
                minWidth: 0,
                px: 0.75,
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              },
              '& .MuiChip-deleteIcon': {
                color: 'text.secondary',
                fontSize: 22,
                mr: 0.75,
                '&:hover': {
                  color: 'text.primary'
                }
              }
            }}
          />
        )
      })}
    </Box>
  )
}
