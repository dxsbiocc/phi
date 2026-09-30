import { alpha, styled } from '@mui/material/styles'

const SwitchRoot = styled('span')(({ theme }) => {
  const onKnob = theme.palette.primary.main
  const offKnob = theme.palette.mode === 'dark' ? '#6E8B90' : '#7A9498'
  const onTrack = alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.28 : 0.16)
  const offTrack = theme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.12)' : '#EEF3F4'
  return {
    position: 'relative',
    display: 'block',
    width: 72,
    height: 28,
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 100,
    '& .checkbox': {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      margin: 0,
      padding: 0,
      opacity: 0,
      cursor: 'pointer',
      zIndex: 3
    },
    '& .checkbox:disabled': { cursor: 'default' },
    '& .knobs, & .layer': {
      position: 'absolute',
      inset: 0,
      borderRadius: 100
    },
    '& .knobs': { zIndex: 2 },
    '& .layer': {
      backgroundColor: offTrack,
      transition: '0.3s ease all',
      zIndex: 1
    },
    '& .knobs:before': {
      content: '"关闭"',
      position: 'absolute',
      top: 3,
      left: 34,
      width: 34,
      height: 22,
      boxSizing: 'border-box',
      color: '#fff',
      fontSize: 10,
      fontWeight: 700,
      textAlign: 'center',
      lineHeight: '22px',
      backgroundColor: offKnob,
      borderRadius: 100,
      transition: '0.3s ease all, left 0.3s cubic-bezier(0.18, 0.89, 0.35, 1.15)'
    },
    '& .checkbox:checked + .knobs:before': {
      content: '"启用"',
      left: 3,
      backgroundColor: onKnob
    },
    '& .checkbox:checked ~ .layer': { backgroundColor: onTrack },
    '& .checkbox:active + .knobs:before': {
      width: 46,
      borderRadius: 100
    },
    '& .checkbox:not(:checked):active + .knobs:before': { marginLeft: '-12px' },
    '@media (prefers-reduced-motion: reduce)': {
      '& .knobs:before, & .layer': { transition: 'none' }
    }
  }
})

export function McpEnableSwitch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
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
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div className="knobs" />
      <div className="layer" />
    </SwitchRoot>
  )
}
