import { useState, type ReactNode } from 'react'
import { Box } from '@mui/material'
import type { WorkspaceSidebarMode } from '../lib/workspaceSidebar'

const catalogModes: readonly WorkspaceSidebarMode[] = ['plugins', 'skills', 'mcp', 'wrappers']

/** Preserve catalog browsing state without retaining filesystem or session controllers. */
export function RetainedCatalogSidebars({
  mode,
  open,
  scopeKey,
  renderPanel
}: {
  mode: WorkspaceSidebarMode
  open: boolean
  scopeKey: string
  renderPanel: (mode: WorkspaceSidebarMode, visible: boolean) => ReactNode
}): React.JSX.Element {
  const [retained, setRetained] = useState<{ scopeKey: string; modes: WorkspaceSidebarMode[] }>({
    scopeKey,
    modes: []
  })
  const scopeChanged = retained.scopeKey !== scopeKey
  let modes = scopeChanged ? [] : retained.modes
  if (open && catalogModes.includes(mode) && !modes.includes(mode)) modes = [...modes, mode]
  if (scopeChanged || modes !== retained.modes) setRetained({ scopeKey, modes })

  return (
    <>
      {modes.map((panelMode) => (
        <Box
          key={`${scopeKey}:${panelMode}`}
          data-phi-retained-sidebar={panelMode}
          aria-hidden={!open || panelMode !== mode || undefined}
          sx={{
            display: open && panelMode === mode ? 'flex' : 'none',
            height: '100%',
            minHeight: 0,
            overflow: 'hidden'
          }}
        >
          {renderPanel(panelMode, open && panelMode === mode)}
        </Box>
      ))}
      {open && !catalogModes.includes(mode) ? renderPanel(mode, true) : null}
    </>
  )
}
