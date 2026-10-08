import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'

export function ConnectorIcon({
  icon,
  size = 48
}: {
  icon?: ResourceIconRef
  size?: number
}): React.JSX.Element {
  return (
    <ResourceIcon
      icon={icon}
      kind="mcp"
      size={size}
      fallbackSize={Math.round(size * 0.55)}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        bgcolor: 'action.hover',
        color: 'text.secondary'
      }}
    />
  )
}
