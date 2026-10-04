import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Typography, useTheme } from '@mui/material'
import '@xterm/xterm/css/xterm.css'

import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type TerminalRendererBridge
} from '../../../../shared/terminalTypes'
import type { Project } from '../../lib/projectTypes'
import { TerminalPastePreview } from './components/TerminalPastePreview'
import { TerminalStatusPane, type TerminalStatusKind } from './components/TerminalStatusPane'
import { TerminalTitleBar } from './components/TerminalTitleBar'
import { useTerminalWorkspace } from './hooks/useTerminalWorkspace'
import { isTerminalInputWithinLimit } from './lib/terminalInput'
import { createTerminalTheme } from './lib/terminalTheme'

const RESIZE_THROTTLE_MS = 50

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function estimatedTerminalSize(element: HTMLElement | null): { cols: number; rows: number } {
  if (!element) return { cols: 80, rows: 24 }
  const width = Math.max(0, element.clientWidth - 24)
  const height = Math.max(0, element.clientHeight - 24)
  return {
    cols: clamp(Math.floor(width / 7.85), TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: clamp(Math.floor(height / 16.25), TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
  }
}

interface PanelStatus {
  kind: TerminalStatusKind
  compact: boolean
  exitCode?: number
  message?: string
}

export interface TerminalPanelProps {
  bridge: TerminalRendererBridge
  projects: readonly Project[]
  maximized: boolean
  onToggleMaximize(): void
  onCollapse(): void
}

export default function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const theme = useTheme()
  const workspace = useTerminalWorkspace(props.bridge, props.projects)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [pendingPaste, setPendingPaste] = useState<{
    terminalId: string
    text: string
  } | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const activeId = workspace.activeTerminal?.terminalId ?? null
  const activeView = activeId ? workspace.controller.getTerminalView(activeId) : null
  const ensureWorkspace = workspace.ensure
  const workspaceReady = workspace.ready
  const workspaceTarget = workspace.target
  const terminalTheme = useMemo(() => createTerminalTheme(theme.palette.mode), [theme.palette.mode])

  useEffect(() => {
    if (workspaceTarget === 'remote' || !workspaceReady) return
    void ensureWorkspace(estimatedTerminalSize(viewportRef.current))
  }, [ensureWorkspace, workspaceReady, workspaceTarget])

  useEffect(() => {
    const container = viewportRef.current
    if (!container || !activeView || !activeId) return

    if (activeView.host.parentElement !== container) container.appendChild(activeView.host)
    activeView.setTheme(terminalTheme)
    activeView.setPasteHandler((text) => setPendingPaste({ terminalId: activeId, text }))

    let resizeTimer: number | null = null
    const fit = (): void => {
      resizeTimer = null
      void activeView.fitAndResize()
    }
    const scheduleFit = (): void => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(fit, RESIZE_THROTTLE_MS)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleFit)
    observer?.observe(container)
    window.addEventListener('resize', scheduleFit)
    const frame = window.requestAnimationFrame(() => {
      fit()
      if (workspace.activeTerminal?.state === 'open') activeView.focus()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleFit)
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      // Send the trailing dimensions before the persistent host is detached.
      void activeView.fitAndResize()
      activeView.setPasteHandler(null)
      if (activeView.host.parentElement === container) container.removeChild(activeView.host)
    }
  }, [activeId, activeView, terminalTheme, workspace.activeTerminal?.state])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const createTerminal = (): void => {
    void workspace.create(estimatedTerminalSize(viewportRef.current))
  }
  const visiblePaste = pendingPaste?.terminalId === activeId ? pendingPaste : null
  const cancelPaste = (): void => {
    if (visiblePaste) workspace.controller.discardPaste(visiblePaste.terminalId)
    setPendingPaste(null)
  }
  const sendPaste = (): void => {
    if (!visiblePaste || pasteBusy) return
    if (!isTerminalInputWithinLimit(visiblePaste.text)) {
      workspace.controller.discardPaste(visiblePaste.terminalId)
      setPendingPaste(null)
      setNotice('粘贴内容超过 64 KiB，未发送')
      return
    }
    setPasteBusy(true)
    void workspace.controller
      .submitPaste(visiblePaste.terminalId, visiblePaste.text)
      .then((result) => {
        if (!result.ok) setNotice(result.message)
        setPendingPaste(null)
      })
      .finally(() => setPasteBusy(false))
  }

  let status: PanelStatus | null = null
  const error = workspace.snapshot.error
  useEffect(() => {
    if (
      activeId &&
      error &&
      error.code !== 'limit_reached' &&
      error.code !== 'unsupported_platform'
    ) {
      const timer = window.setTimeout(() => setNotice(error.message), 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [activeId, error])

  if (workspace.target === 'remote') {
    status = { kind: 'remote', compact: false }
  } else if (
    !workspace.ready ||
    !workspace.initialized ||
    (!workspace.activeTerminal && workspace.snapshot.pending)
  ) {
    status = { kind: 'starting', compact: false }
  } else if (error?.code === 'unsupported_platform') {
    status = { kind: 'unsupported', compact: Boolean(workspace.activeTerminal) }
  } else if (error?.code === 'limit_reached') {
    status = { kind: 'limit', compact: Boolean(workspace.activeTerminal) }
  } else if (workspace.activeTerminal?.state === 'starting') {
    status = { kind: 'starting', compact: false }
  } else if (workspace.activeTerminal?.state === 'exited') {
    status = {
      kind: 'exited',
      compact: true,
      exitCode: workspace.activeTerminal.exitCode
    }
  } else if (workspace.activeTerminal?.state === 'failed') {
    status = {
      kind: 'failed',
      compact: true,
      message: workspace.activeTerminal.message || error?.message
    }
  } else if (!workspace.activeTerminal && error) {
    status = { kind: 'failed', compact: false, message: error.message }
  } else if (!workspace.activeTerminal && !workspace.snapshot.pending) {
    status = { kind: 'failed', compact: false, message: '当前没有终端' }
  }

  const canCreate =
    workspace.target !== 'remote' &&
    workspace.ready &&
    error?.code !== 'limit_reached' &&
    error?.code !== 'unsupported_platform'
  return (
    <Box
      data-phi-terminal-panel="true"
      aria-busy={workspace.snapshot.pending || pasteBusy}
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        p: 0.5,
        overflow: 'hidden',
        bgcolor: 'background.default'
      }}
    >
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          borderRadius: '16px',
          bgcolor: terminalTheme.background
        }}
      >
        <TerminalTitleBar
          terminals={workspace.snapshot.terminals}
          activeTerminalId={activeId}
          projectName={workspace.projectName}
          initialDirectory={workspace.initialDirectory}
          maximized={props.maximized}
          canCreate={canCreate}
          busy={workspace.snapshot.pending}
          onSelect={workspace.select}
          onCreate={createTerminal}
          onEnd={(terminalId) => void workspace.close(terminalId)}
          onEndAll={() => void workspace.closeAll()}
          onToggleMaximize={props.onToggleMaximize}
          onCollapse={props.onCollapse}
        />

        <Box
          sx={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <Box
            ref={viewportRef}
            data-phi-terminal-viewport="true"
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              p: 1.5,
              overflow: 'hidden',
              bgcolor: terminalTheme.background,
              WebkitAppRegion: 'no-drag',
              '& .phi-terminal-host, & .xterm': { width: '100%', height: '100%' },
              // xterm.css hard-codes a black viewport; the strip below the last row would show it.
              '& .xterm-viewport': { overflowY: 'auto', backgroundColor: terminalTheme.background }
            }}
          />

          {workspace.activeTerminal?.message && workspace.activeTerminal.state === 'open' ? (
            <Typography
              role="status"
              variant="caption"
              sx={{ px: 1.5, pb: 1, color: 'text.secondary', opacity: 0.78 }}
            >
              {workspace.activeTerminal.message}
            </Typography>
          ) : null}

          {status ? (
            <Box
              sx={
                status.compact
                  ? { flexShrink: 0 }
                  : {
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      bgcolor: terminalTheme.background
                    }
              }
            >
              <TerminalStatusPane
                kind={status.kind}
                compact={status.compact}
                exitCode={status.exitCode}
                message={status.message}
                terminalCount={workspace.snapshot.terminals.length}
                onCreate={canCreate ? createTerminal : undefined}
              />
            </Box>
          ) : null}

          {visiblePaste ? (
            <TerminalPastePreview
              text={visiblePaste.text}
              busy={pasteBusy}
              onSend={sendPaste}
              onCancel={cancelPaste}
            />
          ) : null}

          {notice ? (
            <Box
              role="alert"
              sx={{
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: visiblePaste ? 128 : 12,
                px: 1.25,
                py: 0.75,
                borderRadius: 1,
                bgcolor: 'background.paper',
                color: 'text.primary',
                boxShadow: 4,
                fontSize: 12,
                textAlign: 'center'
              }}
            >
              {notice}
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}
