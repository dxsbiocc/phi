import {
  createModelAccessBroker,
  ModelAccessBrokerError,
  type ModelAccessBroker
} from '../kernel-host/model-access-broker'
import { isRecord, stringValue } from './common'
import { getContext } from './runtime-context'

const brokers = new Map<string, Promise<ModelAccessBroker>>()

function agentDirFrom(params: unknown): string {
  const agentDir = stringValue(isRecord(params) ? params.agentDir : undefined)
  if (!agentDir) throw new TypeError('Desktop model access requires an agent directory.')
  return agentDir
}

function brokerFor(agentDir: string): Promise<ModelAccessBroker> {
  const existing = brokers.get(agentDir)
  if (existing) return existing
  const created = getContext(agentDir)
    .then((context) => createModelAccessBroker(context.authStorage))
    .catch((error: unknown) => {
      brokers.delete(agentDir)
      throw error
    })
  brokers.set(agentDir, created)
  return created
}

export async function desktopModelAccessCredentials(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const agentDir = agentDirFrom(record)
  const provider = stringValue(record.provider)
  return (await brokerFor(agentDir)).credentials(provider ? { provider } : {})
}

export async function desktopModelAccessRefresh(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const agentDir = agentDirFrom(record)
  const credentialId = record.credentialId
  if (!Number.isSafeInteger(credentialId) || (credentialId as number) < 0) {
    throw new TypeError('Desktop model access requires a credential id.')
  }
  const reason = record.reason === 'auth-recovery' ? record.reason : undefined
  try {
    const credential = await (
      await brokerFor(agentDir)
    ).refresh({
      credentialId: credentialId as number,
      ...(reason ? { reason } : {})
    })
    return { ok: true, credential }
  } catch (error) {
    const code = error instanceof ModelAccessBrokerError ? error.code : 'REFRESH_FAILED'
    return { ok: false, code }
  }
}
