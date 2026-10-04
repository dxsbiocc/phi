import { useState, type MouseEvent, type ReactNode } from 'react'
import { Box, Divider, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material'

import type { TerminalSnapshot } from '../../../../../shared/terminalTypes'
import { PhiIcons } from '../../../icons'
import { WINDOW_TITLEBAR_HEIGHT } from '../../../lib/windowChromeLayout'

const AddIcon = PhiIcons.action.add
const MoreIcon = PhiIcons.action.more

function TitleButton(props: {
  label: string
  disabled?: boolean
  onClick(event: MouseEvent<HTMLButtonElement>): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip title={props.label} arrow describeChild>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <IconButton
          type="button"
          aria-label={props.label}
          disabled={props.disabled}
          size="small"
          onClick={props.onClick}
          sx={{ width: 32, height: 32, borderRadius: 1.25, WebkitAppRegion: 'no-drag' }}
        >
          {props.children}
        </IconButton>
      </span>
    </Tooltip>
  )
}

export interface TerminalTitleBarProps {
  terminals: readonly TerminalSnapshot[]
  activeTerminalId: string | null
  projectName: string
  initialDirectory?: string
  /** Maximize/close controls owned by the workspace workbench slot. */
  headerActions?: ReactNode
  canCreate?: boolean
  busy?: boolean
  canExplainSelection?: boolean
  onSelect(terminalId: string): void
  onCreate(): void
  onOpenAssist(): void
  onExplainSelection(): void
  onEnd(terminalId: string): void
  onEndAll(): void
}

export function TerminalTitleBar(props: TerminalTitleBarProps): React.JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const activeTerminal =
    props.terminals.find((terminal) => terminal.terminalId === props.activeTerminalId) ?? null
  const initialDirectory = activeTerminal?.initialCwd || props.initialDirectory
  const titleTooltip = initialDirectory
    ? `${props.projectName}\n初始目录：${initialDirectory}`
    : props.projectName

  const openMenu = (event: MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    setMenuAnchor(event.currentTarget)
  }
  const closeMenu = (): void => setMenuAnchor(null)
  const endActive = (): void => {
    closeMenu()
    if (activeTerminal && window.confirm('结束后该终端中正在运行的程序会被终止。')) {
      props.onEnd(activeTerminal.terminalId)
    }
  }
  const openAssist = (): void => {
    closeMenu()
    props.onOpenAssist()
  }
  const explainSelection = (): void => {
    closeMenu()
    props.onExplainSelection()
  }
  const endAll = (): void => {
    closeMenu()
    const count = props.terminals.length
    if (
      count > 0 &&
      window.confirm(`确定结束当前工作区的全部 ${count} 个终端吗？正在运行的程序会被终止。`)
    ) {
      props.onEndAll()
    }
  }

  return (
    <Box
      data-phi-terminal-title-bar="true"
      onContextMenu={openMenu}
      sx={{
        flexShrink: 0,
        height: WINDOW_TITLEBAR_HEIGHT,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1.25,
        color: 'text.primary',
        borderBottom: 1,
        borderColor: 'divider'
      }}
    >
      <Box
        title={titleTooltip}
        sx={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {props.terminals.length > 1 ? (
          <Box
            component="select"
            aria-label="选择终端"
            value={props.activeTerminalId ?? ''}
            disabled={props.busy}
            onChange={(event) => props.onSelect(event.currentTarget.value)}
            sx={{
              maxWidth: 148,
              height: 30,
              pl: 0.75,
              pr: 0.5,
              border: 0,
              borderRadius: 1,
              outline: 0,
              bgcolor: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 14,
              fontWeight: 650,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': {
                outline: (theme) => `2px solid ${theme.palette.primary.main}`
              }
            }}
          >
            {props.terminals.map((terminal) => (
              <option key={terminal.terminalId} value={terminal.terminalId}>
                {terminal.title}
              </option>
            ))}
          </Box>
        ) : (
          <Typography component="span" sx={{ fontSize: 16, fontWeight: 650, px: 0.5 }}>
            Terminal
          </Typography>
        )}
      </Box>

      <TitleButton
        label="新建终端"
        disabled={!props.canCreate || props.busy}
        onClick={props.onCreate}
      >
        <AddIcon sx={{ fontSize: 19 }} />
      </TitleButton>

      <Box sx={{ flex: 1, minWidth: 8 }} />

      <TitleButton
        label="更多终端操作"
        disabled={props.terminals.length === 0}
        onClick={(event) => setMenuAnchor(event.currentTarget)}
      >
        <MoreIcon sx={{ fontSize: 18 }} />
      </TitleButton>
      {props.headerActions ? (
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {props.headerActions}
        </Box>
      ) : null}

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={closeMenu}
        slotProps={{ list: { 'aria-label': '终端操作' } }}
      >
        <MenuItem disabled={!activeTerminal || props.busy} onClick={openAssist}>
          帮我写命令
        </MenuItem>
        <MenuItem
          disabled={!activeTerminal || !props.canExplainSelection || props.busy}
          onClick={explainSelection}
        >
          让 Agent 解释
        </MenuItem>
        <Divider />
        <MenuItem disabled={!activeTerminal || props.busy} onClick={endActive}>
          结束终端
        </MenuItem>
        <Divider />
        <MenuItem disabled={props.terminals.length === 0 || props.busy} onClick={endAll}>
          结束全部终端
        </MenuItem>
      </Menu>
    </Box>
  )
}
