import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import type { BrowserRendererBridge, BrowserTabSnapshot } from '../../../../shared/browserTypes'
import { BrowserToolbar } from './components/BrowserToolbar'
import { useBrowserViewport } from './hooks/useBrowserViewport'
import { useBrowserWorkspace } from './hooks/useBrowserWorkspace'
import {
  activeBrowserTab,
  browserErrorMessage,
  browserHistoryCommand,
  browserReloadCommand,
  browserRestoreCommand,
  browserRetryCommand,
  browserSubmitCommand,
  canPresentNativeBrowser
} from './lib/browserPanelState'

export interface BrowserStatusPaneProps {
  activePhiSessionId: string | null
  loading: boolean
  error: string | null
  busy: boolean
  activeTab: BrowserTabSnapshot | null
  nativeEnabled: boolean
  onRestore(): void
  onRetry(): void
}

export function BrowserStatusPane(props: BrowserStatusPaneProps): React.JSX.Element | null {
  let role: 'status' | 'alert' = 'status'
  let title: string
  let detail: string | null = null
  let action: { label: string; run: () => void } | null = null

  if (!props.activePhiSessionId) {
    title = '选择一个会话后即可浏览网页'
    detail = '浏览器会跟随当前会话独立保存页面。'
  } else if (props.loading) {
    title = '正在准备浏览器…'
  } else if (props.error) {
    role = 'alert'
    title = props.error
    detail = '你可以稍后重试。'
  } else if (!props.activeTab) {
    title = '输入网址开始浏览'
    detail = '支持 HTTPS 或 localhost 地址。'
  } else if (props.activeTab.restorable) {
    title = '这个页面可以恢复'
    detail = props.activeTab.title || props.activeTab.url
    action = { label: '恢复页面', run: props.onRestore }
  } else if (props.activeTab.phase === 'failed' || props.activeTab.phase === 'crashed') {
    role = 'alert'
    title =
      props.activeTab.phase === 'crashed'
        ? '页面停止响应'
        : props.activeTab.error
          ? browserErrorMessage(props.activeTab.error)
          : '页面加载失败，请重试。'
    detail = '检查网址或网络连接后重试。'
    action = { label: '重试', run: props.onRetry }
  } else if (!props.nativeEnabled) {
    title = '浏览器内容已暂时隐藏'
    detail = '返回浏览器面板后会继续显示。'
  } else {
    return null
  }

  return (
    <Box
      role={role}
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: 3,
        textAlign: 'center',
        bgcolor: 'background.default',
        color: 'text.primary'
      }}
    >
      <Box sx={{ maxWidth: 280, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {detail ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {detail}
          </Typography>
        ) : null}
        {action ? (
          <Button
            variant="outlined"
            size="small"
            disabled={props.busy}
            onClick={action.run}
            sx={{ mt: 1.5, minHeight: 36 }}
          >
            {action.label}
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}

export interface BrowserPanelProps {
  bridge: BrowserRendererBridge
  activePhiSessionId: string | null
  visible: boolean
}

export default function BrowserPanel(props: BrowserPanelProps): React.JSX.Element {
  const workspace = useBrowserWorkspace(props.bridge, props.activePhiSessionId)
  const currentSnapshot =
    workspace.snapshot?.sessionId === props.activePhiSessionId ? workspace.snapshot : null
  const activeTab = activeBrowserTab(currentSnapshot)
  const [address, setAddress] = useState('')
  const editingAddressRef = useRef(false)
  const nativeEnabled = Boolean(
    currentSnapshot?.capabilities.presentation === 'native' &&
    canPresentNativeBrowser(activeTab, props.visible && !workspace.loading && !workspace.error)
  )
  const viewportRef = useBrowserViewport({
    bridge: props.bridge,
    tabId: activeTab?.id ?? null,
    enabled: nativeEnabled
  })

  useEffect(() => {
    if (!editingAddressRef.current) setAddress(activeTab?.url ?? '')
  }, [activeTab?.url])

  const run = useCallback(
    (command: ReturnType<typeof browserReloadCommand>): void => {
      if (command) void workspace.execute(command)
    },
    [workspace]
  )
  const submitAddress = (): void => {
    if (!props.activePhiSessionId) return
    const command = browserSubmitCommand(currentSnapshot, address, workspace.nextRequestId())
    if (command) void workspace.execute(command)
  }
  const restoreAddress = (): void => setAddress(activeTab?.url ?? '')

  return (
    <Box
      data-phi-browser-panel="true"
      aria-busy={workspace.loading || workspace.busy}
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: 'background.default'
      }}
    >
      <BrowserToolbar
        address={address}
        activeTab={activeTab}
        busy={workspace.busy}
        disabled={!props.activePhiSessionId}
        onAddressChange={setAddress}
        onAddressFocus={() => {
          editingAddressRef.current = true
        }}
        onAddressBlur={() => {
          editingAddressRef.current = false
          restoreAddress()
        }}
        onRestoreAddress={restoreAddress}
        onSubmit={submitAddress}
        onBack={() =>
          run(browserHistoryCommand(currentSnapshot, 'back', workspace.nextRequestId()))
        }
        onForward={() =>
          run(browserHistoryCommand(currentSnapshot, 'forward', workspace.nextRequestId()))
        }
        onReloadOrStop={() => run(browserReloadCommand(currentSnapshot, workspace.nextRequestId()))}
      />
      <Box
        ref={viewportRef}
        data-phi-browser-native-viewport={nativeEnabled ? 'true' : 'false'}
        sx={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden'
        }}
      >
        <BrowserStatusPane
          activePhiSessionId={props.activePhiSessionId}
          loading={workspace.loading}
          error={workspace.error}
          busy={workspace.busy}
          activeTab={activeTab}
          nativeEnabled={nativeEnabled}
          onRestore={() => run(browserRestoreCommand(currentSnapshot, workspace.nextRequestId()))}
          onRetry={() => run(browserRetryCommand(currentSnapshot, workspace.nextRequestId()))}
        />
      </Box>
    </Box>
  )
}
