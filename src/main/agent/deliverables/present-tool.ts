import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../shared/presentedFileTypes'

export type PresentFilesRequest = {
  runtimeSessionId: string
  toolCallId: string
  files: unknown
}

export function buildPresentFilesTool(
  runtimeSessionId: string,
  deliver: (request: PresentFilesRequest) => Promise<{ files: PresentedFile[] }>
): CustomTool {
  return {
    name: 'present_files',
    label: 'Present Files',
    description:
      'Declare the most important existing local result files as final deliverables for the user. Use this for separate reports, figures, notebooks, or data tables, usually 1–2 files and at most 4. Files must already exist inside this conversation’s workspace. This records links to the current files; it does not copy or upload their contents. Do not call it for ordinary code edits already shown in the file-change summary.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PRESENTED_FILES,
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: {
                type: 'string',
                description: 'Existing workspace-relative or absolute file path.'
              },
              description: { type: 'string', description: 'Short description shown to the user.' }
            }
          }
        }
      }
    },
    approval: 'read',
    async execute(toolCallId, params) {
      try {
        const record =
          params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
        const result = await deliver({ runtimeSessionId, toolCallId, files: record.files })
        if (!Array.isArray(result.files)) throw new Error('File delivery returned no files')
        return {
          content: [
            {
              type: 'text',
              text: result.files.map((file) => `Presented ${file.displayPath}`).join('\n')
            }
          ],
          details: { kind: 'presented_files', files: result.files }
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
