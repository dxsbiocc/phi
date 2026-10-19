import {
  remotePathInsideRoot,
  remotePathWithinProjectUri,
  remoteWorkspaceUri
} from '../../../../../shared/remoteWorkspacePath'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { appCopy } from '../../../lib/appCopy'
import type { LocalPathKind } from '../../../lib/markdownLocalPathReferences'
import { workspaceFileTabKey } from '../../../lib/workspaceResourceTabs'
import { absoluteWorkspacePath } from '../../../lib/workspacePaths'
import { isNotebookFilePath } from '../../analysis/lib/notebookPaths'
import {
  wrapperResultBelongsToProject,
  wrapperResultScopeForPath,
  type WrapperResultFileScope
} from '../../wrapper/lib/resultFiles'

/**
 * Where a path opens.
 *
 * Every entry point below answers the same routing question: given a path and
 * whether it is a file or a directory, which surface should show it? The
 * precedence is the whole point and is easy to get out of order when the
 * callbacks are scattered across the shell:
 *
 * 1. A wrapper result that belongs to the active project opens as a scoped
 *    result, never as an ordinary workspace file.
 * 2. In a remote project, a path opens remotely; a path outside the project is
 *    refused instead of being read from the local anchor.
 * 3. A local path in a remote project is blocked (it would read the wrong disk).
 * 4. Notebooks hand off to the analysis workspace.
 * 5. Everything else opens in the file preview (or the OS default).
 *
 * The layout change happens before the surface is chosen, so the sidebar ends up
 * in the state the new tab expects.
 *
 * The surfaces themselves are passed in: they belong to the workspace tab
 * store, the analysis feature, and the OS, not to this router.
 */

export type RemotePathScope = { hostAlias: string; canonicalRoot: string }

export type WrapperResultTargets = {
  scope: WrapperResultFileScope | null
  isActiveUri: (uri: string) => boolean
  openPath: (scope: WrapperResultFileScope, path: string, pathKind: LocalPathKind) => string
}

export type PathOpenerTargets = {
  applyLayout: () => void
  getActiveCwd: () => string
  setActiveTabKey: (key: string) => void
  previewFile: (path: string) => void
  previewDirectory: (path: string) => void
  openSystemDefault: (path: string) => void
  /** Reads the visible project: remote routing and local-path blocking depend on it. */
  isRemoteProject: () => boolean
  getActiveProjectId: () => string | null
  getRemoteScope: () => RemotePathScope | null
  blockLocalInRemote: () => boolean
  notifyError: (error: unknown, fallback: string) => void
  openNotebook: (path: string) => void
  wrapper: WrapperResultTargets
}

export function previewFileInWorkspaceTab(targets: PathOpenerTargets, path: string): void {
  const normalizedPath = absoluteWorkspacePath(targets.getActiveCwd(), path)
  targets.applyLayout()
  targets.setActiveTabKey(workspaceFileTabKey(normalizedPath))
  targets.previewFile(path)
}

export function previewDirectoryInWorkspaceTab(targets: PathOpenerTargets, path: string): void {
  const normalizedPath = absoluteWorkspacePath(targets.getActiveCwd(), path)
  targets.applyLayout()
  targets.setActiveTabKey(workspaceFileTabKey(normalizedPath))
  targets.previewDirectory(path)
}

export function openRemoteWorkspacePath(
  targets: PathOpenerTargets,
  path: string,
  kind: LocalPathKind
): void {
  const scope = targets.getRemoteScope()
  if (!scope) {
    targets.notifyError(new Error(appCopy.remoteSessionUnavailable), appCopy.openRemoteFileFailed)
    return
  }
  const uri = path.startsWith('ssh://')
    ? path
    : remotePathInsideRoot(path, scope.canonicalRoot)
      ? remoteWorkspaceUri(scope.hostAlias, path)
      : null
  if (!uri || !remotePathWithinProjectUri(uri, scope.hostAlias, scope.canonicalRoot)) {
    targets.notifyError(new Error(appCopy.remotePathOutsideProject), appCopy.openRemoteFileFailed)
    return
  }
  targets.applyLayout()
  targets.setActiveTabKey(workspaceFileTabKey(uri))
  if (kind === 'directory') targets.previewDirectory(uri)
  else targets.previewFile(uri)
}

export function openRemoteNotebookPath(targets: PathOpenerTargets, path: string): boolean {
  if (!isNotebookFilePath(path)) return false
  const scope = targets.getRemoteScope()
  const serverPath = scope
    ? path.startsWith('ssh://')
      ? remotePathWithinProjectUri(path, scope.hostAlias, scope.canonicalRoot)
      : remotePathInsideRoot(path, scope.canonicalRoot)
        ? path
        : null
    : null
  if (!serverPath) {
    targets.notifyError(new Error(appCopy.wrongRemoteNotebook), appCopy.openNotebookFailed)
    return true
  }
  targets.openNotebook(serverPath)
  return true
}

export function openActiveWrapperResultPath(
  targets: PathOpenerTargets,
  path: string,
  kind: LocalPathKind
): boolean {
  if (
    !wrapperResultBelongsToProject(targets.wrapper.scope, targets.getActiveProjectId()) ||
    !targets.wrapper.isActiveUri(path)
  ) {
    return false
  }
  targets.applyLayout()
  targets.setActiveTabKey(workspaceFileTabKey(path))
  if (kind === 'directory') targets.previewDirectory(path)
  else targets.previewFile(path)
  return true
}

export function openWrapperResult(
  targets: PathOpenerTargets,
  run: WrapperRun,
  path: string,
  kind: LocalPathKind
): void {
  if (!run.remote?.projectId || run.remote.projectId !== targets.getActiveProjectId()) {
    targets.notifyError(new Error(appCopy.selectRunProject), appCopy.openRemoteResultFailed)
    return
  }
  const scope = wrapperResultScopeForPath(run, path)
  if (!scope) {
    targets.notifyError(new Error(appCopy.resultScopeMissing), appCopy.openRemoteResultFailed)
    return
  }
  try {
    targets.applyLayout()
    const uri = targets.wrapper.openPath(scope, path, kind)
    targets.setActiveTabKey(workspaceFileTabKey(uri))
  } catch (error) {
    targets.notifyError(error, appCopy.openRemoteResultFailed)
  }
}

export function openWorkspaceFileFromSidebar(targets: PathOpenerTargets, path: string): void {
  targets.applyLayout()
  if (targets.isRemoteProject()) {
    if (openRemoteNotebookPath(targets, path)) return
    openRemoteWorkspacePath(targets, path, 'file')
    return
  }
  if (targets.blockLocalInRemote()) return
  const normalizedPath = absoluteWorkspacePath(targets.getActiveCwd(), path)
  targets.setActiveTabKey(workspaceFileTabKey(normalizedPath))
  if (isNotebookFilePath(path)) {
    targets.openNotebook(path)
    return
  }
  targets.previewFile(path)
}

export function openFilePreview(targets: PathOpenerTargets, path: string): void {
  if (openActiveWrapperResultPath(targets, path, 'file')) return
  if (targets.isRemoteProject()) {
    if (openRemoteNotebookPath(targets, path)) return
    openRemoteWorkspacePath(targets, path, 'file')
    return
  }
  if (targets.blockLocalInRemote()) return
  if (isNotebookFilePath(path)) {
    targets.openNotebook(path)
    return
  }
  previewFileInWorkspaceTab(targets, path)
}

export function openLocalPath(
  targets: PathOpenerTargets,
  path: string,
  pathKind: LocalPathKind
): void {
  if (openActiveWrapperResultPath(targets, path, pathKind)) return
  if (targets.isRemoteProject()) {
    if (pathKind === 'file' && openRemoteNotebookPath(targets, path)) return
    openRemoteWorkspacePath(targets, path, pathKind)
    return
  }
  if (targets.blockLocalInRemote()) return
  if (pathKind === 'directory') {
    previewDirectoryInWorkspaceTab(targets, path)
    return
  }
  if (isNotebookFilePath(path)) {
    targets.openNotebook(path)
    return
  }
  previewFileInWorkspaceTab(targets, path)
}

export function openDefaultPreviewPath(
  targets: PathOpenerTargets,
  path: string,
  kind: LocalPathKind = 'file'
): void {
  if (openActiveWrapperResultPath(targets, path, kind)) return
  if (targets.isRemoteProject()) {
    if (kind === 'file' && openRemoteNotebookPath(targets, path)) return
    openRemoteWorkspacePath(targets, path, kind)
    return
  }
  if (targets.blockLocalInRemote()) return
  if (isNotebookFilePath(path)) {
    targets.openNotebook(path)
    return
  }
  targets.openSystemDefault(path)
}
