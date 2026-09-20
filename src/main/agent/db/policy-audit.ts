import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DefaultProxyMode } from '../../../shared/appSettingsTypes'
import type { DbNow } from './policy'
import type { DbHttpError } from './policy-error'
import { getDbConnectorAuditLogPath } from './store'

export interface DbAuditEvent {
  timestamp: string
  database: string
  method: string
  redactedUrl: string
  transportName: string
  defaultProxyMode: DefaultProxyMode
  outcome: 'success' | 'error' | 'cache_hit'
  status?: number
  code?: string
  attempts: number
  cached?: boolean
}

export function writeDbAuditEvent(agentDir: string, event: DbAuditEvent): void {
  try {
    const auditLogPath = getDbConnectorAuditLogPath(agentDir)
    mkdirSync(dirname(auditLogPath), { recursive: true })
    appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`, 'utf-8')
  } catch {
    // Audit must not make read-only database access fail.
  }
}

export function writeDbAuditError(
  agentDir: string,
  database: string,
  method: string,
  redactedUrl: string,
  options: {
    error: DbHttpError
    transportName: string
    defaultProxyMode: DefaultProxyMode
    now?: DbNow
  }
): void {
  writeDbAuditEvent(agentDir, {
    timestamp: new Date((options.now ?? Date.now)()).toISOString(),
    database,
    method,
    redactedUrl,
    transportName: options.transportName,
    defaultProxyMode: options.defaultProxyMode,
    outcome: 'error',
    status: options.error.status,
    code: options.error.code,
    attempts: options.error.attempts
  })
}
