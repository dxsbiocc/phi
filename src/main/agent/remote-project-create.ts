import type { RemoteDoctorReport } from '../../shared/remoteDoctorTypes'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import { createRemoteProject, type Project } from './projects'
import { remoteDoctor } from './remote-doctor'

const REQUIRED_CHECKS = ['ssh', 'sftp', 'path', 'path_read', 'path_write', 'shell'] as const

/** Validate the candidate workspace before the registry can gain a remote project. */
export async function createCheckedRemoteProject(
  input: RemoteProjectCreateInput,
  dependencies: {
    doctorImpl?: typeof remoteDoctor
    createImpl?: typeof createRemoteProject
  } = {}
): Promise<Project> {
  if (
    !input ||
    typeof input.name !== 'string' ||
    typeof input.hostProfileId !== 'string' ||
    !input.hostProfileId.trim() ||
    typeof input.remoteRoot !== 'string' ||
    !['ask', 'auto', 'full'].includes(input.permissionMode)
  ) {
    throw new Error('远程项目设置无效')
  }
  const report: RemoteDoctorReport = await (dependencies.doctorImpl ?? remoteDoctor)(
    input.hostProfileId,
    input.remoteRoot,
    { scope: 'workspace' },
    { userInitiated: true }
  )
  for (const id of REQUIRED_CHECKS) {
    const check = report.checks.find((item) => item.id === id)
    if (!check || check.status !== 'ok') {
      throw new Error(
        check
          ? `${check.message}。${check.suggestion ?? '请检查服务器设置后重试。'}`
          : '远程目录检查未完成，请重试。'
      )
    }
  }
  return (dependencies.createImpl ?? createRemoteProject)(input)
}
