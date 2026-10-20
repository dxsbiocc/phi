import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { readAppSettings } from './agent/app-settings'
import {
  isLocalFilePathAllowedByRoots,
  isPathInsideRoot,
  localFileAllowRoots
} from './agent/local-file-access'
import { isPluginSkillPreviewPath } from './agent/plugins/preview'
import {
  assertProjectPathAvailable,
  getProjectByCwd,
  listLocalProjectAllowRoots
} from './agent/projects'
import { isRemoteProjectAnchorPath } from './agent/remote-project-anchor'
import { getCoreAuthoringSkillDir } from './agent/runtime/runtime-adapter'

const LOCAL_PATH_STAT_LIMIT = 128
const DIRECTORY_ENTRY_LIMIT = 400

export type LocalPathScope = {
  cwd: string
  cwdRealPath?: string
}

type LocalPathStatPayload = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

export interface LocalFileAccessControlOptions {
  agentDir: string
  getCurrentCwd: () => string
}

export function createLocalFileAccessControl(options: LocalFileAccessControlOptions): {
  assertLocalFilePathAllowed: (
    filePath: string,
    actionLabel: string,
    request?: { resolveSymlinks?: boolean; projectRoots?: readonly string[] }
  ) => string
  assertFileHoverPreviewPathAllowed: (filePath: string) => string
  assertRevealPathAllowed: (filePath: string) => string
  getLocalPathScope: (
    target: string,
    projectRoots?: readonly string[]
  ) => { rootPath: string; rootLabel: string; displayPath: string } | null
  statLocalPaths: (cwd: unknown, paths: unknown) => LocalPathStatPayload[]
  createDirectoryListing: (dirPath: string) => {
    path: string
    name: string
    displayPath: string
    rootPath: string
    rootLabel: string
    entries: Array<{
      path: string
      name: string
      displayPath: string
      kind: 'directory' | 'file'
    }>
    truncated: boolean
  }
} {
  return new LocalFileAccessController(options)
}

class LocalFileAccessController {
  constructor(private readonly options: LocalFileAccessControlOptions) {}

  private currentLocalPathScope(): LocalPathScope {
    const currentCwd = this.options.getCurrentCwd()
    const project = getProjectByCwd(currentCwd)
    return {
      cwd: currentCwd,
      ...(project?.workingDirectoryRealPath
        ? { cwdRealPath: project.workingDirectoryRealPath }
        : {})
    }
  }

  private isCoreAuthoringSkillResourcePath(target: string): boolean {
    try {
      return isPathInsideRoot(realpathSync(getCoreAuthoringSkillDir()), target)
    } catch {
      return false
    }
  }

  private isLocalFilePathAllowed(
    target: string,
    scope: LocalPathScope = this.currentLocalPathScope(),
    projectRoots: readonly string[] = []
  ): boolean {
    if (isRemoteProjectAnchorPath(target, this.options.agentDir)) return false
    if (this.isCoreAuthoringSkillResourcePath(target)) return true
    if (isPluginSkillPreviewPath(target)) return true
    return isLocalFilePathAllowedByRoots(
      target,
      localFileAllowRoots({
        agentDir: resolve(this.options.agentDir),
        sessionCwd: scope.cwd,
        sessionCwdRealPath: scope.cwdRealPath,
        projectRoots
      })
    )
  }

  private scopeForRoot(
    root: string,
    target: string
  ): { rootPath: string; rootLabel: string; displayPath: string } | null {
    const rootPath = resolve(root)
    if (!isPathInsideRoot(rootPath, target)) return null
    const relativePath = relative(rootPath, target)
    return {
      rootPath,
      rootLabel: basename(rootPath) || rootPath,
      displayPath: relativePath || basename(target)
    }
  }

  getLocalPathScope(
    target: string,
    projectRoots: readonly string[] = []
  ): { rootPath: string; rootLabel: string; displayPath: string } | null {
    if (isRemoteProjectAnchorPath(target, this.options.agentDir)) return null
    const currentCwd = this.options.getCurrentCwd()
    const cwdScope = this.scopeForRoot(currentCwd, target)
    if (cwdScope) return cwdScope

    const projectScope = projectRoots
      .map((root) => this.scopeForRoot(root, target))
      .filter((scope): scope is NonNullable<typeof scope> => scope !== null)
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]
    if (projectScope) return projectScope

    const agentDir = resolve(this.options.agentDir)
    const relativeAgentPath = relative(agentDir, target)
    if (!relativeAgentPath.startsWith('..') && !isAbsolute(relativeAgentPath)) {
      return {
        rootPath: agentDir,
        rootLabel: 'Phi',
        displayPath: join('Phi', relativeAgentPath || basename(target))
      }
    }

    return null
  }

  assertLocalFilePathAllowed(
    filePath: string,
    actionLabel: string,
    request: { resolveSymlinks?: boolean; projectRoots?: readonly string[] } = {}
  ): string {
    if (!isAbsolute(filePath)) {
      throw new Error(`只能${actionLabel}绝对路径`)
    }
    const projectRoots = request.projectRoots ?? listLocalProjectAllowRoots()
    const scope = this.currentLocalPathScope()
    const target = resolve(filePath)
    if (!this.isLocalFilePathAllowed(target, scope, projectRoots)) {
      throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
    }
    const inspectedTarget = request.resolveSymlinks ? realpathSync(target) : target
    if (
      !this.isLocalFilePathAllowed(inspectedTarget, scope, projectRoots) ||
      (existsSync(inspectedTarget) &&
        isRemoteProjectAnchorPath(realpathSync(inspectedTarget), this.options.agentDir))
    ) {
      throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
    }
    return inspectedTarget
  }

  assertFileHoverPreviewPathAllowed(filePath: string): string {
    if (!readAppSettings().allowExternalFileRead) {
      try {
        return this.assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
      } catch (error) {
        if (
          isAbsolute(filePath) &&
          error instanceof Error &&
          error.message.includes('Phi 保存的文件或当前项目内的文件')
        ) {
          throw new Error(
            '此文件位于当前项目之外。请前往“设置 → 通用”，开启“允许读取项目外文件”后重试。'
          )
        }
        throw error
      }
    }

    if (!isAbsolute(filePath)) {
      throw new Error('只能预览绝对路径')
    }
    const target = resolve(filePath)
    if (isRemoteProjectAnchorPath(target, this.options.agentDir)) {
      throw new Error('远程项目文件不支持本地悬停预览')
    }
    const inspectedTarget = realpathSync(target)
    if (isRemoteProjectAnchorPath(inspectedTarget, this.options.agentDir)) {
      throw new Error('远程项目文件不支持本地悬停预览')
    }
    return inspectedTarget
  }

  assertRevealPathAllowed(filePath: string): string {
    return this.assertLocalFilePathAllowed(filePath, '显示')
  }

  private localPathStatScope(cwd: unknown, allowExternalFileRead: boolean): LocalPathScope | null {
    const currentCwd = this.options.getCurrentCwd()
    const rawCwd = typeof cwd === 'string' && cwd.trim() ? cwd : currentCwd
    if (isRemoteProjectAnchorPath(rawCwd, this.options.agentDir)) return null
    const requestedCwd = resolve(rawCwd)
    if (requestedCwd === resolve(currentCwd)) return this.currentLocalPathScope()

    const project = getProjectByCwd(rawCwd)
    if (!project) {
      return allowExternalFileRead ? { cwd: requestedCwd } : null
    }

    try {
      assertProjectPathAvailable(project.workingDirectory)
    } catch {
      return null
    }

    return {
      cwd: project.workingDirectory,
      cwdRealPath: project.workingDirectoryRealPath
    }
  }

  private missingLocalPathStats(paths: string[]): LocalPathStatPayload[] {
    return paths.map((path) => ({ path, kind: 'missing' as const }))
  }

  private statLocalPath(
    filePath: string,
    scope: LocalPathScope,
    allowExternalFileRead: boolean
  ): LocalPathStatPayload {
    const missing = { path: filePath, kind: 'missing' as const }
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return missing

    const target = resolve(filePath)
    if (isRemoteProjectAnchorPath(target, this.options.agentDir)) return missing
    if (!allowExternalFileRead && !this.isLocalFilePathAllowed(target, scope)) return missing

    try {
      const realTarget = realpathSync(target)
      if (isRemoteProjectAnchorPath(realTarget, this.options.agentDir)) return missing
      if (!allowExternalFileRead && !this.isLocalFilePathAllowed(realTarget, scope)) return missing

      const stats = statSync(realTarget)
      if (stats.isDirectory()) return { path: target, kind: 'directory' }
      if (stats.isFile()) return { path: target, kind: 'file' }
    } catch {
      return missing
    }

    return missing
  }

  statLocalPaths(cwd: unknown, paths: unknown): LocalPathStatPayload[] {
    if (!Array.isArray(paths)) return []

    const uniquePaths = [
      ...new Set(paths.filter((path): path is string => typeof path === 'string'))
    ]
    const limitedPaths = uniquePaths.slice(0, LOCAL_PATH_STAT_LIMIT)
    const allowExternalFileRead = readAppSettings().allowExternalFileRead
    const scope = this.localPathStatScope(cwd, allowExternalFileRead)
    if (!scope) return this.missingLocalPathStats(limitedPaths)

    return limitedPaths.map((path) => this.statLocalPath(path, scope, allowExternalFileRead))
  }

  createDirectoryListing(dirPath: string): {
    path: string
    name: string
    displayPath: string
    rootPath: string
    rootLabel: string
    entries: Array<{
      path: string
      name: string
      displayPath: string
      kind: 'directory' | 'file'
    }>
    truncated: boolean
  } {
    const projectRoots = listLocalProjectAllowRoots()
    const pathScope = this.currentLocalPathScope()
    const target = this.assertLocalFilePathAllowed(dirPath, '列出', {
      resolveSymlinks: true,
      projectRoots
    })
    const stats = statSync(target)
    if (!stats.isDirectory()) {
      throw new Error('只能列出文件夹内容')
    }

    const entries = readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(target, entry.name)
      let realEntryPath = entryPath
      try {
        realEntryPath = realpathSync(entryPath)
        if (!this.isLocalFilePathAllowed(realEntryPath, pathScope, projectRoots)) return []
        const entryStats = statSync(realEntryPath)
        if (!entryStats.isDirectory() && !entryStats.isFile()) return []
        const scope = this.getLocalPathScope(entryPath, projectRoots)
        return [
          {
            path: entryPath,
            name: entry.name,
            displayPath: scope?.displayPath ?? entry.name,
            kind: entryStats.isDirectory() ? ('directory' as const) : ('file' as const)
          }
        ]
      } catch {
        return []
      }
    })
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    const scope = this.getLocalPathScope(target, projectRoots)
    return {
      path: target,
      name: basename(target) || target,
      displayPath: scope?.displayPath ?? basename(target),
      rootPath: scope?.rootPath ?? target,
      rootLabel: scope?.rootLabel ?? basename(target),
      entries: entries.slice(0, DIRECTORY_ENTRY_LIMIT),
      truncated: entries.length > DIRECTORY_ENTRY_LIMIT
    }
  }
}
