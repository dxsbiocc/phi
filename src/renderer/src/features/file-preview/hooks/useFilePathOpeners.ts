import { useMemo } from 'react'

import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import type { LocalPathKind } from '../../../lib/markdownLocalPathReferences'
import { useSessionStore } from '../../../stores/sessionStore'
import type { WrapperResultFileScope } from '../../wrapper/lib/resultFiles'
import {
  openDefaultPreviewPath,
  openFilePreview,
  openLocalPath,
  openRemoteWorkspacePath,
  openWorkspaceFileFromSidebar,
  openWrapperResult,
  previewDirectoryInWorkspaceTab,
  previewFileInWorkspaceTab,
  type PathOpenerTargets,
  type RemotePathScope
} from '../lib/pathOpeners'

/** Routing reads the visible project at call time, like the shell callbacks did. */
const isRemoteProject = (): boolean =>
  useSessionStore.getState().activeProjectLocation?.kind === 'ssh'
const getActiveProjectId = (): string | null => useSessionStore.getState().activeProjectId

/**
 * Binds the path router to the surfaces the shell owns.
 *
 * The routing rules themselves live in `lib/pathOpeners` as plain functions, so
 * they can be tested by calling them with recording targets rather than by
 * slicing hooks out of the shell. This hook only assembles those targets and
 * keeps the returned handlers stable between renders.
 *
 * Everything is rebound together on purpose: the router decides with the whole
 * context (remote scope, wrapper scope, preview targets), so a partial rebind
 * would let two handlers disagree about which project is visible.
 */
export type FilePathOpenerDeps = {
  applyFileOpenConversationLayout: () => void
  getActiveCwd: () => string
  setActiveWorkspaceTabKey: (key: string) => void
  previewFilePath: (path: string) => void
  previewDirectoryPath: (path: string) => void
  openPathWithSystemDefault: (path: string) => void
  getActiveRemoteProject: () => RemotePathScope | null
  blockRemoteLocalFileAction: () => boolean
  showSnackbarError: (error: unknown, fallback: string) => void
  /** Owned by the analysis feature; the shell passes its notebook opener through. */
  onOpenNotebookWorkspaceFile: (path: string) => void
  activeWrapperResultScope: WrapperResultFileScope | null
  isActiveWrapperResultUri: (uri: string) => boolean
  openWrapperResultPath: (
    scope: WrapperResultFileScope,
    path: string,
    pathKind: LocalPathKind
  ) => string
}

export type FilePathOpeners = {
  previewFilePathInWorkspaceTab: (path: string) => void
  previewDirectoryPathInWorkspaceTab: (path: string) => void
  /** Exposed for the remote file context: remote Markdown and tree paths route here. */
  openRemoteWorkspacePath: (path: string, kind: LocalPathKind) => void
  onOpenWorkspaceFileFromSidebar: (path: string) => void
  onOpenFilePreview: (path: string) => void
  onOpenLocalPath: (path: string, pathKind: LocalPathKind) => void
  onOpenDefaultPreviewPath: (path: string, kind?: LocalPathKind) => void
  onOpenWrapperResult: (run: WrapperRun, path: string, kind: LocalPathKind) => void
}

export function useFilePathOpeners(deps: FilePathOpenerDeps): FilePathOpeners {
  const {
    applyFileOpenConversationLayout,
    getActiveCwd,
    setActiveWorkspaceTabKey,
    previewFilePath,
    previewDirectoryPath,
    openPathWithSystemDefault,
    getActiveRemoteProject,
    blockRemoteLocalFileAction,
    showSnackbarError,
    onOpenNotebookWorkspaceFile,
    activeWrapperResultScope,
    isActiveWrapperResultUri,
    openWrapperResultPath
  } = deps

  return useMemo<FilePathOpeners>(() => {
    const targets: PathOpenerTargets = {
      applyLayout: applyFileOpenConversationLayout,
      getActiveCwd,
      setActiveTabKey: setActiveWorkspaceTabKey,
      previewFile: previewFilePath,
      previewDirectory: previewDirectoryPath,
      openSystemDefault: openPathWithSystemDefault,
      isRemoteProject,
      getActiveProjectId,
      getRemoteScope: getActiveRemoteProject,
      blockLocalInRemote: blockRemoteLocalFileAction,
      notifyError: showSnackbarError,
      openNotebook: onOpenNotebookWorkspaceFile,
      wrapper: {
        scope: activeWrapperResultScope,
        isActiveUri: isActiveWrapperResultUri,
        openPath: openWrapperResultPath
      }
    }
    return {
      previewFilePathInWorkspaceTab: (path) => previewFileInWorkspaceTab(targets, path),
      previewDirectoryPathInWorkspaceTab: (path) => previewDirectoryInWorkspaceTab(targets, path),
      openRemoteWorkspacePath: (path, kind) => openRemoteWorkspacePath(targets, path, kind),
      onOpenWorkspaceFileFromSidebar: (path) => openWorkspaceFileFromSidebar(targets, path),
      onOpenFilePreview: (path) => openFilePreview(targets, path),
      onOpenLocalPath: (path, kind) => openLocalPath(targets, path, kind),
      onOpenDefaultPreviewPath: (path, kind = 'file') =>
        openDefaultPreviewPath(targets, path, kind),
      onOpenWrapperResult: (run, path, kind) => openWrapperResult(targets, run, path, kind)
    }
  }, [
    activeWrapperResultScope,
    applyFileOpenConversationLayout,
    blockRemoteLocalFileAction,
    getActiveCwd,
    getActiveRemoteProject,
    isActiveWrapperResultUri,
    onOpenNotebookWorkspaceFile,
    openPathWithSystemDefault,
    openWrapperResultPath,
    previewDirectoryPath,
    previewFilePath,
    setActiveWorkspaceTabKey,
    showSnackbarError
  ])
}
