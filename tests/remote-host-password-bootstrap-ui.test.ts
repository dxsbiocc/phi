import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createTheme, ThemeProvider } from '@mui/material/styles'

import {
  RemoteHostPasswordBootstrapDialog,
  RemoteHostPasswordBootstrapDialogView
} from '../src/renderer/src/features/wrapper/components/RemoteHostPasswordBootstrapDialog'
import {
  credentialValidationMessage,
  withEphemeralSshBootstrapCredentials,
  type SshBootstrapCredentialRequest
} from '../src/renderer/src/features/wrapper/lib/sshBootstrapUi'

const TARGET = {
  alias: 'gpu-lab',
  hostname: 'gpu.example.org',
  user: 'researcher',
  port: 2222
}

const NOOP_ACTIONS = {
  startInspection: () => undefined,
  confirmHostKey: () => undefined,
  setPassword: () => undefined,
  setPassphrase: () => undefined,
  setPassphraseConfirmation: () => undefined,
  setPasswordlessAcknowledged: () => undefined,
  submitCredentials: () => undefined,
  saveConfig: () => undefined,
  declineConfig: () => undefined,
  close: () => undefined
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({ components: { MuiDialog: { defaultProps: { disablePortal: true } } } })
      },
      element
    )
  )
}

test('password bootstrap requires a password and a matching non-empty key passphrase by default', () => {
  assert.equal(
    credentialValidationMessage({ password: '', passphrase: '', passphraseConfirmation: '' }),
    '请输入服务器密码'
  )
  assert.equal(
    credentialValidationMessage({
      password: 'server-password',
      passphrase: '',
      passphraseConfirmation: ''
    }),
    '请输入私钥口令'
  )
  assert.equal(
    credentialValidationMessage({
      password: 'server-password',
      passphrase: 'key-passphrase',
      passphraseConfirmation: 'different'
    }),
    '两次输入的私钥口令不一致'
  )
  assert.equal(
    credentialValidationMessage({
      password: 'server-password',
      passphrase: 'key-passphrase',
      passphraseConfirmation: 'key-passphrase'
    }),
    null
  )
})

test('credential requests are blanked immediately after the one bootstrap call settles', async () => {
  let captured: SshBootstrapCredentialRequest | null = null
  const result = await withEphemeralSshBootstrapCredentials(
    {
      password: 'one-use-password',
      passphrase: 'one-use-passphrase',
      passphraseConfirmation: 'one-use-passphrase'
    },
    false,
    async (credentials) => {
      captured = credentials
      assert.deepEqual(credentials, {
        password: 'one-use-password',
        keyProtection: 'passphrase',
        passphrase: 'one-use-passphrase'
      })
      return 'complete'
    }
  )

  assert.equal(result, 'complete')
  assert.equal(captured?.password, '')
  assert.equal(captured?.keyProtection, 'passphrase')
  assert.equal(captured?.passphrase, '')
})

test('password bootstrap starts with public target information and an explicit user action', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: { phase: 'target', target: TARGET, busy: false, error: null },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /设置免密登录/)
  assert.match(markup, /gpu-lab/)
  assert.match(markup, /researcher@gpu\.example\.org:2222/)
  assert.match(markup, /开始安全检查/)
  assert.doesNotMatch(markup, /服务器密码/)
})

test('opening the password bootstrap dialog never starts credential work without a user action', () => {
  let inspectCalls = 0
  const client = {
    inspectTarget: async () => {
      inspectCalls += 1
      return { status: 'rejected', errorCode: 'unexpected' } as const
    },
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    completeWithCredentials: async () =>
      ({
        status: 'failed',
        errorCode: 'unexpected',
        retryable: false
      }) as const,
    saveConfig: async () => ({
      configured: true,
      keyFingerprint: 'SHA256:key',
      keyDisplayPath: '~/.ssh/key'
    }),
    declineConfig: async () => ({
      configured: false,
      keyFingerprint: 'SHA256:key',
      keyDisplayPath: '~/.ssh/key'
    }),
    cancel: async () => undefined
  }

  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialog, {
      open: true,
      target: TARGET,
      client,
      onClose: () => undefined
    })
  )

  assert.match(markup, /开始安全检查/)
  assert.equal(inspectCalls, 0)
})

test('unsupported targets stop on a public preflight explanation without revealing credentials', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'target',
        target: TARGET,
        busy: false,
        error: '此服务器通过 ProxyJump 连接，当前版本不支持引导。'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /ProxyJump/)
  assert.match(markup, /当前版本不支持引导/)
  assert.doesNotMatch(markup, /服务器密码|私钥口令/)
})

test('host fingerprints require explicit confirmation before credentials are shown', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'host-key-confirmation',
        target: TARGET,
        busy: false,
        error: null,
        fingerprints: [
          { algorithm: 'ED25519', sha256: 'SHA256:ed25519-example' },
          { algorithm: 'ECDSA', sha256: 'SHA256:ecdsa-example' }
        ]
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /确认服务器主机密钥/)
  assert.match(markup, /ED25519/)
  assert.match(markup, /SHA256:ed25519-example/)
  assert.match(markup, /ECDSA/)
  assert.match(markup, /仅在与管理员提供的指纹一致时确认/)
  assert.match(markup, /指纹一致，继续/)
  assert.doesNotMatch(markup, /服务器密码/)
})

test('credential step defaults to a protected key and blocks incomplete secrets', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'credentials',
        target: TARGET,
        busy: false,
        error: null,
        credentials: { password: '', passphrase: '', passphraseConfirmation: '' },
        validationMessage: '请输入服务器密码',
        passwordlessAcknowledged: false,
        passwordlessAvailable: false
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /输入一次服务器密码/)
  assert.match(markup, /服务器密码/)
  assert.match(markup, /私钥口令/)
  assert.match(markup, /确认私钥口令/)
  assert.match(markup, /不会保存密码或私钥口令/)
  assert.match(markup, /开始引导/)
  assert.match(markup, /disabled=""/)
})

test('Linux without an agent offers an explicit risky choice instead of silently dropping the passphrase', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'credentials',
        target: TARGET,
        busy: false,
        error: null,
        credentials: { password: '', passphrase: '', passphraseConfirmation: '' },
        validationMessage: '请先启动 ssh-agent 后重新检查，或明确选择无口令密钥',
        passwordlessAcknowledged: false,
        passwordlessAvailable: true
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /未检测到正在运行的 ssh-agent/)
  assert.match(markup, /启动 agent 后重新检查/)
  assert.match(markup, /明确改用无口令密钥（有风险）/)
  assert.match(markup, /私钥口令/)
})

test('progress step presents only public operation status after credentials are submitted', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'progress',
        target: TARGET,
        busy: true,
        error: null,
        completedSteps: ['已验证密码登录', '已生成专用密钥'],
        currentStep: '正在安装公钥并验证密钥登录…'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /正在设置免密登录/)
  assert.match(markup, /已验证密码登录/)
  assert.match(markup, /已生成专用密钥/)
  assert.match(markup, /正在安装公钥并验证密钥登录…/)
  assert.doesNotMatch(markup, /服务器密码|私钥口令/)
})

test('verified key login still requires explicit consent before writing SSH config', () => {
  const preview = [
    'Host gpu-lab',
    '  HostName gpu.example.org',
    '  User researcher',
    '  Port 2222',
    '  IdentityFile ~/.ssh/phi_gpu-lab_ed25519',
    '  IdentitiesOnly yes'
  ].join('\n')
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'config-preview',
        target: TARGET,
        busy: false,
        error: null,
        preview,
        keyFingerprint: 'SHA256:new-key',
        keyDisplayPath: '~/.ssh/phi_gpu-lab_ed25519'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /密钥登录已验证/)
  assert.match(markup, /确认写入 SSH 配置/)
  assert.match(markup, /Host gpu-lab/)
  assert.match(markup, /IdentityFile ~\/.ssh\/phi_gpu-lab_ed25519/)
  assert.match(markup, /暂不写入/)
  assert.match(markup, /同意写入 SSH 配置/)
  assert.doesNotMatch(markup, /服务器密码|私钥口令/)
})

test('declining config writes reports completion and keeps a manual public snippet', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'result',
        target: TARGET,
        busy: false,
        error: null,
        configured: false,
        keyFingerprint: 'SHA256:new-key',
        keyDisplayPath: '~/.ssh/phi_gpu-lab_ed25519',
        manualConfig: 'Host gpu-lab\n  IdentityFile ~/.ssh/phi_gpu-lab_ed25519'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /免密登录已就绪/)
  assert.match(markup, /未修改 ~\/.ssh\/config/)
  assert.match(markup, /SHA256:new-key/)
  assert.match(markup, /手动配置片段/)
  assert.match(markup, /完成/)
  assert.doesNotMatch(markup, /服务器密码|私钥口令/)
})
