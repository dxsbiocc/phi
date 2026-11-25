import { terminalUi } from '../lib/terminalUi'
import { useUiLanguage } from '../../../lib/i18n'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Box, Divider, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material'

import type { TerminalSnapshot } from '../../../../../shared/terminalTypes'
import { PanelItemSwitcher } from '../../../components/PanelItemSwitcher'
import { useConfirmation } from '../../../components/useConfirmation'
import { PhiIcons } from '../../../icons'
import { runTerminalEndAction } from '../lib/terminalEndAction'
import {
  workspacePanelActionSize,
  workspacePanelHeaderHeight,
  workspacePanelText
} from '../../../layout'

const AddIcon = PhiIcons.action.add
const MoreIcon = PhiIcons.action.more

function terminalDisplayTitle(terminal: TerminalSnapshot): string {
  return terminal.host === 'ssh' && terminal.hostLabel
    ? `${terminal.hostLabel} · ${terminal.title}`
    : terminal.title
}

function terminalTooltip(projectName: string, initialDirectory?: string): string {
  return initialDirectory
    ? terminalUi.valueInitialDirectoryValue(projectName, initialDirectory)
    : projectName
}

function TitleButton(props: {
  label: string
  disabled?: boolean
  onClick(event: MouseEvent<HTMLButtonElement>): void
  children: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Tooltip title={props.label} arrow describeChild>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <IconButton
          type="button"
          aria-label={props.label}
          disabled={props.disabled}
          size="small"
          onClick={props.onClick}
          sx={{
            width: workspacePanelActionSize,
            height: workspacePanelActionSize,
            p: 0.5,
            borderRadius: 1,
            WebkitAppRegion: 'no-drag',
            '&.Mui-focusVisible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2
            }
          }}
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
  switcherDefaultOpen?: boolean
  onSelect(terminalId: string): void
  onCreate(): void
  onOpenAssist(): void
  onExplainSelection(): void
  onEnd(terminalId: string): void
  onEndAll(): void
}

export function TerminalTitleBar(props: TerminalTitleBarProps): React.JSX.Element {
  useUiLanguage()
  const { confirm, confirmationDialog } = useConfirmation()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const activeTerminal =
    props.terminals.find((terminal) => terminal.terminalId === props.activeTerminalId) ?? null
  const initialDirectory = activeTerminal?.initialCwd || props.initialDirectory
  const titleTooltip = terminalTooltip(props.projectName, initialDirectory)

  const closeMenu = (): void => setMenuAnchor(null)
  const endTerminalById = async (terminalId: string): Promise<void> => {
    closeMenu()
    await runTerminalEndAction({
      intent: { kind: 'terminal', terminalId },
      terminalCount: props.terminals.length,
      confirm,
      onEnd: props.onEnd,
      onEndAll: props.onEndAll
    })
  }
  const endAll = async (): Promise<void> => {
    closeMenu()
    await runTerminalEndAction({
      intent: { kind: 'all' },
      terminalCount: props.terminals.length,
      confirm,
      onEnd: props.onEnd,
      onEndAll: props.onEndAll
    })
  }

  return (
    <Box
      data-phi-terminal-title-bar="true"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuAnchor(event.currentTarget)
      }}
      sx={{
        flexShrink: 0,
        height: workspacePanelHeaderHeight,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 1,
        color: 'text.primary'
      }}
    >
      <Box
        title={props.terminals.length <= 1 ? titleTooltip : undefined}
        sx={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {props.terminals.length > 1 ? (
          <PanelItemSwitcher
            ariaLabel={terminalUi.selectTerminal}
            menuLabel={terminalUi.selectTerminal}
            activeId={props.activeTerminalId}
            disabled={props.busy}
            defaultOpen={props.switcherDefaultOpen}
            itemAttribute="data-phi-terminal-item"
            items={props.terminals.map((terminal) => {
              const label = terminalDisplayTitle(terminal)
              return {
                id: terminal.terminalId,
                label,
                tooltip: terminalTooltip(props.projectName, terminal.initialCwd),
                closeLabel: terminalUi.closeTerminalValue(label)
              }
            })}
            onSelect={props.onSelect}
            onCloseItem={(terminalId) => void endTerminalById(terminalId)}
          />
        ) : (
          <Typography
            component="span"
            variant="subtitle2"
            sx={{ ...workspacePanelText.heading, px: 0.5 }}
          >
            {activeTerminal?.host === 'ssh'
              ? terminalDisplayTitle(activeTerminal)
              : terminalUi.terminalTitle}
          </Typography>
        )}
      </Box>

      <TitleButton
        label={terminalUi.newTerminal}
        disabled={!props.canCreate || props.busy}
        onClick={props.onCreate}
      >
        <AddIcon sx={{ fontSize: 16 }} />
      </TitleButton>

      <Box sx={{ flex: 1, minWidth: 8 }} />

      <TitleButton
        label={terminalUi.moreTerminalActions}
        disabled={props.terminals.length === 0}
        onClick={(event) => setMenuAnchor(event.currentTarget)}
      >
        <MoreIcon sx={{ fontSize: 16 }} />
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
        slotProps={{ list: { 'aria-label': terminalUi.terminalActions } }}
      >
        <MenuItem
          disabled={!activeTerminal || props.busy}
          onClick={() => {
            closeMenu()
            props.onOpenAssist()
          }}
        >
          {terminalUi.helpWriteACommand}
        </MenuItem>
        <MenuItem
          disabled={!activeTerminal || !props.canExplainSelection || props.busy}
          onClick={() => {
            closeMenu()
            props.onExplainSelection()
          }}
        >
          {terminalUi.askAgentToExplain}
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={!activeTerminal || props.busy}
          onClick={() => {
            if (activeTerminal) void endTerminalById(activeTerminal.terminalId)
          }}
        >
          {terminalUi.closeTerminal}
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={props.terminals.length === 0 || props.busy}
          onClick={() => void endAll()}
        >
          {terminalUi.closeAllTerminals}
        </MenuItem>
      </Menu>
      {confirmationDialog}
    </Box>
  )
}
