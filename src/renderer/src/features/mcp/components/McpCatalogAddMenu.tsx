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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const choose = (action: () => void): void => {
    setAnchor(null)
    action()
  }
  return (
    <>
      <CatalogAddButton label="添加连接器" onClick={(event) => setAnchor(event.currentTarget)} />
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => choose(onCustom)}>添加自定义连接器…</MenuItem>
        <MenuItem onClick={() => choose(onGithub)}>从 GitHub 导入…</MenuItem>
        <MenuItem onClick={() => choose(onManageSources)}>管理软件源…</MenuItem>
      </Menu>
    </>
  )
}
