import type { JsonObject } from './notebookDocument'

export interface NotebookExecutionEnvironment {
  kernelName: string
  source?: 'managed' | 'host'
  ref?: string
  envId?: string
  lockSha256?: string
}

function serializeExecutionEnvironment(
  environment: NotebookExecutionEnvironment,
  recordedAt?: string
): JsonObject {
  const result: JsonObject = {
    kernelName: environment.kernelName
  }
  if (environment.source) result.source = environment.source
  if (environment.ref) result.ref = environment.ref
  if (environment.envId) result.envId = environment.envId
  if (environment.lockSha256) result.lockSha256 = environment.lockSha256
  if (recordedAt) result.recordedAt = recordedAt
  return result
}

export function notebookCellMetadataWithExecutionDuration(
  metadata: JsonObject,
  execution: { startedAt: string; completedAt: string },
  environment?: NotebookExecutionEnvironment
): JsonObject {
  const startedAt = Date.parse(execution.startedAt)
  const completedAt = Date.parse(execution.completedAt)
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0
  const phiMetadata =
    metadata.phi && typeof metadata.phi === 'object' && !Array.isArray(metadata.phi)
      ? (metadata.phi as JsonObject)
      : {}
  return {
    ...metadata,
    phi: {
      ...phiMetadata,
      executionStartedAt: execution.startedAt,
      executionCompletedAt: execution.completedAt,
      executionDurationMs: durationMs,
      ...(environment
        ? { executionEnvironment: serializeExecutionEnvironment(environment) }
        : {})
    }
  }
}

export function notebookDocumentMetadataWithExecutionEnvironment(
  metadata: JsonObject,
  environment: NotebookExecutionEnvironment,
  recordedAt?: string
): JsonObject {
  const phiMetadata =
    metadata.phi && typeof metadata.phi === 'object' && !Array.isArray(metadata.phi)
      ? (metadata.phi as JsonObject)
      : {}
  return {
    ...metadata,
    phi: {
      ...phiMetadata,
      executionEnvironment: serializeExecutionEnvironment(environment, recordedAt)
    }
  }
}
