import { useUiLanguage } from '../../../lib/i18n'
import { useState } from 'react'

import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { phiPluginInspectableComponents } from '../lib/phiPluginComponents'
import { PhiPluginComponentDialog } from './PhiPluginComponentDialog'
import {
  PhiPluginComponentSections,
  type PhiPluginComponentSectionItem
} from './PhiPluginComponentSections'

const COMPONENT_ICONS = {
  agent: PhiIcons.entity.agent,
  skill: PhiIcons.entity.skill,
  script: PhiIcons.tool.command
}

export function PhiPluginComponentDetails({
  plugin
}: {
  plugin: PhiPluginDisplayItem
}): React.JSX.Element {
  useUiLanguage()

  const components = phiPluginInspectableComponents(plugin)
  const owner = `${plugin.id}@${plugin.version}`
  const [selected, setSelected] = useState<{ owner: string; key: string } | null>(null)
  const [open, setOpen] = useState(false)
  const inspected =
    selected?.owner === owner
      ? components.find((component) => component.key === selected.key)
      : undefined
  if (selected && !inspected) {
    setSelected(null)
    setOpen(false)
  }
  const SelectedIcon = inspected ? COMPONENT_ICONS[inspected.kind] : null

  function inspect(component: PhiPluginComponentSectionItem): void {
    setSelected({ owner, key: component.key })
    setOpen(true)
  }

  return (
    <>
      <div data-phi-plugin-component-details="true">
        <PhiPluginComponentSections components={components} onInspect={inspect} />
      </div>
      {inspected && SelectedIcon ? (
        <PhiPluginComponentDialog
          plugin={plugin}
          component={inspected}
          open={open}
          icon={<SelectedIcon size={24} />}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
