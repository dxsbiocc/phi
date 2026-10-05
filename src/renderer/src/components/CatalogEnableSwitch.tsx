import { Tooltip } from '@mui/material'
import { styled } from '@mui/material/styles'

const SwitchRoot = styled('span')(({ theme }) => ({
  position: 'relative',
  display: 'inline-flex',
  width: 44,
  height: 44,
  flexShrink: 0,
  '& .checkbox': {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 0,
    opacity: 0,
    cursor: 'pointer',
    zIndex: 1
  },
  '& .checkbox:disabled': { cursor: 'default' },
  '& .track': {
    position: 'absolute',
    left: 5,
    top: 12,
    width: 34,
    height: 20,
    borderRadius: 999,
    backgroundColor: theme.palette.grey[600],
    transition: 'background-color 180ms ease',
    pointerEvents: 'none'
  },
  '& .thumb': {
    position: 'absolute',
    left: 8,
    top: 15,
    width: 14,
    height: 14,
    borderRadius: '50%',
    backgroundColor: theme.palette.common.white,
    boxShadow: theme.shadows[1],
    transition: 'transform 180ms ease',
    pointerEvents: 'none'
  },
  '& .checkbox:checked ~ .track': { backgroundColor: theme.palette.primary.main },
  '& .checkbox:checked ~ .thumb': { transform: 'translateX(14px)' },
  '& .checkbox:focus-visible ~ .track': {
    outline: `2px solid ${theme.palette.primary.main}`,
    outlineOffset: 3
  },
  '& .checkbox:disabled ~ .track, & .checkbox:disabled ~ .thumb': { opacity: 0.45 },
  '@media (prefers-reduced-motion: reduce)': {
    '& .track, & .thumb': { transition: 'none' }
  }
}))

export function CatalogEnableSwitch({
  checked,
  disabled,
  busy,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  busy?: boolean
  label: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Tooltip title={busy ? '正在更新…' : label} enterDelay={400} describeChild>
      <SwitchRoot
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          className="checkbox"
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          aria-checked={checked}
          aria-busy={busy || undefined}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="track" aria-hidden="true" />
        <span className="thumb" aria-hidden="true" />
      </SwitchRoot>
    </Tooltip>
  )
}
