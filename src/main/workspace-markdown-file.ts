import { extname } from 'node:path'

import type {
  WorkspaceMarkdownSaveRequest,
  WorkspaceMarkdownSaveResult
} from '../shared/workspaceFileOperations'
import {
  saveWorkspaceTextFile,
  validateWorkspaceTextSaveRequest,
  type WorkspaceTextFileDependencies
} from './workspace-text-file'

export type WorkspaceMarkdownFileDependencies = WorkspaceTextFileDependencies

export function validateWorkspaceMarkdownSaveRequest(input: unknown): WorkspaceMarkdownSaveRequest {
  const request = validateWorkspaceTextSaveRequest(input)
  if (!['.md', '.markdown', '.mdown'].includes(extname(request.path).toLowerCase())) {
    throw new Error('只能保存 .md、.markdown 或 .mdown 文件')
  }
  return request
}

export async function saveWorkspaceMarkdownFile(
  input: unknown,
  dependencies: WorkspaceMarkdownFileDependencies = {}
): Promise<WorkspaceMarkdownSaveResult> {
  return saveWorkspaceTextFile(validateWorkspaceMarkdownSaveRequest(input), dependencies)
}
