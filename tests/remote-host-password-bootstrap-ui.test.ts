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
  withEphemeralSshBootstrapKeyProtection,
  withEphemeralSshBootstrapPassword,
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
  verifyPassword: () => undefined,
  configurePasswordless: () => undefined,
  skipPasswordless: () => undefined,
  setPassphrase: () => undefined,
  setPassphraseConfirmation: () => undefined,
  setPasswordlessAcknowledged: () => undefined,
  submitCredentials: () => undefined,
  saveConfig: () => undefined,
  declineConfig: () => undefined,
  close: () => undefined
}

test('successful password verification offers only recommended key setup or no setup', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'password-choice',
        target: TARGET,
        busy: false,
        error: null,
        agentState: 'ready'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /Password connection succeeded/)
  assert.match(markup, /Configure key-based login \(recommended\)/)
  assert.match(markup, /Skip setup for now/)
  assert.match(markup, /[Aa]dd the password again when needed.{0,10}or use key-based login/)
  assert.doesNotMatch(
    markup,
    /Server password|Private key passphrase|store the password|Remember password|Keychain password/
  )
})

test('declining key setup confirms that the one-use password was discarded', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: { phase: 'skipped', target: TARGET, busy: false, error: null },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /The password was discarded/)
  assert.match(markup, /No credentials were saved/)
  assert.match(markup, /no SSH configuration was generated or written/)
  assert.match(markup, /[Aa]dd the password again when needed.{0,10}or use key-based login/)
  assert.doesNotMatch(markup, /store the password|Remember password|Keychain password/)
})

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
    'Enter the server password'
  )
  assert.equal(
    credentialValidationMessage({
      password: 'server-password',
      passphrase: '',
      passphraseConfirmation: ''
    }),
    'Enter the private key passphrase'
  )
  assert.equal(
    credentialValidationMessage({
      password: 'server-password',
      passphrase: 'key-passphrase',
      passphraseConfirmation: 'different'
    }),
    'The private key passphrases do not match'
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
  const capture: { value: SshBootstrapCredentialRequest | null } = { value: null }
  const result = await withEphemeralSshBootstrapCredentials(
    {
      password: 'one-use-password',
      passphrase: 'one-use-passphrase',
      passphraseConfirmation: 'one-use-passphrase'
    },
    false,
    async (credentials) => {
      capture.value = credentials
      assert.deepEqual(credentials, {
        password: 'one-use-password',
        keyProtection: 'passphrase',
        passphrase: 'one-use-passphrase'
      })
      return 'complete'
    }
  )

  assert.equal(result, 'complete')
  const captured = capture.value
  assert.ok(captured)
  assert.equal(captured?.password, '')
  assert.equal(captured?.keyProtection, 'passphrase')
  assert.equal(captured?.passphrase, '')
})

test('split requests erase the password before the key-protection step', async () => {
  const capture: {
    password: { password: string } | null
    protection:
      | { keyProtection: 'passphrase'; passphrase: string }
      | { keyProtection: 'passwordless-explicit' }
      | null
  } = { password: null, protection: null }

  await withEphemeralSshBootstrapPassword('one-use-password', async (input) => {
    capture.password = input
    return 'verified'
  })
  await withEphemeralSshBootstrapKeyProtection(
    { passphrase: 'one-use-passphrase', passphraseConfirmation: 'one-use-passphrase' },
    false,
    async (input) => {
      capture.protection = input
      assert.equal('password' in input, false)
      return 'configured'
    }
  )

  const passwordRequest = capture.password
  const protectionRequest = capture.protection
  assert.ok(passwordRequest)
  assert.ok(protectionRequest)
  assert.equal(passwordRequest.password, '')
  assert.equal(protectionRequest.keyProtection, 'passphrase')
  if (protectionRequest?.keyProtection === 'passphrase') {
    assert.equal(protectionRequest.passphrase, '')
  }
})

test('password bootstrap starts with public target information and an explicit user action', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: { phase: 'target', target: TARGET, busy: false, error: null },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /Set up key-based login/)
  assert.match(markup, /gpu-lab/)
  assert.match(markup, /researcher@gpu\.example\.org:2222/)
  assert.match(markup, /Start safety check/)
  assert.doesNotMatch(markup, /Server password/)
})

test('opening the password bootstrap dialog never starts credential work without a user action', () => {
  let inspectCalls = 0
  const client = {
    inspectTarget: async () => {
      inspectCalls += 1
      return { status: 'rejected', errorCode: 'unexpected' } as const
    },
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    verifyPassword: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    completeWithKeyProtection: async () =>
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

  assert.match(markup, /Start safety check/)
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
        error: 'This server connects through ProxyJump, which this setup flow does not support yet.'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /ProxyJump/)
  assert.match(markup, /this setup flow does not support yet/)
  assert.doesNotMatch(markup, /Server password|Private key passphrase/)
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

  assert.match(markup, /Confirm server host key/)
  assert.match(markup, /ED25519/)
  assert.match(markup, /SHA256:ed25519-example/)
  assert.match(markup, /ECDSA/)
  assert.match(markup, /Confirm only if it matches the fingerprint they provide/)
  assert.match(markup, /Fingerprint matches, continue/)
  assert.doesNotMatch(markup, /Server password/)
})

test('password test step contains only the one-use server password', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'password',
        target: TARGET,
        busy: false,
        error: null,
        agentState: 'ready',
        password: '',
        validationMessage: 'Enter the server password'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /Test password connection/)
  assert.match(markup, /Server password/)
  assert.match(markup, /The password is used only for this connection test/)
  assert.match(markup, /Test connection/)
  assert.doesNotMatch(
    markup,
    /Private key passphrase|Remember password|Keychain password|Save to Keychain/
  )
})

test('key setup step defaults to a protected key without retaining the server password', () => {
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, {
      open: true,
      model: {
        phase: 'credentials',
        target: TARGET,
        busy: false,
        error: null,
        credentials: { password: '', passphrase: '', passphraseConfirmation: '' },
        validationMessage: 'Enter the server password',
        passwordlessAcknowledged: false,
        passwordlessAvailable: false
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /Configure key-based login/)
  assert.match(markup, /Private key passphrase/)
  assert.match(markup, /Confirm private key passphrase/)
  assert.match(markup, /The private key passphrase is not saved/)
  assert.match(markup, /Start setup/)
  assert.match(markup, /disabled=""/)
  assert.doesNotMatch(
    markup,
    /Server password|store the password|Remember password|Keychain password/
  )
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
        validationMessage:
          'Start ssh-agent and recheck, or explicitly choose a key without a passphrase',
        passwordlessAcknowledged: false,
        passwordlessAvailable: true
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /No running ssh-agent was found/)
  assert.match(markup, /Recheck after starting ssh-agent/)
  assert.match(markup, /Use a key without a passphrase \(risk\)/)
  assert.match(markup, /Private key passphrase/)
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
        completedSteps: ['Password login verified', 'Dedicated key generated'],
        currentStep: 'Installing the public key and verifying key-based login…'
      },
      actions: NOOP_ACTIONS
    })
  )

  assert.match(markup, /Setting up key-based login/)
  assert.match(markup, /Password login verified/)
  assert.match(markup, /Dedicated key generated/)
  assert.match(markup, /Installing the public key and verifying key-based login…/)
  assert.doesNotMatch(markup, /Server password|Private key passphrase/)
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

  assert.match(markup, /Key-based login verified/)
  assert.match(markup, /Confirm SSH configuration update/)
  assert.match(markup, /Host gpu-lab/)
  assert.match(markup, /IdentityFile ~\/.ssh\/phi_gpu-lab_ed25519/)
  assert.match(markup, /Skip update for now/)
  assert.match(markup, /Approve SSH configuration update/)
  assert.doesNotMatch(markup, /Server password|Private key passphrase/)
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

  assert.match(markup, /Key-based login is ready/)
  assert.match(markup, /~\/.ssh\/config was not modified/)
  assert.match(markup, /SHA256:new-key/)
  assert.match(markup, /Manual configuration snippet/)
  assert.match(markup, /Done/)
  assert.doesNotMatch(markup, /Server password|Private key passphrase/)
})
