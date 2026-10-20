import { writeFileSync } from 'node:fs'
import { posix } from 'node:path'

import { dialog, type BrowserWindow, type IpcMain } from 'electron'

import { errorMessage } from '../../shared/errorCodes'
import { IPC } from '../../shared/ipcChannels'
import { declaredExternalOutputRoot } from '../../shared/wrapperResultTypes'
import type { WrapperRetargetRequest, WrapperSubmitConfirmation } from '../../shared/wrapperTypes'
import { writeAppLog } from '../agent/app-logger'
import { readAppSettings } from '../agent/app-settings'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'
import { listProjects } from '../agent/projects'
import { isRemoteProjectAnchorPath } from '../agent/remote-project-anchor'
import type { RemoteProjectUploadService } from '../agent/remote-project-upload'
import type { PhiSessionManifest } from '../agent/session/session-store'
import { addCustomWrapper, listWrapperCatalog } from '../agent/wrappers/catalog'
import {
  listWrapperCompositionCatalogStatus,
  readWrapperCompositionDag,
  readWrapperModuleDetails
} from '../agent/wrappers/composition/discovery'
import type { WrapperJobManager } from '../agent/wrappers/composition/job-manager'
import { recordWrapperUploadedInput, retargetWrapperRunPlan } from '../agent/wrappers/plans'
import { buildWrapperReproducibilityBundle } from '../agent/wrappers/reproducibility'
import {
  cancelWrapperRun,
  cancelWrapperRunPlan,
  submitWrapperRunPlan
} from '../agent/wrappers/runs'
import {
  listWrapperRuns,
  readWrapperPlan,
  readWrapperPlanArtifact,
  readWrapperRun
} from '../agent/wrappers/store'
import { nativeUiCopy } from '../native-ui-copy'

export interface WrappersIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    logUnexpectedError: (error: unknown) => void
  }
  workspace: {
    agentDir: string
  }
  session: {
    getCurrent: () => { key: string; path: string | undefined; cwd: string }
    findPhiManifestForSession: (
      sessionKey: string,
      path: string | undefined,
      cwd: string
    ) => PhiSessionManifest | null
  }
  execution: {
    environmentBuilds: EnvironmentBuilds
    wrapperJobs: Pick<WrapperJobManager, 'cancel'>
  }
  uploads: Pick<RemoteProjectUploadService, 'wait'>
  windows: {
    getActiveWindow: () => BrowserWindow | null
  }
}

export function registerWrapperInputUploadIpc(options: WrappersIpcOptions): void {
  const ipcMain = options.ipcMain
  const remoteProjectUploads = options.uploads

  ipcMain.handle(
    IPC.wrappers.completeInputUpload,
    async (_, jobId: unknown, planId: unknown, inputId: unknown, expectedRevision: unknown) => {
      if (
        typeof jobId !== 'string' ||
        typeof planId !== 'string' ||
        typeof inputId !== 'string' ||
        !Number.isSafeInteger(expectedRevision)
      ) {
        throw new Error('Wrapper 上传输入绑定无效')
      }
      const plan = readWrapperPlan(planId)
      const projectId = plan?.targetSelection?.projectId
      if (!projectId || plan.targetSelection?.projectLocation.kind !== 'ssh') {
        throw new Error('Wrapper 上传输入计划不属于 SSH 项目')
      }
      const job = await remoteProjectUploads.wait(projectId, jobId)
      if (
        job.status !== 'completed' ||
        job.sourcePaths.length !== 1 ||
        !job.files[0]?.destinationPath
      ) {
        throw new Error('上传未完成，Wrapper 计划不会启动')
      }
      const parts = job.files[0].relativePath.split('/')
      let remotePath = job.files[0].destinationPath
      for (let index = 1; index < parts.length; index += 1) remotePath = posix.dirname(remotePath)
      return recordWrapperUploadedInput({
        planId,
        inputId,
        expectedRevision: expectedRevision as number,
        localPath: job.sourcePaths[0]!,
        remotePath
      })
    }
  )
}

interface WrapperPlanIpcContext {
  ipcMain: WrappersIpcOptions['ipcMain']
  agentDir: string
  getCurrentSession: WrappersIpcOptions['session']['getCurrent']
  findPhiManifestForSession: WrappersIpcOptions['session']['findPhiManifestForSession']
  environmentBuilds: EnvironmentBuilds
  logUnexpectedError: (error: unknown) => void
}

function wrapperPlanIpcContext(options: WrappersIpcOptions): WrapperPlanIpcContext {
  return {
    ipcMain: options.ipcMain,
    agentDir: options.workspace.agentDir,
    getCurrentSession: options.session.getCurrent,
    findPhiManifestForSession: options.session.findPhiManifestForSession,
    environmentBuilds: options.execution.environmentBuilds,
    logUnexpectedError: options.lifecycle.logUnexpectedError
  }
}

export function registerWrapperPlanIpc(options: WrappersIpcOptions): void {
  const context = wrapperPlanIpcContext(options)
  registerWrapperPlanSelectionIpc(context)
  registerWrapperPlanSubmissionIpc(context)
  registerWrapperPlanCatalogIpc(context)
}

function registerWrapperPlanSelectionIpc(context: WrapperPlanIpcContext): void {
  const ipcMain = context.ipcMain

  ipcMain.handle(IPC.wrappers.getPlan, async (_, planId: string) => readWrapperPlan(planId))
  ipcMain.handle(IPC.wrappers.retargetPlan, async (_, request: WrapperRetargetRequest) => {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (key) => !['planId', 'target', 'expectedRevision', 'confirmedLocalFallback'].includes(key)
      ) ||
      typeof request.planId !== 'string' ||
      !request.planId ||
      (request.target !== 'local' && request.target !== 'remote') ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      (request.confirmedLocalFallback !== undefined &&
        typeof request.confirmedLocalFallback !== 'boolean')
    ) {
      throw new Error('Invalid Wrapper target change request')
    }
    return retargetWrapperRunPlan(request)
  })
}

// eslint-disable-next-line max-lines-per-function -- Keeps the existing submit handler verbatim in one registration.
function registerWrapperPlanSubmissionIpc(context: WrapperPlanIpcContext): void {
  const ipcMain = context.ipcMain
  const AGENT_DIR = context.agentDir
  const getCurrentSession = context.getCurrentSession
  const findPhiManifestForSession = context.findPhiManifestForSession
  const environmentBuilds = context.environmentBuilds
  const logUnexpectedError = context.logUnexpectedError

  /* eslint-disable complexity, max-lines-per-function -- The existing target validation is preserved verbatim. */
  ipcMain.handle(
    IPC.wrappers.submitPlan,
    async (
      _,
      planId: string,
      heavyWorkloadAcknowledged?: boolean,
      confirmation?: WrapperSubmitConfirmation
    ) => {
      const plan = readWrapperPlan(planId)
      const selected = plan?.targetSelection
      if (selected) {
        if (
          !selected.projectLocation ||
          !['local', 'ssh'].includes(selected.projectLocation.kind)
        ) {
          throw new Error('The plan target snapshot is invalid. Create a new plan.')
        }
        if (
          !confirmation ||
          typeof confirmation !== 'object' ||
          Object.keys(confirmation).some(
            (key) =>
              ![
                'expectedRevision',
                'target',
                'projectId',
                'hostProfileId',
                'remoteRoot',
                'externalOutputRoot'
              ].includes(key)
          ) ||
          confirmation.expectedRevision !== plan.revision ||
          confirmation.target !== selected.target ||
          confirmation.projectId !== selected.projectId ||
          confirmation.hostProfileId !== selected.hostProfileId ||
          confirmation.remoteRoot !== selected.remoteRoot ||
          confirmation.externalOutputRoot !==
            (selected.target === 'remote'
              ? declaredExternalOutputRoot(selected.remoteRoot, plan.params?.outdir)
              : undefined)
        ) {
          throw new Error(
            'The plan execution target has changed. Refresh the plan card and confirm again.'
          )
        }
      }
      const currentSession = getCurrentSession()
      if (isRemoteProjectAnchorPath(currentSession.cwd, AGENT_DIR)) {
        const manifest = findPhiManifestForSession(
          currentSession.key,
          currentSession.path,
          currentSession.cwd
        )
        if (
          manifest?.projectLocation?.kind !== 'ssh' ||
          plan?.targetSelection?.projectId !== manifest.projectId ||
          plan.targetSelection.target !== 'remote'
        ) {
          throw new Error(
            'Remote projects can only submit Wrapper plans bound to their server; they will not run locally'
          )
        }
      }
      if (selected?.target === 'remote' && selected.projectLocation.kind === 'ssh') {
        const current = listProjects().find((project) => project.id === selected.projectId)
        if (current?.remoteConnection?.phase !== 'reachable') {
          throw new Error(
            current?.remoteConnection?.message ??
              'The server connection is not ready. Reconnect before submitting.'
          )
        }
      }
      try {
        return submitWrapperRunPlan(planId, {
          heavyWorkloadAcknowledged,
          externalOutputRoot: confirmation?.externalOutputRoot,
          nextflowLaunch: { builds: environmentBuilds }
        })
      } catch (error) {
        logUnexpectedError(error)
        throw error
      }
    }
  )
  /* eslint-enable complexity, max-lines-per-function */
}

function registerWrapperPlanCatalogIpc(context: WrapperPlanIpcContext): void {
  const ipcMain = context.ipcMain
  const AGENT_DIR = context.agentDir
  const logUnexpectedError = context.logUnexpectedError

  ipcMain.handle(IPC.wrappers.cancelPlan, async (_, planId: string) => {
    try {
      return cancelWrapperRunPlan(planId)
    } catch (error) {
      logUnexpectedError(error)
      throw error
    }
  })
  ipcMain.handle(IPC.wrappers.listCatalog, async () => listWrapperCatalog())
  ipcMain.handle(IPC.wrappers.listCompositionCatalog, async () =>
    listWrapperCompositionCatalogStatus({ agentDir: AGENT_DIR })
  )
  ipcMain.handle(IPC.wrappers.getCompositionDag, async (_, id: string) =>
    readWrapperCompositionDag(id)
  )
  ipcMain.handle(IPC.wrappers.getCompositionModuleDetails, async (_, id: string) =>
    readWrapperModuleDetails(id)
  )
  ipcMain.handle(IPC.wrappers.addCustom, async (_, sourceDir: string) => {
    try {
      const entry = addCustomWrapper(sourceDir)
      writeAppLog({ event: 'wrapper_custom_added', metadata: { sourceDir, id: entry.manifest.id } })
      return entry
    } catch (error) {
      logUnexpectedError(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_custom_add_failed',
        metadata: { sourceDir, error: errorMessage(error) }
      })
      throw error
    }
  })
  ipcMain.handle(IPC.wrappers.listRuns, async () => listWrapperRuns())
}

export function registerWrapperRunIpc(options: WrappersIpcOptions): void {
  const ipcMain = options.ipcMain
  const wrapperJobs = options.execution.wrapperJobs
  const getActiveWindow = options.windows.getActiveWindow
  const logUnexpectedError = options.lifecycle.logUnexpectedError

  ipcMain.handle(IPC.wrappers.getRun, async (_, runId: string) => readWrapperRun(runId))
  ipcMain.handle(IPC.wrappers.cancelRun, async (_, runId: string) => {
    try {
      // Agent-started (background) runs are owned by the job manager, not the plan executor.
      if (readWrapperRun(runId)?.origin === 'composition') {
        const cancelled = await wrapperJobs.cancel(runId)
        if (!cancelled.ok) throw new Error(cancelled.error)
        return readWrapperRun(runId)
      }
      return cancelWrapperRun(runId)
    } catch (error) {
      logUnexpectedError(error)
      throw error
    }
  })
  ipcMain.handle(IPC.wrappers.getPlanArtifact, async (_, planId: string, fileName: string) =>
    readWrapperPlanArtifact(planId, fileName)
  )
  ipcMain.handle(IPC.wrappers.exportReproducibility, async (_, runId: string) => {
    try {
      const bundle = buildWrapperReproducibilityBundle(runId)
      const window = getActiveWindow()
      const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
      const options: Electron.SaveDialogOptions = {
        title: dialogCopy.exportReproducibility,
        buttonLabel: dialogCopy.save,
        defaultPath: `phi-wrapper-${runId}-reproducibility.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8')
      writeAppLog({ event: 'wrapper_reproducibility_exported', metadata: { runId } })
      return result.filePath
    } catch (error) {
      logUnexpectedError(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_reproducibility_export_failed',
        metadata: { runId, error: errorMessage(error) }
      })
      throw error
    }
  })
}
