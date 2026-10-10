import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'

export type NotebookToolAction =
  'list' | 'read' | 'insert_cell' | 'update_cell' | 'delete_cell' | 'run_cell' | 'save'

export const NOTEBOOK_TOOL_NAMES = [
  'notebook.list',
  'notebook.read',
  'notebook.insert_cell',
  'notebook.update_cell',
  'notebook.delete_cell',
  'notebook.run_cell',
  'notebook.save'
] as const

export type NotebookToolName = (typeof NOTEBOOK_TOOL_NAMES)[number]

export const NOTEBOOK_TOOL_DESCRIPTIONS: ReadonlyMap<string, string> = new Map<
  NotebookToolName,
  string
>([
  [
    'notebook.list',
    'List .ipynb notebooks in the current project or ordinary workspace. Use this before opening or modifying a notebook when the path is unknown.'
  ],
  [
    'notebook.read',
    'Read the current in-memory notebook draft for a workspace notebook. Opens the notebook into the live agent workspace on first use. Cell summaries use one-based cellNumber values for human-facing order; use the stable id field as cellId when editing, deleting, or running a cell.'
  ],
  [
    'notebook.insert_cell',
    'Insert a code, markdown, or raw cell into the live in-memory notebook draft. This does not save to disk until notebook.save is called.'
  ],
  [
    'notebook.update_cell',
    'Replace the source and optionally type of an existing cell in the live in-memory notebook draft. This does not save to disk until notebook.save is called.'
  ],
  [
    'notebook.delete_cell',
    'Delete a cell from the live in-memory notebook draft. This does not save to disk until notebook.save is called.'
  ],
  [
    'notebook.run_cell',
    'Run one code cell through the Phi app-managed Jupyter server for the current project or ordinary workspace and update the live in-memory notebook draft with execution count, outputs, and duration metadata. Do not assume localhost:8888 or ask the user to restart an external JupyterLab; the host app starts or attaches the correct workspace server.'
  ],
  [
    'notebook.save',
    'Save the live in-memory notebook draft back to its .ipynb file. Use after notebook edits that should persist in the workspace.'
  ]
])

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

export type NotebookToolHostExecutor = (request: NotebookToolRequest) => Promise<unknown>

export type NotebookToolBuildOptions = {
  remoteProject?: NotebookRemoteProjectIdentity
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  definition: Omit<CustomTool, 'execute'>,
  executeHost: NotebookToolHostExecutor,
  options: NotebookToolBuildOptions
): CustomTool {
  return {
    ...definition,
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      try {
        const result = await executeHost({
          action,
          cwd: ctx.sessionManager.getCwd(),
          params: recordValue(params),
          ...(options.remoteProject ? { remoteProject: options.remoteProject } : {})
        })
        return {
          content: [{ type: 'text', text: resultText(result) }],
          details: resultDetails(result)
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      }
    }
  }
}

export function buildNotebookCustomTools(
  executeHost: NotebookToolHostExecutor,
  options: NotebookToolBuildOptions = {}
): CustomTool[] {
  return [
    buildNotebookTool(
      'list',
      {
        name: 'notebook.list',
        label: 'List Notebooks',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.list')!,
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
        name: 'notebook.read',
        label: 'Read Notebook',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.read')!,
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
        name: 'notebook.insert_cell',
        label: 'Insert Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.insert_cell')!,
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
        name: 'notebook.update_cell',
        label: 'Update Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.update_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId', 'source'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target cell id from notebook.read. Do not use the one-based Cell N label here.'
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
        name: 'notebook.delete_cell',
        label: 'Delete Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.delete_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target cell id from notebook.read. Do not use the one-based Cell N label here.'
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
        name: 'notebook.run_cell',
        label: 'Run Notebook Cell',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.run_cell')!,
        parameters: {
          type: 'object',
          required: ['path', 'cellId'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' },
            cellId: {
              type: 'string',
              description:
                'Stable target code cell id from notebook.read. Do not use the one-based Cell N label here.'
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
        name: 'notebook.save',
        label: 'Save Notebook',
        description: NOTEBOOK_TOOL_DESCRIPTIONS.get('notebook.save')!,
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
