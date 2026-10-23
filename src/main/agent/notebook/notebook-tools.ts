import type { PhiTool, PhiToolContext } from '../engine/types'
import { NOTEBOOK_TOOL_DESCRIPTIONS } from '../engine/phi-extension'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'
export { NOTEBOOK_TOOL_DESCRIPTIONS } from '../engine/phi-extension'

export type NotebookToolAction =
  'list' | 'read' | 'insert_cell' | 'update_cell' | 'delete_cell' | 'run_cell' | 'save'

export const NOTEBOOK_TOOL_NAMES = [
  'notebook_list',
  'notebook_read',
  'notebook_insert_cell',
  'notebook_update_cell',
  'notebook_delete_cell',
  'notebook_run_cell',
  'notebook_save'
] as const

export type NotebookToolName = (typeof NOTEBOOK_TOOL_NAMES)[number]

export type NotebookRemoteProjectIdentity = {
  runtimeSessionId: string
  sessionId: string
  projectId: string
}

export type NotebookToolRequest = {
  action: NotebookToolAction
  cwd: string
  params: Record<string, unknown>
  remoteProject?: NotebookRemoteProjectIdentity
}

/** Main-only ownership; never serialized into the host-tool request. */
export type NotebookToolDispatchControl = {
  signal?: AbortSignal
  beforeDispatch?: () => void
  /**
   * Asks the user once before the agent starts a remote Jupyter server on their behalf.
   * Resolves false when the user denies; rejects when the run is cancelled.
   */
  approveRemoteJupyterStart?: (info: RemoteJupyterStartApprovalInfo) => Promise<boolean>
}

export type RemoteJupyterStartApprovalInfo = { serverLabel: string; projectName: string }

export type NotebookToolHostExecutor = (
  request: NotebookToolRequest,
  control?: NotebookToolDispatchControl
) => Promise<unknown>

export type NotebookToolBuildOptions = {
  remoteProject?: NotebookRemoteProjectIdentity
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function resultText(result: unknown): string {
  if (isRecord(result) && typeof result.summary === 'string') return result.summary
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

function resultDetails(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { result }
}

function buildNotebookTool(
  action: NotebookToolAction,
  definition: Omit<PhiTool, 'execute' | 'site'>,
  executeHost: NotebookToolHostExecutor,
  options: NotebookToolBuildOptions
): PhiTool {
  return {
    ...definition,
    site: 'host',
    // Core research tools: keep them in the model's tool list instead of behind xd://.
    loadMode: 'essential',
    async execute(_toolCallId, params, _onUpdate, ctx: PhiToolContext) {
      try {
        const result = await executeHost({
          action,
          cwd: ctx.cwd,
          params: recordValue(params),
          ...(options.remoteProject ? { remoteProject: options.remoteProject } : {})
        })
        return {
          content: [{ type: 'text', text: resultText(result) }],
          details: resultDetails(result)
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: errorMessage(error) }],
          isError: true
        }
      }
    }
  }
}

export function buildNotebookCustomTools(
  executeHost: NotebookToolHostExecutor,
  options: NotebookToolBuildOptions = {}
): PhiTool[] {
  return [
    buildNotebookTool(
      'list',
      {
        name: 'notebook_list',
        label: 'List Notebooks',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_list')!,
        parameters: {
          type: 'object',
          properties: {}
        },
        approval: 'read'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'read',
      {
        name: 'notebook_read',
        label: 'Read Notebook',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_read')!,
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative or absolute path to a .ipynb notebook.'
            },
            includeOutputs: {
              type: 'boolean',
              description: 'Include output summaries for cells. Defaults to true.'
            }
          }
        },
        approval: 'read'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'insert_cell',
      {
        name: 'notebook_insert_cell',
        label: 'Insert Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_insert_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'source'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            source: { type: 'string', description: 'Cell source content.' },
            cellType: {
              type: 'string',
              enum: ['code', 'markdown', 'raw'],
              description: 'Cell type. Defaults to code.'
            },
            cellNumber: {
              type: 'number',
              description:
                'One-based insertion position. 1 inserts before the first cell; N inserts before Cell N; values after the last cell append. Defaults to the end of the notebook.'
            },
            afterCellId: {
              type: 'string',
              description: 'Insert after this cell id. Takes precedence over cellNumber.'
            },
            beforeCellId: {
              type: 'string',
              description: 'Insert before this cell id. Takes precedence over cellNumber.'
            }
          }
        },
        approval: 'write'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'update_cell',
      {
        name: 'notebook_update_cell',
        label: 'Update Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_update_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId', 'source'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target cell id from notebook_read. Do not use the one-based Cell N label here.'
            },
            source: { type: 'string', description: 'Replacement cell source.' },
            cellType: {
              type: 'string',
              enum: ['code', 'markdown', 'raw'],
              description: 'Optional replacement cell type.'
            }
          }
        },
        approval: 'write'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'delete_cell',
      {
        name: 'notebook_delete_cell',
        label: 'Delete Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_delete_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target cell id from notebook_read. Do not use the one-based Cell N label here.'
            }
          }
        },
        approval: 'write'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'run_cell',
      {
        name: 'notebook_run_cell',
        label: 'Run Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_run_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target code cell id from notebook_read. Do not use the one-based Cell N label here.'
            }
          }
        },
        approval: 'write'
      },
      executeHost,
      options
    ),
    buildNotebookTool(
      'save',
      {
        name: 'notebook_save',
        label: 'Save Notebook',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook_save')!,
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' }
          }
        },
        approval: 'write'
      },
      executeHost,
      options
    )
  ]
}
