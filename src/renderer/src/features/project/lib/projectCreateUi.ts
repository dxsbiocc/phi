import type { RemoteProjectCreateInput } from '../../../../../shared/projectLocation'

export interface NewProjectDraft {
  locationMode: 'local' | 'ssh'
  name: string
  workingDirectory: string
  hostProfileId: string
  remoteRoot: string
  permissionMode: 'ask' | 'auto' | 'full'
}

export function canSubmitNewProject(draft: NewProjectDraft): boolean {
  return draft.locationMode === 'local'
    ? Boolean(draft.workingDirectory)
    : Boolean(draft.hostProfileId && draft.remoteRoot.trim().startsWith('/'))
}

export async function submitNewProjectDraft(
  draft: NewProjectDraft,
  handlers: {
    createLocal: (
      name: string,
      workingDirectory: string,
      permissionMode: NewProjectDraft['permissionMode']
    ) => Promise<void>
    createRemote: (input: RemoteProjectCreateInput) => Promise<void>
  }
): Promise<void> {
  if (!canSubmitNewProject(draft)) throw new Error('请先选择项目位置')
  if (draft.locationMode === 'ssh') {
    await handlers.createRemote({
      name: draft.name,
      hostProfileId: draft.hostProfileId,
      remoteRoot: draft.remoteRoot.trim(),
      permissionMode: draft.permissionMode
    })
    return
  }
  await handlers.createLocal(draft.name, draft.workingDirectory, draft.permissionMode)
}
