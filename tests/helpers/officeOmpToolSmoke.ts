import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage,
  type ExtensionFactory
} from '@oh-my-pi/pi-coding-agent'
import { createAgentSession } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'

import { buildOfficeTools } from '../../src/main/agent/office/office-tools'
import {
  deliverHostResponse,
  executeTool,
  exerciseOfficeDeliverTool,
  type ActiveTool,
  type SdkAgent
} from './officeOmpDeliverSmoke'

type PermissionMode = 'ask' | 'auto' | 'full'

const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto', 'full']
const rootDir = mkdtempSync(join(tmpdir(), 'phi-office-omp-smoke-'))

function askModeProbe(toolCallIds: string[]): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName === 'office_apply' || event.toolName === 'office_deliver') {
        toolCallIds.push(event.toolCallId)
      }
    })
  }
}

function hostResponse(method: string, params: unknown): unknown {
  if (method === 'office.deliver') return deliverHostResponse(params)
  return method === 'office.apply' ? writeHostResponse(params) : readHostResponse(params)
}

function readHostResponse(params: unknown): unknown {
  if (!('from' in (params as Record<string, unknown>))) return spreadsheetReadResponse()
  return (params as { limit?: unknown }).limit === 5 ? pptxReadResponse() : docxReadResponse()
}

function writeHostResponse(params: unknown): unknown {
  const operation = (
    params as {
      operation?: {
        type?: unknown
        slideId?: unknown
        elementId?: unknown
        text?: unknown
        title?: unknown
        value?: unknown
      }
    }
  ).operation
  if (operation?.type === 'add_paragraph') {
    return docxWriteResponse(operation.text)
  }
  if (operation?.type === 'add_slide') {
    if (operation.title === '拒绝样例') return approvalDenied()
    return pptxWriteResponse(operation.title)
  }
  if (operation?.type === 'set_slide_text') {
    return pptxSetResponse(operation.slideId, operation.elementId, operation.text)
  }
  return operation.value === '拒绝样例'
    ? approvalDenied()
    : spreadsheetWriteResponse(operation.value)
}

function spreadsheetReadResponse(): unknown {
  return {
    ok: true,
    value: {
      revision: 3,
      sheet: 'Sheet1',
      range: 'A1:B3',
      cells: [{ ref: 'A1', value: 'ok', valueType: 'string' }],
      rowCount: 3,
      columnCount: 2,
      complete: true,
      truncated: false,
      limits: { maxCells: 6, maxBytes: 262144 }
    }
  }
}

function spreadsheetWriteResponse(value: unknown): unknown {
  return {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 4,
      sheet: 'Sheet1',
      cell: 'A1',
      before: '旧值',
      after: value,
      previewConfirmed: true
    }
  }
}

function docxReadResponse(): unknown {
  return {
    ok: true,
    value: {
      revision: 4,
      paragraphs: [
        {
          paraId: '0010000A',
          index: 0,
          text: 'OMP Word 正文',
          style: 'Normal',
          editable: true,
          truncated: false
        }
      ],
      total: 1,
      complete: true,
      truncated: false,
      limits: {
        maxParagraphs: 200,
        maxParagraphBytes: 16384,
        maxTextBytes: 196608,
        maxBytes: 262144
      }
    }
  }
}

function docxWriteResponse(text: unknown): unknown {
  return {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 5,
      paraId: '0010000B',
      path: '/body/p[@paraId=0010000B]',
      index: 1,
      text,
      previewConfirmed: true
    }
  }
}

function pptxReadResponse(): unknown {
  return {
    ok: true,
    value: {
      revision: 6,
      slides: [
        {
          slideId: '256',
          index: 0,
          title: 'OMP PPTX 标题',
          elements: [
            {
              elementId: '2',
              path: '/slide[@id=256]/shape[@id=2]',
              kind: 'title',
              text: 'OMP PPTX 标题',
              editable: true,
              truncated: false
            }
          ]
        }
      ],
      total: 1,
      complete: true,
      truncated: false,
      limits: {
        maxSlides: 50,
        maxElementsPerSlide: 100,
        maxElementBytes: 8192,
        maxSlideTextBytes: 32768,
        maxTextBytes: 196608,
        maxBytes: 262144
      }
    }
  }
}

function pptxWriteResponse(title: unknown): unknown {
  return {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 7,
      slideId: '256',
      path: '/slide[@id=256]',
      index: 0,
      title,
      body: 'OMP PPTX 正文',
      previewConfirmed: true
    }
  }
}
function pptxSetResponse(slideId: unknown, elementId: unknown, text: unknown): unknown {
  return {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 8,
      slideId,
      elementId,
      path: `/slide[@id=${String(slideId)}]/shape[@id=${String(elementId)}]`,
      index: 0,
      kind: 'title',
      before: 'OMP PPTX 标题',
      after: text,
      previewConfirmed: true
    }
  }
}
function approvalDenied(): unknown {
  return { ok: false, error: { code: 'approval_denied', message: 'host detail must not escape' } }
}
function activeOfficeTools(agent: SdkAgent): ActiveTool[] {
  return agent.state.tools.filter((tool) =>
    ['office_read', 'office_apply', 'office_deliver'].includes(tool.name)
  )
}

async function smokePermissionMode(
  permissionMode: PermissionMode
): Promise<Record<string, unknown>> {
  const agentDir = mkdtempSync(join(rootDir, `${permissionMode}-`))
  const calls: Array<{ method: string; params: unknown; context?: unknown }> = []
  const askEventToolCallIds: string[] = []
  const tools = buildOfficeTools(
    async (method, params, context) => {
      calls.push({ method, params, context })
      return hostResponse(method, params)
    },
    { PHI_OFFICE_DEV: '1' }
  )
  const authStorage = await discoverAuthStorage(agentDir)
  const settings = await Settings.init({ cwd: agentDir, agentDir })
  const result = await createAgentSession({
    agentId: `phi-office-${permissionMode}-smoke`,
    agentDisplayName: 'Office Smoke',
    cwd: agentDir,
    agentDir,
    settings,
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
    sessionManager: SessionManager.inMemory(agentDir),
    customTools: tools,
    enableMCP: false,
    enableLsp: false,
    extensions: permissionMode === 'ask' ? [askModeProbe(askEventToolCallIds)] : []
  })
  try {
    await initializeExtensions(result.session, {
      reportSendError: () => undefined,
      reportRuntimeError: () => undefined
    })
    const agent = (result.session as unknown as { agent: SdkAgent }).agent
    return await exerciseOfficeTools(
      permissionMode,
      agent,
      activeOfficeTools(agent),
      calls,
      askEventToolCallIds
    )
  } finally {
    await result.session.dispose()
  }
}

async function exerciseOfficeTools(
  permissionMode: PermissionMode,
  agent: SdkAgent,
  activeTools: ActiveTool[],
  calls: Array<{ method: string; params: unknown; context?: unknown }>,
  askEventToolCallIds: string[]
): Promise<Record<string, unknown>> {
  const officeRead = activeTools.find((tool) => tool.name === 'office_read')
  const officeApply = activeTools.find((tool) => tool.name === 'office_apply')
  const officeDeliver = activeTools.find((tool) => tool.name === 'office_deliver')
  if (!officeRead || !officeApply || !officeDeliver) {
    throw new Error('SDK did not register all Office tools')
  }
  const spreadsheet = await exerciseSpreadsheetTools(permissionMode, agent, officeRead, officeApply)
  const docx = await exerciseDocxTools(permissionMode, agent, officeRead, officeApply)
  const pptx = await exercisePptxTools(permissionMode, agent, officeRead, officeApply)
  const deliver = await exerciseOfficeDeliverTool(permissionMode, agent, officeDeliver, calls)
  const applyCalls = calls.filter((call) => call.method === 'office.apply')
  return {
    permissionMode,
    names: activeTools.map((tool) => tool.name),
    ...spreadsheet,
    ...docx,
    ...pptx,
    ...deliver,
    ...toolCallEvidence(applyCalls),
    askEventToolCallIds
  }
}

async function exerciseSpreadsheetTools(
  permissionMode: PermissionMode,
  agent: SdkAgent,
  officeRead: ActiveTool,
  officeApply: ActiveTool
): Promise<Record<string, unknown>> {
  const read = await executeTool(agent, officeRead, `office-${permissionMode}-read`, {
    sheet: 'Sheet1',
    range: 'A1:B3',
    maxCells: 6
  })
  const applyInput = {
    operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: permissionMode },
    baseRevision: 3
  }
  const apply = await executeTool(agent, officeApply, `office-${permissionMode}-apply`, applyInput)
  const denied = await executeTool(agent, officeApply, `office-${permissionMode}-denied`, {
    ...applyInput,
    operation: { ...applyInput.operation, value: '拒绝样例' }
  })
  return { read, apply, denied }
}

async function exerciseDocxTools(
  permissionMode: PermissionMode,
  agent: SdkAgent,
  officeRead: ActiveTool,
  officeApply: ActiveTool
): Promise<Record<string, unknown>> {
  const docxRead = await executeTool(agent, officeRead, `office-${permissionMode}-docx-read`, {
    from: 0,
    limit: 10
  })
  const docxApplyInput = {
    operation: { type: 'add_paragraph', text: 'OMP 新段落', position: 'end' },
    baseRevision: 4
  }
  const docxApply = await executeTool(
    agent,
    officeApply,
    `office-${permissionMode}-docx-apply`,
    docxApplyInput
  )
  return { docxRead, docxApply }
}

function toolCallEvidence(
  applyCalls: Array<{ method: string; params: unknown; context?: unknown }>
): Record<string, unknown> {
  return {
    docxApplyParams: applyCalls[2]?.params,
    docxApplyContext: applyCalls[2]?.context,
    pptxApplyParams: applyCalls[3]?.params,
    pptxApplyContext: applyCalls[3]?.context,
    pptxSetParams: applyCalls[4]?.params,
    pptxSetContext: applyCalls[4]?.context,
    pptxDeniedContext: applyCalls[5]?.context,
    applyParams: applyCalls[0]?.params,
    applyContext: applyCalls[0]?.context,
    deniedContext: applyCalls[1]?.context
  }
}

async function exercisePptxTools(
  permissionMode: PermissionMode,
  agent: SdkAgent,
  officeRead: ActiveTool,
  officeApply: ActiveTool
): Promise<Record<string, unknown>> {
  const pptxRead = await executeTool(agent, officeRead, `office-${permissionMode}-pptx-read`, {
    from: 0,
    limit: 5
  })
  const input = {
    operation: {
      type: 'add_slide',
      title: 'OMP PPTX 新页面',
      body: 'OMP PPTX 正文',
      position: 'end'
    },
    baseRevision: 6
  }
  const pptxApply = await executeTool(
    agent,
    officeApply,
    `office-${permissionMode}-pptx-apply`,
    input
  )
  const pptxSet = await executeTool(agent, officeApply, `office-${permissionMode}-pptx-set`, {
    operation: {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: 'OMP PPTX 更新标题',
      expectedText: 'OMP PPTX 标题'
    },
    baseRevision: 7
  })
  const pptxDenied = await executeTool(agent, officeApply, `office-${permissionMode}-pptx-denied`, {
    ...input,
    operation: { ...input.operation, title: '拒绝样例' }
  })
  return { pptxRead, pptxApply, pptxSet, pptxDenied }
}

try {
  const modes = []
  for (const permissionMode of PERMISSION_MODES) {
    modes.push(await smokePermissionMode(permissionMode))
  }
  process.stdout.write(`${JSON.stringify({ modes })}\n`)
} finally {
  rmSync(rootDir, { recursive: true, force: true })
}
