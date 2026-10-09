import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  credentialsSshBootstrapUiModel,
  initialSshBootstrapUiModel,
  keyProtectionValidationMessage,
  passwordSshBootstrapUiModel,
  sshBootstrapErrorMessage,
  withEphemeralSshBootstrapKeyProtection,
  withEphemeralSshBootstrapPassword,
  type RemoteHostPasswordBootstrapClient,
  type SshBootstrapCredentialDraft,
  type SshBootstrapFinalResult,
  type SshBootstrapTarget,
  type SshBootstrapUiActions,
  type SshBootstrapUiModel
} from '../lib/sshBootstrapUi'

interface UseRemoteHostPasswordBootstrapInput {
  target: SshBootstrapTarget
  client: RemoteHostPasswordBootstrapClient
  onClose: () => void
  onCompleted?: (result: SshBootstrapFinalResult) => void
}

function credentialsWithPatch(
  model: Extract<SshBootstrapUiModel, { phase: 'credentials' }>,
  patch: Partial<SshBootstrapCredentialDraft> & { passwordlessAcknowledged?: boolean }
): Extract<SshBootstrapUiModel, { phase: 'credentials' }> {
  const { passwordlessAcknowledged: nextAcknowledgement, ...credentialPatch } = patch
  const passwordlessAcknowledged = nextAcknowledgement ?? model.passwordlessAcknowledged
  const credentials = {
    ...model.credentials,
    ...credentialPatch,
    ...(nextAcknowledgement === undefined ? {} : { passphrase: '', passphraseConfirmation: '' })
  }
  return {
    ...model,
    error: null,
    credentials,
    passwordlessAcknowledged,
    validationMessage: keyProtectionValidationMessage(credentials, {
      passwordlessAvailable: model.passwordlessAvailable,
      passwordlessAcknowledged
    })
  }
}

export function useRemoteHostPasswordBootstrap({
  target,
  client,
  onClose,
  onCompleted
}: UseRemoteHostPasswordBootstrapInput): {
  model: SshBootstrapUiModel
  actions: SshBootstrapUiActions
} {
  const { alias, hostname, user, port } = target
  const stableTarget = useMemo(
    () => ({ alias, hostname, user, port }),
    [alias, hostname, port, user]
  )
  const [model, setModel] = useState<SshBootstrapUiModel>(() =>
    initialSshBootstrapUiModel(stableTarget)
  )
  const requestSequence = useRef(0)
  const attemptId = useRef<string | null>(null)
  const operationId = useRef<string | null>(null)

  const cancelPending = useCallback(() => {
    const id = operationId.current ?? attemptId.current
    attemptId.current = null
    operationId.current = null
    if (id) void client.cancel(id).catch(() => undefined)
  }, [client])

  const reset = useCallback(() => {
    requestSequence.current += 1
    cancelPending()
    setModel(initialSshBootstrapUiModel(stableTarget))
  }, [cancelPending, stableTarget])

  useEffect(
    () => () => {
      requestSequence.current += 1
      cancelPending()
    },
    [cancelPending]
  )

  const startInspection = useCallback(async () => {
    const requestId = ++requestSequence.current
    cancelPending()
    setModel({ ...initialSshBootstrapUiModel(stableTarget), busy: true })
    try {
      const result = await client.inspectTarget(stableTarget)
      if (requestSequence.current !== requestId) {
        if (result.status !== 'rejected')
          await client.cancel(result.attemptId).catch(() => undefined)
        return
      }
      if (result.status === 'rejected') {
        setModel({
          ...initialSshBootstrapUiModel(stableTarget),
          error: sshBootstrapErrorMessage(result.errorCode)
        })
        return
      }
      attemptId.current = result.attemptId
      if (result.status === 'confirmation-required') {
        setModel({
          phase: 'host-key-confirmation',
          target: stableTarget,
          busy: false,
          error: null,
          fingerprints: result.fingerprints
        })
        return
      }
      setModel(passwordSshBootstrapUiModel(stableTarget, result.agentState))
    } catch {
      if (requestSequence.current === requestId) {
        setModel({
          ...initialSshBootstrapUiModel(stableTarget),
          error: sshBootstrapErrorMessage('unexpected')
        })
      }
    }
  }, [cancelPending, client, stableTarget])

  const confirmHostKey = useCallback(async () => {
    const currentAttemptId = attemptId.current
    if (!currentAttemptId || model.phase !== 'host-key-confirmation') return
    const requestId = ++requestSequence.current
    setModel({ ...model, busy: true, error: null })
    try {
      const result = await client.confirmHostKey(currentAttemptId)
      if (requestSequence.current !== requestId) {
        if (result.status !== 'rejected')
          await client.cancel(result.attemptId).catch(() => undefined)
        return
      }
      if (result.status === 'rejected') {
        setModel({ ...model, busy: false, error: sshBootstrapErrorMessage(result.errorCode) })
        return
      }
      attemptId.current = result.attemptId
      setModel(passwordSshBootstrapUiModel(stableTarget, result.agentState))
    } catch {
      if (requestSequence.current === requestId) {
        setModel({ ...model, busy: false, error: sshBootstrapErrorMessage('unexpected') })
      }
    }
  }, [client, model, stableTarget])

  const patchCredentials = useCallback(
    (patch: Partial<SshBootstrapCredentialDraft> & { passwordlessAcknowledged?: boolean }) => {
      setModel((current) =>
        current.phase === 'credentials' ? credentialsWithPatch(current, patch) : current
      )
    },
    []
  )

  const setPassword = useCallback((password: string) => {
    setModel((current) =>
      current.phase === 'password'
        ? {
            ...current,
            error: null,
            password,
            validationMessage: password ? null : '请输入服务器密码'
          }
        : current
    )
  }, [])

  const verifyPassword = useCallback(async () => {
    const currentAttemptId = attemptId.current
    if (!currentAttemptId || model.phase !== 'password' || model.validationMessage) return
    const requestId = ++requestSequence.current
    const agentState = model.agentState
    setModel({
      phase: 'progress',
      target: stableTarget,
      busy: true,
      error: null,
      completedSteps: ['已确认服务器主机密钥'],
      currentStep: '正在用密码测试连接…'
    })
    try {
      const result = await withEphemeralSshBootstrapPassword(model.password, (input) =>
        client.verifyPassword(currentAttemptId, input)
      )
      if (requestSequence.current !== requestId) {
        if (result.status === 'ready') await client.cancel(result.attemptId).catch(() => undefined)
        return
      }
      if (result.status === 'failed') {
        const message = sshBootstrapErrorMessage(result.errorCode)
        setModel(
          result.retryable
            ? passwordSshBootstrapUiModel(stableTarget, agentState, message)
            : { ...initialSshBootstrapUiModel(stableTarget), error: message }
        )
        return
      }
      setModel({
        phase: 'password-choice',
        target: stableTarget,
        busy: false,
        error: null,
        agentState: result.agentState
      })
    } catch {
      if (requestSequence.current === requestId) {
        setModel(
          passwordSshBootstrapUiModel(
            stableTarget,
            agentState,
            sshBootstrapErrorMessage('unexpected')
          )
        )
      }
    }
  }, [client, model, stableTarget])

  const configurePasswordless = useCallback(() => {
    setModel((current) =>
      current.phase === 'password-choice'
        ? credentialsSshBootstrapUiModel(stableTarget, current.agentState)
        : current
    )
  }, [stableTarget])

  const skipPasswordless = useCallback(async () => {
    const currentAttemptId = attemptId.current
    if (!currentAttemptId || model.phase !== 'password-choice') return
    const requestId = ++requestSequence.current
    setModel({ ...model, busy: true, error: null })
    try {
      await client.cancel(currentAttemptId)
      if (requestSequence.current !== requestId) return
      attemptId.current = null
      setModel({ phase: 'skipped', target: stableTarget, busy: false, error: null })
    } catch {
      if (requestSequence.current === requestId) {
        setModel({ ...model, busy: false, error: sshBootstrapErrorMessage('unexpected') })
      }
    }
  }, [client, model, stableTarget])

  const submitCredentials = useCallback(async () => {
    const currentAttemptId = attemptId.current
    if (!currentAttemptId || model.phase !== 'credentials' || model.validationMessage) return
    const requestId = ++requestSequence.current
    setModel({
      phase: 'progress',
      target: stableTarget,
      busy: true,
      error: null,
      completedSteps: ['已确认服务器主机密钥', '已验证密码登录'],
      currentStep: '正在生成并安装专用密钥…'
    })
    try {
      const result = await withEphemeralSshBootstrapKeyProtection(
        model.credentials,
        model.passwordlessAcknowledged,
        (protection) => client.completeWithKeyProtection(currentAttemptId, protection)
      )
      if (requestSequence.current !== requestId) {
        if (result.status === 'config-preview') {
          await client.cancel(result.operationId).catch(() => undefined)
        }
        return
      }
      if (result.status === 'failed') {
        const message = sshBootstrapErrorMessage(result.errorCode)
        if (!result.retryable) {
          setModel({ ...initialSshBootstrapUiModel(stableTarget), error: message })
          return
        }
        setModel(
          credentialsSshBootstrapUiModel(
            stableTarget,
            result.errorCode === 'linux_agent_missing' || model.passwordlessAvailable
              ? 'missing-linux'
              : 'ready',
            message
          )
        )
        return
      }
      operationId.current = result.operationId
      setModel({
        phase: 'config-preview',
        target: stableTarget,
        busy: false,
        error: null,
        preview: result.preview,
        keyFingerprint: result.keyFingerprint,
        keyDisplayPath: result.keyDisplayPath
      })
    } catch {
      if (requestSequence.current === requestId) {
        setModel(
          credentialsSshBootstrapUiModel(
            stableTarget,
            model.passwordlessAvailable ? 'missing-linux' : 'ready',
            sshBootstrapErrorMessage('unexpected')
          )
        )
      }
    }
  }, [client, model, stableTarget])

  const finishConfig = useCallback(
    async (writeConfig: boolean) => {
      const currentOperationId = operationId.current
      if (!currentOperationId || model.phase !== 'config-preview') return
      const requestId = ++requestSequence.current
      setModel({ ...model, busy: true, error: null })
      try {
        const result = writeConfig
          ? await client.saveConfig(currentOperationId)
          : await client.declineConfig(currentOperationId)
        if (requestSequence.current !== requestId) return
        attemptId.current = null
        operationId.current = null
        setModel({ phase: 'result', target: stableTarget, busy: false, error: null, ...result })
        onCompleted?.(result)
      } catch {
        if (requestSequence.current === requestId) {
          setModel({ ...model, busy: false, error: sshBootstrapErrorMessage('unexpected') })
        }
      }
    },
    [client, model, onCompleted, stableTarget]
  )

  const close = useCallback(() => {
    reset()
    onClose()
  }, [onClose, reset])

  const actions = useMemo<SshBootstrapUiActions>(
    () => ({
      startInspection: () => void startInspection(),
      confirmHostKey: () => void confirmHostKey(),
      setPassword,
      verifyPassword: () => void verifyPassword(),
      configurePasswordless,
      skipPasswordless: () => void skipPasswordless(),
      setPassphrase: (passphrase) => patchCredentials({ passphrase }),
      setPassphraseConfirmation: (passphraseConfirmation) =>
        patchCredentials({ passphraseConfirmation }),
      setPasswordlessAcknowledged: (passwordlessAcknowledged) =>
        patchCredentials({ passwordlessAcknowledged }),
      submitCredentials: () => void submitCredentials(),
      saveConfig: () => void finishConfig(true),
      declineConfig: () => void finishConfig(false),
      close
    }),
    [
      close,
      configurePasswordless,
      confirmHostKey,
      finishConfig,
      patchCredentials,
      setPassword,
      skipPasswordless,
      startInspection,
      submitCredentials,
      verifyPassword
    ]
  )

  return { model, actions }
}
