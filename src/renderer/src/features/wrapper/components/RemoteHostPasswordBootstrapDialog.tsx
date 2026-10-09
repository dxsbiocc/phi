import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography
} from '@mui/material'

import { useRemoteHostPasswordBootstrap } from '../hooks/useRemoteHostPasswordBootstrap'
import type {
  RemoteHostPasswordBootstrapClient,
  SshBootstrapFinalResult,
  SshBootstrapTarget,
  SshBootstrapUiActions,
  SshBootstrapUiModel
} from '../lib/sshBootstrapUi'

export function RemoteHostPasswordBootstrapDialog({
  open,
  target,
  client,
  onClose,
  onCompleted
}: {
  open: boolean
  target: SshBootstrapTarget
  client: RemoteHostPasswordBootstrapClient
  onClose: () => void
  onCompleted?: (result: SshBootstrapFinalResult) => void
}): React.JSX.Element | null {
  if (!open) return null
  const targetKey = `${target.alias}\0${target.hostname}\0${target.user}\0${target.port}`
  return (
    <RemoteHostPasswordBootstrapSession
      key={targetKey}
      target={target}
      client={client}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  )
}

function RemoteHostPasswordBootstrapSession({
  target,
  client,
  onClose,
  onCompleted
}: {
  target: SshBootstrapTarget
  client: RemoteHostPasswordBootstrapClient
  onClose: () => void
  onCompleted?: (result: SshBootstrapFinalResult) => void
}): React.JSX.Element {
  const controller = useRemoteHostPasswordBootstrap({ target, client, onClose, onCompleted })
  return (
    <RemoteHostPasswordBootstrapDialogView
      open
      model={controller.model}
      actions={controller.actions}
    />
  )
}

export function RemoteHostPasswordBootstrapDialogView({
  open,
  model,
  actions
}: {
  open: boolean
  model: SshBootstrapUiModel
  actions: SshBootstrapUiActions
}): React.JSX.Element {
  const confirmingHostKey = model.phase === 'host-key-confirmation'
  const enteringCredentials = model.phase === 'credentials'
  const progressing = model.phase === 'progress'
  const previewingConfig = model.phase === 'config-preview'
  const showingResult = model.phase === 'result'
  return (
    <Dialog open={open} onClose={model.busy ? undefined : actions.close} maxWidth="sm" fullWidth>
      <DialogTitle>
        {confirmingHostKey
          ? '确认服务器主机密钥'
          : enteringCredentials
            ? '输入一次服务器密码'
            : progressing
              ? '正在设置免密登录'
              : previewingConfig
                ? '确认写入 SSH 配置'
                : showingResult
                  ? '免密登录已就绪'
                  : '设置免密登录'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.75 }}>
          <Typography variant="body2">目标别名：{model.target.alias}</Typography>
          <Typography variant="body2" color="text.secondary">
            {model.target.user}@{model.target.hostname}:{model.target.port}
          </Typography>
          {confirmingHostKey ? (
            <>
              {model.fingerprints.map((fingerprint) => (
                <Stack key={`${fingerprint.algorithm}:${fingerprint.sha256}`} spacing={0.25}>
                  <Typography variant="caption" color="text.secondary">
                    {fingerprint.algorithm}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                  >
                    {fingerprint.sha256}
                  </Typography>
                </Stack>
              ))}
              <Typography variant="body2">
                请通过可信渠道向服务器管理员核对。仅在与管理员提供的指纹一致时确认。
              </Typography>
            </>
          ) : enteringCredentials ? (
            <>
              <TextField
                label="服务器密码"
                type="password"
                value={model.credentials.password}
                onChange={(event) => actions.setPassword(event.target.value)}
                autoComplete="off"
                autoFocus
                fullWidth
              />
              {!model.passwordlessAcknowledged && (
                <>
                  <TextField
                    label="私钥口令"
                    type="password"
                    value={model.credentials.passphrase}
                    onChange={(event) => actions.setPassphrase(event.target.value)}
                    autoComplete="new-password"
                    helperText="默认生成带口令的专用 ed25519 私钥"
                    fullWidth
                  />
                  <TextField
                    label="确认私钥口令"
                    type="password"
                    value={model.credentials.passphraseConfirmation}
                    onChange={(event) => actions.setPassphraseConfirmation(event.target.value)}
                    autoComplete="new-password"
                    error={Boolean(
                      model.credentials.passphraseConfirmation && model.validationMessage
                    )}
                    fullWidth
                  />
                </>
              )}
              {model.passwordlessAvailable && (
                <Alert severity="warning">
                  <Stack spacing={1}>
                    <Typography variant="body2">
                      Linux 上未检测到正在运行的 ssh-agent。带口令密钥必须先加载到 agent，Phi
                      才能安全验证连接。
                    </Typography>
                    <Button
                      size="small"
                      onClick={actions.startInspection}
                      sx={{ alignSelf: 'start' }}
                    >
                      启动 agent 后重新检查
                    </Button>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={model.passwordlessAcknowledged}
                          onChange={(event) =>
                            actions.setPasswordlessAcknowledged(event.target.checked)
                          }
                        />
                      }
                      label="明确改用无口令密钥（有风险）"
                    />
                  </Stack>
                </Alert>
              )}
              <Alert severity="info">不会保存密码或私钥口令，提交后会立即从界面状态清除。</Alert>
            </>
          ) : progressing ? (
            <>
              {model.completedSteps.map((step) => (
                <Typography key={step} variant="body2" color="success.main">
                  ✓ {step}
                </Typography>
              ))}
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                <CircularProgress size={18} />
                <Typography variant="body2">{model.currentStep}</Typography>
              </Stack>
            </>
          ) : previewingConfig ? (
            <>
              <Alert severity="success">密钥登录已验证。写入配置前请检查以下内容。</Alert>
              <Typography variant="body2">新密钥：{model.keyFingerprint}</Typography>
              <Typography variant="body2" color="text.secondary">
                {model.keyDisplayPath}
              </Typography>
              <Box
                component="pre"
                sx={{
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  m: 0,
                  overflowX: 'auto',
                  p: 1.5,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {model.preview}
              </Box>
              <Typography variant="caption" color="text.secondary">
                只有点击“同意写入 SSH 配置”后才会修改 ~/.ssh/config。
              </Typography>
            </>
          ) : showingResult ? (
            <>
              <Alert severity="success">专用密钥已安装并通过密钥登录验证。</Alert>
              <Typography variant="body2">新密钥：{model.keyFingerprint}</Typography>
              <Typography variant="body2" color="text.secondary">
                {model.keyDisplayPath}
              </Typography>
              <Typography variant="body2">
                {model.configured
                  ? '已按确认的预览更新 ~/.ssh/config。'
                  : '未修改 ~/.ssh/config；你可以稍后手动添加下面的配置。'}
              </Typography>
              {model.manualConfig && (
                <>
                  <Typography variant="subtitle2">手动配置片段</Typography>
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      fontFamily: 'monospace',
                      fontSize: '0.78rem',
                      m: 0,
                      overflowX: 'auto',
                      p: 1.5,
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {model.manualConfig}
                  </Box>
                </>
              )}
            </>
          ) : (
            <Typography variant="body2">
              Phi 会先检查服务器能力和主机密钥；在你确认指纹前不会登录，也不会写入 known_hosts。
            </Typography>
          )}
          {model.error && <Alert severity="error">{model.error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {showingResult ? (
          <Button variant="contained" onClick={actions.close}>
            完成
          </Button>
        ) : previewingConfig ? (
          <>
            <Button onClick={actions.declineConfig} disabled={model.busy}>
              暂不写入
            </Button>
            <Button variant="contained" onClick={actions.saveConfig} disabled={model.busy}>
              {model.busy ? '写入中…' : '同意写入 SSH 配置'}
            </Button>
          </>
        ) : !progressing ? (
          <>
            <Button onClick={actions.close} disabled={model.busy}>
              取消
            </Button>
            <Button
              variant="contained"
              onClick={
                confirmingHostKey
                  ? actions.confirmHostKey
                  : enteringCredentials
                    ? actions.submitCredentials
                    : actions.startInspection
              }
              disabled={model.busy || (enteringCredentials && Boolean(model.validationMessage))}
            >
              {model.busy
                ? confirmingHostKey
                  ? '写入中…'
                  : enteringCredentials
                    ? '引导中…'
                    : '检查中…'
                : confirmingHostKey
                  ? '指纹一致，继续'
                  : enteringCredentials
                    ? '开始引导'
                    : '开始安全检查'}
            </Button>
          </>
        ) : null}
      </DialogActions>
    </Dialog>
  )
}
