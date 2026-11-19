import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { AgentUserInteractionResponse } from '../../shared/agentInteractionTypes'
import type { PromptImageInput } from '../../shared/promptImageTypes'
import {
  MAX_AGENT_STEER_LENGTH,
  recordAgentSteer,
  requestAgentRunControl
} from '../agent/agents/agent-run-control-request'
import { stopActivePrompt, type ActivePromptStopOptions } from '../agent/session/active-prompt-stop'
import { readPromptImage, validatePromptImages } from '../agent/session/prompt-images'
import type {
  PromptRunDestination,
  PromptTargetInput
} from '../agent/session/prompt-target-control'
import type { DurableChat } from '../session-runtime/durable-chat'
import type { TaskEventService } from '../session-runtime/task-event-service'

interface PromptRunInput extends PromptRunDestination {
  text: string
  images?: PromptImageInput[]
  promptTarget: PromptTargetInput | null
  planMode?: boolean
  planExecute?: boolean
}

export interface AgentIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  state: {
    getCurrentSessionKey: () => string
  }
  prompt: {
    requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
    parseTarget: (input: unknown) => PromptTargetInput | null
    resolveDestination: (
      target: PromptTargetInput | null
    ) => PromptRunDestination | Promise<PromptRunDestination>
    submit: (input: PromptRunInput) => Promise<unknown>
  }
  durableChat: Pick<DurableChat, 'submit' | 'list' | 'listJobs' | 'cancel'>
  taskEvents: TaskEventService
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

  ipcMain.handle(IPC.agent.prompt, async (event, text: string, targetInput?: unknown) => {
    options.prompt.requireMainWindowRenderer(event)
    const normalizedText = typeof text === 'string' ? text.trim() : ''
    const images = validatePromptImages(
      targetInput && typeof targetInput === 'object'
        ? (targetInput as Record<string, unknown>).images
        : undefined
    )
    if (!normalizedText && images.length === 0) return null
    const promptTarget = options.prompt.parseTarget(targetInput)
    const destination = options.prompt.resolveDestination(promptTarget)
    const bound = destination instanceof Promise ? await destination : destination

    return options.prompt.submit({
      ...bound,
      text: normalizedText,
      images,
      promptTarget,
      planMode: promptTarget?.planMode === true && promptTarget.planExecute !== true,
      planExecute: promptTarget?.planExecute === true
    })
  })

  ipcMain.handle(IPC.agent.readPromptImage, async (event, ref: unknown) => {
    options.prompt.requireMainWindowRenderer(event)
    return readPromptImage(ref)
  })
  ipcMain.handle(IPC.agent.submitQueuedPrompt, (event, text, target, requestId) => {
    options.prompt.requireMainWindowRenderer(event)
    return options.durableChat.submit(text, target, requestId)
  })
  ipcMain.handle(IPC.agent.routeTaskEvent, (event, text, target, requestId) => {
    const window = options.prompt.requireMainWindowRenderer(event)
    return options.taskEvents.route(text, target, requestId, {
      responder: window.webContents,
      authorize: () => options.prompt.requireMainWindowRenderer(event)
    })
  })
  ipcMain.handle(IPC.agent.listQueuedPrompts, (event, sessionId) => {
    options.prompt.requireMainWindowRenderer(event)
    return options.durableChat.list(sessionId)
  })
  ipcMain.handle(IPC.agent.listChatQueueJobs, (event) => {
    options.prompt.requireMainWindowRenderer(event)
    return options.durableChat.listJobs()
  })
  ipcMain.handle(IPC.agent.cancelQueuedPrompt, (event, sessionId, itemId) => {
    options.prompt.requireMainWindowRenderer(event)
    return options.durableChat.cancel(sessionId, itemId)
  })
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
