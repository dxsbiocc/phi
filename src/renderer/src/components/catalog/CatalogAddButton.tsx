import { IconButton } from '@mui/material'
import { PhiIcons } from '../../icons'

export function CatalogAddButton({
  label,
  disabled = false,
  onClick
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <IconButton
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      sx={{
        width: 32,
        height: 32,
        p: 0,
        flexShrink: 0,
        borderRadius: '50%',
        bgcolor: 'primary.main',
        color: 'primary.contrastText',
        '&:hover': { bgcolor: 'primary.dark' },
        '&.Mui-focusVisible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2
        },
        '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' }
      }}
    >
      <PhiIcons.action.add size={20} />
    </IconButton>
  )
}
