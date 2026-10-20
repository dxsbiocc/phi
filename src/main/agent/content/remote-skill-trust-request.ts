import { isRecord } from '../../../shared/guards'

export type RemoteSkillTrustMutation = {
  cwd: string
  relativePath: string
  contentHash: string
}

export function checkedRemoteSkillTrustMutation(value: unknown): RemoteSkillTrustMutation {
  if (!isRecord(value)) throw new Error('远程项目 Skill 信任请求无效')
  if (
    Object.keys(value).some(
      (key) => key !== 'cwd' && key !== 'relativePath' && key !== 'contentHash'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !/^\.(?:phi|omp|pi)\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/u.test(value.relativePath) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash)
  ) {
    throw new Error('远程项目 Skill 信任请求无效')
  }
  return value as RemoteSkillTrustMutation
}
