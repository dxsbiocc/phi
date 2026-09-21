import type { CustomTool, CustomToolContext } from '@oh-my-pi/pi-coding-agent'

export type NotebookToolAction =
  'list' | 'read' | 'insert_cell' | 'update_cell' | 'delete_cell' | 'run_cell' | 'save'

export type NotebookToolRequest = {
  action: NotebookToolAction
  cwd: string
  params: Record<string, unknown>
}

export type NotebookToolHostExecutor = (request: NotebookToolRequest) => Promise<unknown>

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
  executeHost: NotebookToolHostExecutor
): CustomTool {
  return {
    ...definition,
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      try {
        const result = await executeHost({
          action,
          cwd: ctx.sessionManager.getCwd(),
          params: recordValue(params)
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

export function buildNotebookCustomTools(executeHost: NotebookToolHostExecutor): CustomTool[] {
  return [
    buildNotebookTool(
      'list',
      {
        name: 'notebook.list',
        label: 'List Notebooks',
        description:
          'List .ipynb notebooks in the current project or ordinary workspace. Use this before opening or modifying a notebook when the path is unknown.',
        parameters: {
          type: 'object',
          properties: {}
        },
        approval: 'read'
      },
      executeHost
    ),
    buildNotebookTool(
      'read',
      {
        name: 'notebook.read',
        label: 'Read Notebook',
        description:
          'Read the current in-memory notebook draft for a workspace notebook. Opens the notebook into the live agent workspace on first use. Cell summaries use one-based cellNumber values for human-facing order; use the stable id field as cellId when editing, deleting, or running a cell.',
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
      executeHost
    ),
    buildNotebookTool(
      'insert_cell',
      {
        name: 'notebook.insert_cell',
        label: 'Insert Notebook Cell',
        description:
          'Insert a code, markdown, or raw cell into the live in-memory notebook draft. This does not save to disk until notebook.save is called.',
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
      executeHost
    ),
    buildNotebookTool(
      'update_cell',
      {
        name: 'notebook.update_cell',
        label: 'Update Notebook Cell',
        description:
          'Replace the source and optionally type of an existing cell in the live in-memory notebook draft. This does not save to disk until notebook.save is called.',
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
      executeHost
    ),
    buildNotebookTool(
      'delete_cell',
      {
        name: 'notebook.delete_cell',
        label: 'Delete Notebook Cell',
        description:
          'Delete a cell from the live in-memory notebook draft. This does not save to disk until notebook.save is called.',
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
      executeHost
    ),
    buildNotebookTool(
      'run_cell',
      {
        name: 'notebook.run_cell',
        label: 'Run Notebook Cell',
        description:
          'Run one code cell through the Phi app-managed Jupyter server for the current project or ordinary workspace and update the live in-memory notebook draft with execution count, outputs, and duration metadata. Do not assume localhost:8888 or ask the user to restart an external JupyterLab; the host app starts or attaches the correct workspace server.',
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
      executeHost
    ),
    buildNotebookTool(
      'save',
      {
        name: 'notebook.save',
        label: 'Save Notebook',
        description:
          'Save the live in-memory notebook draft back to its .ipynb file. Use after notebook edits that should persist in the workspace.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute notebook path.' }
          }
        },
        approval: 'write'
      },
      executeHost
    )
  ]
}
