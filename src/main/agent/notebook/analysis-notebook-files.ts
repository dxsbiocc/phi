import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  parseNotebook,
  serializeNotebook,
  type NotebookDocument
} from '../../../shared/notebookDocument'

export interface AnalysisNotebookFile {
  path: string
  relativePath: string
  name: string
  bytes: number
  modifiedAt: string
  savedRevision: string
  document: NotebookDocument
}

export interface SaveProjectNotebookInput {
  path: string
  document: NotebookDocument
  expectedRevision?: string
}

export interface DeleteProjectNotebookResult {
  path: string
  relativePath: string
}

function displayPath(path: string): string {
  return path.split(sep).join('/')
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function projectRoot(workingDirectory: string): string {
  const root = realpathSync(workingDirectory)
  if (!statSync(root).isDirectory()) {
    throw new Error('项目路径不可用')
  }
  return root
}

function assertNotebookExtension(target: string): void {
  if (!target.toLocaleLowerCase().endsWith('.ipynb')) {
    throw new Error('只能操作 .ipynb notebook')
  }
}

function resolveExistingNotebookPath(
  workingDirectory: string,
  notebookPath: string
): {
  root: string
  target: string
} {
  const root = projectRoot(workingDirectory)
  const requested = isAbsolute(notebookPath) ? resolve(notebookPath) : resolve(root, notebookPath)
  assertNotebookExtension(requested)
  if (!isInsideRoot(root, requested)) {
    throw new Error('只能操作当前项目内的 notebook')
  }

  const target = realpathSync(requested)
  if (!isInsideRoot(root, target)) {
    throw new Error('只能操作当前项目内的 notebook')
  }
  if (!statSync(target).isFile()) {
    throw new Error('Notebook 文件不可用')
  }
  return { root, target }
}

function resolveWritableNotebookPath(
  workingDirectory: string,
  notebookPath: string
): {
  root: string
  target: string
} {
  const root = projectRoot(workingDirectory)
  const requested = isAbsolute(notebookPath) ? resolve(notebookPath) : resolve(root, notebookPath)
  assertNotebookExtension(requested)
  if (!isInsideRoot(root, requested)) {
    throw new Error('只能保存当前项目内的 notebook')
  }
  if (existsSync(requested)) {
    return resolveExistingNotebookPath(root, requested)
  }

  const parent = realpathSync(dirname(requested))
  if (!isInsideRoot(root, parent)) {
    throw new Error('只能保存当前项目内的 notebook')
  }
  return { root, target: requested }
}

function notebookPayload(
  root: string,
  target: string,
  document: NotebookDocument
): AnalysisNotebookFile {
  const stats = statSync(target)
  return {
    path: target,
    relativePath: displayPath(relative(root, target)),
    name: basename(target),
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    savedRevision: document.revision,
    document
  }
}

function readNotebookDocument(target: string): NotebookDocument {
  const text = readFileSync(target, 'utf-8')
  return parseNotebook(JSON.parse(text))
}

function writeNotebookDocument(target: string, document: NotebookDocument): void {
  const body = serializeNotebook(document)
  writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf-8')
}

function createEmptyNotebookDocument(): NotebookDocument {
  return parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        name: 'python'
      },
      phi: {
        created_by: 'Phi analysis workbench'
      }
    },
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Untitled analysis\n']
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: []
      }
    ]
  })
}

function uniqueNotebookPath(root: string, requestedRelativePath?: string): string {
  if (requestedRelativePath) {
    if (isAbsolute(requestedRelativePath)) {
      throw new Error('新建 notebook 只能使用项目内相对路径')
    }
    const requested = resolve(root, requestedRelativePath)
    assertNotebookExtension(requested)
    if (!isInsideRoot(root, requested)) {
      throw new Error('只能在当前项目内新建 notebook')
    }
    if (existsSync(requested)) {
      throw new Error('Notebook 已存在')
    }
    return requested
  }

  const directory = join(root, 'notebooks')
  let index = 1
  while (true) {
    const name = index === 1 ? 'Untitled.ipynb' : `Untitled ${index}.ipynb`
    const candidate = join(directory, name)
    if (!existsSync(candidate)) return candidate
    index += 1
  }
}

export function openProjectNotebook(
  workingDirectory: string,
  notebookPath: string
): AnalysisNotebookFile {
  const { root, target } = resolveExistingNotebookPath(workingDirectory, notebookPath)
  return notebookPayload(root, target, readNotebookDocument(target))
}

export function saveProjectNotebook(
  workingDirectory: string,
  input: SaveProjectNotebookInput
): AnalysisNotebookFile {
  const { root, target } = resolveWritableNotebookPath(workingDirectory, input.path)
  if (input.expectedRevision && existsSync(target)) {
    const current = readNotebookDocument(target)
    if (current.revision !== input.expectedRevision) {
      throw new Error('Notebook 已在磁盘上变化，请重新打开后再保存')
    }
  }

  writeNotebookDocument(target, input.document)
  return notebookPayload(root, target, readNotebookDocument(target))
}

export function createProjectNotebook(
  workingDirectory: string,
  requestedRelativePath?: string
): AnalysisNotebookFile {
  const root = projectRoot(workingDirectory)
  const target = uniqueNotebookPath(root, requestedRelativePath)
  mkdirSync(dirname(target), { recursive: true })
  const parent = realpathSync(dirname(target))
  if (!isInsideRoot(root, parent)) {
    throw new Error('只能在当前项目内新建 notebook')
  }
  writeNotebookDocument(target, createEmptyNotebookDocument())
  return notebookPayload(root, target, readNotebookDocument(target))
}

export function closeProjectNotebook(
  workingDirectory: string,
  notebookPath: string
): { path: string } {
  const { target } = resolveExistingNotebookPath(workingDirectory, notebookPath)
  return { path: target }
}

export function deleteProjectNotebook(
  workingDirectory: string,
  notebookPath: string
): DeleteProjectNotebookResult {
  const { root, target } = resolveExistingNotebookPath(workingDirectory, notebookPath)
  const relativePath = displayPath(relative(root, target))
  unlinkSync(target)
  return { path: target, relativePath }
}
