import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { AgentUserInteractionResponse } from '../../shared/agentInteractionTypes'
import type { PromptImageInput } from '../../shared/promptImageTypes'
import type { PermissionMode } from '../agent/projects'
import {
  MAX_AGENT_STEER_LENGTH,
  recordAgentSteer,
  requestAgentRunControl
} from '../agent/agents/agent-run-control-request'
import { stopActivePrompt, type ActivePromptStopOptions } from '../agent/session/active-prompt-stop'
import { readPromptImage, validatePromptImages } from '../agent/session/prompt-images'
import type { PromptTargetInput } from '../agent/session/prompt-target-control'

interface PromptRunInput {
  sessionKey: string
  snapshot: {
    path: string | undefined
    cwd: string
    permissionMode: PermissionMode
  }
  text: string
  images?: PromptImageInput[]
  promptTarget: PromptTargetInput | null
  planMode?: boolean
}

export interface AgentIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  state: {
    getCurrentSessionKey: () => string
    getCurrentSessionPath: () => string | undefined
    getCurrentCwd: () => string
    getCurrentPermissionMode: () => PermissionMode
    resolveSessionKeyAlias: (key: string) => string
    runtimeSessionPath: (path: string | undefined) => string | undefined
  }
  prompt: {
    parseTarget: (input: unknown) => PromptTargetInput | null
    alignCurrentSessionToTarget: (input: unknown) => Promise<void>
    submit: (input: PromptRunInput) => Promise<unknown>
  }
  stop: Omit<ActivePromptStopOptions, 'getCurrentSessionKey'>
  agentRuns: {
    control: Parameters<typeof requestAgentRunControl>[0]
    persistence: Parameters<typeof recordAgentSteer>[0]
  }
}

export interface AgentInteractionIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  resolveAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled: boolean,
    webContentsId: number
  ) => void
}

export function registerAgentPromptIpc(options: AgentIpcOptions): void {
  const ipcMain = options.ipcMain

  ipcMain.handle(IPC.agent.prompt, async (_, text: string, targetInput?: unknown) => {
    const normalizedText = typeof text === 'string' ? text.trim() : ''
    const images = validatePromptImages(
      targetInput && typeof targetInput === 'object'
        ? (targetInput as Record<string, unknown>).images
        : undefined
    )
    if (!normalizedText && images.length === 0) return null
    const promptTarget = options.prompt.parseTarget(targetInput)
    if (targetInput !== undefined) {
      await options.prompt.alignCurrentSessionToTarget(targetInput)
    }

    return options.prompt.submit({
      sessionKey: options.state.resolveSessionKeyAlias(options.state.getCurrentSessionKey()),
      snapshot: {
        path: options.state.runtimeSessionPath(options.state.getCurrentSessionPath()),
        cwd: options.state.getCurrentCwd(),
        permissionMode: options.state.getCurrentPermissionMode()
      },
      text: normalizedText,
      images,
      promptTarget,
      planMode: promptTarget?.planMode === true
    })
  })

  ipcMain.handle(IPC.agent.readPromptImage, async (_, ref: unknown) => readPromptImage(ref))
}

export function registerAgentRunControlIpc(options: AgentIpcOptions): void {
  const ipcMain = options.ipcMain

  ipcMain.handle(IPC.agent.stop, async () => {
    await stopActivePrompt({
      getCurrentSessionKey: options.state.getCurrentSessionKey,
      ...options.stop
    })
  })

  // A delegation card steers or stops the run it shows. The card knows which agent session
  // owns the run; the worker answers if the run is still there.
  ipcMain.handle(
    IPC.agent.steerRun,
    async (
      _,
      agentSessionId: unknown,
      agentRunId: unknown,
      message: unknown,
      toolCallId?: unknown
    ) => {
      const text = typeof message === 'string' ? message.trim() : ''
      if (!text) throw new Error('消息不能为空')
      if (text.length > MAX_AGENT_STEER_LENGTH) throw new Error('消息过长')
      await requestAgentRunControl(
        options.agentRuns.control,
        'agentRun.steer',
        agentSessionId,
        agentRunId,
        text
      )
      recordAgentSteer(options.agentRuns.persistence, agentSessionId, agentRunId, toolCallId, text)
    }
  )
  ipcMain.handle(IPC.agent.stopRun, async (_, agentSessionId: unknown, agentRunId: unknown) => {
    await requestAgentRunControl(
      options.agentRuns.control,
      'agentRun.stop',
      agentSessionId,
      agentRunId
    )
  })
}

export function registerAgentInteractionIpc(options: AgentInteractionIpcOptions): void {
  const ipcMain = options.ipcMain
  ipcMain.handle(
    IPC.agent.interactionResponse,
    async (event, requestId: string, response, cancelled?: boolean) => {
      const window = options.requireMainWindowRenderer(event)
      options.resolveAgentUserInteraction(
        requestId,
        response,
        cancelled === true,
        window.webContents.id
      )
    }
  )
}
