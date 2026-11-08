import { IconButton, Tooltip, type IconButtonProps } from '@mui/material'

type LabeledIconButtonProps = Omit<IconButtonProps, 'aria-label'> & { label: string }

/** An icon-only button whose label is available through a tooltip and aria-label. */
export function LabeledIconButton({
  label,
  children,
  ...rest
}: LabeledIconButtonProps): React.JSX.Element {
  return (
    <Tooltip title={label} enterDelay={500}>
      <span style={{ display: 'inline-flex' }}>
        <IconButton aria-label={label} {...rest}>
          {children}
        </IconButton>
      </span>
    </Tooltip>
  )
}
