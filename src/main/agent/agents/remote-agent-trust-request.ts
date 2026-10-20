import { isRecord } from '../../../shared/guards'

export type RemoteAgentTrustRequest = {
  cwd: string
  relativePath: string
  contentHash: string
}

export function checkedRemoteAgentTrustMutation(value: unknown): RemoteAgentTrustRequest {
  if (!isRecord(value)) throw new Error('远程项目 agent 信任请求无效')
  if (
    Object.keys(value).some(
      (key) => key !== 'cwd' && key !== 'relativePath' && key !== 'contentHash'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash)
  ) {
    throw new Error('远程项目 agent 信任请求无效')
  }
  return value as RemoteAgentTrustRequest
}
