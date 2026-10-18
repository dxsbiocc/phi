import { useUiLanguage } from '../../../lib/i18n'
import { connectorCopy } from '../lib/connectorCopy'
import { useState } from 'react'
import { Menu, MenuItem } from '@mui/material'
import { CatalogAddButton } from '../../../components/catalog/CatalogAddButton'

export function McpCatalogAddMenu({
  onCustom,
  onGithub,
  onManageSources
}: {
  onCustom: () => void
  onGithub: () => void
  onManageSources: () => void
}): React.JSX.Element {
  useUiLanguage()

  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const choose = (action: () => void): void => {
    setAnchor(null)
    action()
  }
  return (
    <>
      <CatalogAddButton
        label={connectorCopy.addConnector}
        onClick={(event) => setAnchor(event.currentTarget)}
      />
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => choose(onCustom)}>{connectorCopy.addCustomMenu}</MenuItem>
        <MenuItem onClick={() => choose(onGithub)}>{connectorCopy.importGithubMenu}</MenuItem>
        <MenuItem onClick={() => choose(onManageSources)}>
          {connectorCopy.manageSourcesMenu}
        </MenuItem>
      </Menu>
    </>
  )
}
