
import { PhiIcons } from '../../../icons'
import { SidePanelIconTile } from '../../../components/SidePanelIconTile'
import type { PackageManagerType } from '../../../../../shared/packageManagerTypes'
import type { MessageKind } from '../lib/messages'

const packageIconColors: Record<PackageManagerType, string> = {
  plugin: '#4C8F5B',
  skill: '#5A8FBF',
  wrapper: '#00A98A',
  mcp: '#3C80BC'
}

const appUpdateColor = '#7958D4'

function PackageTypeIcon({ type }: { type: PackageManagerType }): React.JSX.Element {
  switch (type) {
    case 'plugin':
      return <PhiIcons.entity.plugin size={22} />
    case 'skill':
      return <PhiIcons.entity.skill size={22} />
    case 'wrapper':
      return <PhiIcons.entity.wrapper size={22} />
    case 'mcp':
      return <PhiIcons.entity.mcp size={22} />
  }
}

/** The package-type mark is shared with the jobs and catalog surfaces. */
export function MessageIcon({
  kind,
  packageType
}: {
  kind: MessageKind
  packageType?: PackageManagerType
}): React.JSX.Element {
  const type = packageType ?? 'skill'
  return (
    <SidePanelIconTile
      data-phi-message-icon={kind === 'package-update' ? `package-${type}` : kind}
      backgroundColor={kind === 'package-update' ? packageIconColors[type] : appUpdateColor}
    >
      {kind === 'package-update' ? (
        <PackageTypeIcon type={type} />
      ) : (
        <PhiIcons.state.launching size={22} />
      )}
    </SidePanelIconTile>
  )
}
