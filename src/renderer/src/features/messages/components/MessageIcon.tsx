import { PhiIcons } from '../../../icons'
import { SidePanelIconTile } from '../../../components/SidePanelIconTile'
import type { MessageKind } from '../lib/messages'

const messageIconColors: Record<MessageKind, string> = {
  'package-updates': '#4C8F5B',
  'app-update': '#7958D4'
}

export function MessageIcon({ kind }: { kind: MessageKind }): React.JSX.Element {
  return (
    <SidePanelIconTile data-phi-message-icon={kind} backgroundColor={messageIconColors[kind]}>
      {kind === 'package-updates' ? (
        <PhiIcons.entity.plugin size={22} />
      ) : (
        <PhiIcons.state.launching size={22} />
      )}
    </SidePanelIconTile>
  )
}
