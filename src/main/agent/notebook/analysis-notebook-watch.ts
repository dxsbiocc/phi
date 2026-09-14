import { existsSync, realpathSync, watch } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { openProjectNotebook, type AnalysisNotebookFile } from './analysis-notebook-files'

export type AnalysisNotebookFileChange =
  | {
      type: 'changed'
      projectCwd: string
      path: string
      relativePath: string
      file: AnalysisNotebookFile
    }
  | {
      type: 'deleted'
      projectCwd: string
      path: string
      relativePath: string
    }
  | {
      type: 'error'
      projectCwd: string
      path: string
      relativePath: string
      message: string
    }

type WatchedDirectory = {
  close: () => void
}

type WatchDirectory = (
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => WatchedDirectory

type OpenNotebook = (workingDirectory: string, notebookPath: string) => AnalysisNotebookFile

type Timer = ReturnType<typeof setTimeout>

type WatchRecord = {
  projectCwd: string
  path: string
  relativePath: string
  fileName: string
  directory: string
  lastRevision: string
  watcher: WatchedDirectory
  timer: Timer | null
}

export interface AnalysisNotebookFileWatcherOptions {
  onChange: (change: AnalysisNotebookFileChange) => void
  debounceMs?: number
  openNotebook?: OpenNotebook
  watchDirectory?: WatchDirectory
}

function displayPath(path: string): string {
  return path.split(sep).join('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isNotebookFilename(filename: string | Buffer | null, expectedName: string): boolean {
  if (filename === null) return true
  return filename.toString() === expectedName
}

function resolveNotebookPath(projectCwd: string, notebookPath: string): string {
  const absolutePath = isAbsolute(notebookPath)
    ? resolve(notebookPath)
    : resolve(projectCwd, notebookPath)
  try {
    return realpathSync(absolutePath)
  } catch {
    return absolutePath
  }
}

function fallbackRelativePath(projectCwd: string, notebookPath: string): string {
  const absolutePath = isAbsolute(notebookPath)
    ? resolve(notebookPath)
    : resolve(projectCwd, notebookPath)
  return displayPath(relative(projectCwd, absolutePath))
}

export class AnalysisNotebookFileWatcher {
  private readonly debounceMs: number
  private readonly onChange: (change: AnalysisNotebookFileChange) => void
  private readonly openNotebook: OpenNotebook
  private readonly watchDirectory: WatchDirectory
  private readonly records = new Map<string, WatchRecord>()

  constructor(options: AnalysisNotebookFileWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 120
    this.onChange = options.onChange
    this.openNotebook = options.openNotebook ?? openProjectNotebook
    this.watchDirectory =
      options.watchDirectory ??
      ((directory, listener) =>
        watch(directory, (eventType, filename) => listener(eventType, filename)))
  }

  watch(projectCwd: string, notebookPath: string): AnalysisNotebookFile {
    const file = this.openNotebook(projectCwd, notebookPath)
    this.watchFile(projectCwd, file)
    return file
  }

  watchFile(projectCwd: string, file: AnalysisNotebookFile): void {
    const existingKey = this.findRecordKey(projectCwd, file.path, file.relativePath)
    if (existingKey) {
      const record = this.records.get(existingKey)
      if (record) {
        record.path = file.path
        record.relativePath = file.relativePath
        record.lastRevision = file.savedRevision
      }
      return
    }

    const directory = dirname(file.path)
    const fileName = basename(file.path)
    const key = this.recordKey(projectCwd, file.path)
    const record: WatchRecord = {
      projectCwd,
      path: file.path,
      relativePath: file.relativePath,
      fileName,
      directory,
      lastRevision: file.savedRevision,
      watcher: this.watchDirectory(directory, (_eventType, filename) => {
        if (isNotebookFilename(filename, fileName)) {
          this.schedule(key)
        }
      }),
      timer: null
    }
    this.records.set(key, record)
  }

  noteLocalWrite(projectCwd: string, file: AnalysisNotebookFile): void {
    this.watchFile(projectCwd, file)
    const key = this.findRecordKey(projectCwd, file.path, file.relativePath)
    const record = key ? this.records.get(key) : null
    if (record) {
      record.lastRevision = file.savedRevision
    }
  }

  unwatch(projectCwd: string, notebookPath: string): void {
    const key = this.findRecordKey(
      projectCwd,
      resolveNotebookPath(projectCwd, notebookPath),
      fallbackRelativePath(projectCwd, notebookPath)
    )
    if (key) {
      this.closeRecord(key)
    }
  }

  unwatchFile(projectCwd: string, file: Pick<AnalysisNotebookFile, 'path' | 'relativePath'>): void {
    const key = this.findRecordKey(projectCwd, file.path, file.relativePath)
    if (key) {
      this.closeRecord(key)
    }
  }

  unwatchProject(projectCwd: string): void {
    for (const [key, record] of this.records) {
      if (record.projectCwd === projectCwd) {
        this.closeRecord(key)
      }
    }
  }

  dispose(): void {
    for (const key of Array.from(this.records.keys())) {
      this.closeRecord(key)
    }
  }

  private schedule(key: string): void {
    const record = this.records.get(key)
    if (!record) return
    if (record.timer) {
      clearTimeout(record.timer)
    }
    record.timer = setTimeout(() => {
      record.timer = null
      this.flush(key)
    }, this.debounceMs)
  }

  private flush(key: string): void {
    const record = this.records.get(key)
    if (!record) return

    if (!existsSync(record.path)) {
      this.onChange({
        type: 'deleted',
        projectCwd: record.projectCwd,
        path: record.path,
        relativePath: record.relativePath
      })
      this.closeRecord(key)
      return
    }

    let file: AnalysisNotebookFile
    try {
      file = this.openNotebook(record.projectCwd, record.path)
    } catch (error) {
      this.onChange({
        type: 'error',
        projectCwd: record.projectCwd,
        path: record.path,
        relativePath: record.relativePath,
        message: errorMessage(error)
      })
      return
    }

    if (file.savedRevision === record.lastRevision) return

    record.path = file.path
    record.relativePath = file.relativePath
    record.lastRevision = file.savedRevision
    this.onChange({
      type: 'changed',
      projectCwd: record.projectCwd,
      path: file.path,
      relativePath: file.relativePath,
      file
    })
  }

  private closeRecord(key: string): void {
    const record = this.records.get(key)
    if (!record) return
    if (record.timer) {
      clearTimeout(record.timer)
    }
    record.watcher.close()
    this.records.delete(key)
  }

  private findRecordKey(
    projectCwd: string,
    notebookPath: string,
    relativePath?: string
  ): string | null {
    const absolutePath = resolveNotebookPath(projectCwd, notebookPath)
    for (const [key, record] of this.records) {
      if (record.projectCwd !== projectCwd) continue
      if (
        record.path === absolutePath ||
        record.path === notebookPath ||
        record.relativePath === notebookPath ||
        (relativePath !== undefined && record.relativePath === relativePath)
      ) {
        return key
      }
    }
    return null
  }

  private recordKey(projectCwd: string, notebookPath: string): string {
    return `${projectCwd}\0${notebookPath}`
  }
}
