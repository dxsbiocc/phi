import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

import type { createLocalFileAccessControl } from './local-file-access-control'

const macFilenameExtensionTagClass = 'public.filename-extension'
const macContentTypesByExtension: Record<string, string[]> = {
  csv: ['public.comma-separated-values-text'],
  htm: ['public.html'],
  html: ['public.html'],
  key: ['com.apple.keynote.key'],
  numbers: ['com.apple.iwork.numbers.numbers'],
  pages: ['com.apple.iwork.pages.pages'],
  pdf: ['com.adobe.pdf', 'public.pdf'],
  ppt: ['com.microsoft.powerpoint.ppt'],
  pptx: ['org.openxmlformats.presentationml.presentation'],
  tsv: ['public.tab-separated-values-text'],
  xls: ['com.microsoft.excel.xls'],
  xlsx: ['org.openxmlformats.spreadsheetml.sheet'],
  doc: ['com.microsoft.word.doc'],
  docx: ['org.openxmlformats.wordprocessingml.document']
}
const macFallbackApplicationBundleIdByExtension: Record<string, string> = {
  avif: 'com.apple.preview',
  bmp: 'com.apple.preview',
  gif: 'com.apple.preview',
  heic: 'com.apple.preview',
  jpeg: 'com.apple.preview',
  jpg: 'com.apple.preview',
  pdf: 'com.apple.preview',
  png: 'com.apple.preview',
  tif: 'com.apple.preview',
  tiff: 'com.apple.preview',
  webp: 'com.apple.preview'
}
const macApplicationPathsByBundleId: Record<string, string[]> = {
  'com.apple.preview': ['/System/Applications/Preview.app', '/Applications/Preview.app'],
  'com.apple.textedit': ['/System/Applications/TextEdit.app', '/Applications/TextEdit.app'],
  'com.apple.iwork.keynote': ['/Applications/Keynote.app'],
  'com.apple.iwork.numbers': ['/Applications/Numbers.app'],
  'com.apple.iwork.pages': ['/Applications/Pages.app'],
  'com.google.chrome': ['/Applications/Google Chrome.app'],
  'com.microsoft.excel': ['/Applications/Microsoft Excel.app'],
  'com.microsoft.powerpoint': ['/Applications/Microsoft PowerPoint.app'],
  'com.microsoft.vscode': ['/Applications/Visual Studio Code.app'],
  'com.microsoft.word': ['/Applications/Microsoft Word.app']
}
const macApplicationPathQueries = new Map<string, Promise<string[]>>()

export type MacLaunchServicesHandler = {
  LSHandlerContentTag?: string
  LSHandlerContentTagClass?: string
  LSHandlerContentType?: string
  LSHandlerRoleAll?: string
  LSHandlerRoleViewer?: string
  LSHandlerRoleEditor?: string
}

export interface LocalFileIconsOptions {
  access: Pick<ReturnType<typeof createLocalFileAccessControl>, 'assertLocalFilePathAllowed'>
  getMacLaunchServicesHandlers: () => Promise<MacLaunchServicesHandler[]> | null
  setMacLaunchServicesHandlers: (handlers: Promise<MacLaunchServicesHandler[]>) => void
  getFileIcon: (path: string) => Promise<{
    isEmpty: () => boolean
    toDataURL: () => string
  }>
}

export function createLocalFileIcons(options: LocalFileIconsOptions): {
  getLocalFileIconDataUrl: (filePath: string) => Promise<string | null>
} {
  return new LocalFileIconResolver(options)
}

class LocalFileIconResolver {
  constructor(private readonly options: LocalFileIconsOptions) {}

  private readMacLaunchServicesHandlers(): Promise<MacLaunchServicesHandler[]> {
    const cachedHandlers = this.options.getMacLaunchServicesHandlers()
    if (cachedHandlers) return cachedHandlers

    const handlers = new Promise<MacLaunchServicesHandler[]>((resolveHandlers) => {
      execFile(
        '/usr/bin/plutil',
        [
          '-convert',
          'json',
          '-o',
          '-',
          join(
            homedir(),
            'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
          )
        ],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 1200 },
        (error, stdout) => {
          if (error) {
            resolveHandlers([])
            return
          }
          try {
            const data = JSON.parse(stdout) as { LSHandlers?: unknown }
            resolveHandlers(
              Array.isArray(data.LSHandlers) ? (data.LSHandlers as MacLaunchServicesHandler[]) : []
            )
          } catch {
            resolveHandlers([])
          }
        }
      )
    })
    this.options.setMacLaunchServicesHandlers(handlers)
    return handlers
  }

  private macDefaultApplicationBundleIdForExtension(
    handlers: MacLaunchServicesHandler[],
    extension: string
  ): string | null {
    const extensionHandler = handlers.find(
      (handler) =>
        handler.LSHandlerContentTagClass === macFilenameExtensionTagClass &&
        handler.LSHandlerContentTag?.toLowerCase() === extension
    )
    const extensionBundleId =
      extensionHandler?.LSHandlerRoleAll ??
      extensionHandler?.LSHandlerRoleViewer ??
      extensionHandler?.LSHandlerRoleEditor
    if (extensionBundleId) return extensionBundleId.toLowerCase()

    const contentTypes = macContentTypesByExtension[extension] ?? []
    const contentTypeHandler = handlers.find(
      (handler) =>
        typeof handler.LSHandlerContentType === 'string' &&
        contentTypes.includes(handler.LSHandlerContentType.toLowerCase())
    )
    const contentTypeBundleId =
      contentTypeHandler?.LSHandlerRoleAll ??
      contentTypeHandler?.LSHandlerRoleViewer ??
      contentTypeHandler?.LSHandlerRoleEditor
    if (contentTypeBundleId) return contentTypeBundleId.toLowerCase()

    return macFallbackApplicationBundleIdByExtension[extension] ?? null
  }

  private macApplicationPathsForBundleId(bundleId: string): string[] {
    return macApplicationPathsByBundleId[bundleId.toLowerCase()] ?? []
  }

  private quoteMacSpotlightQueryValue(value: string): string {
    return value.replace(/["\\]/g, '\\$&')
  }

  private readMacApplicationPathsForBundleId(bundleId: string): Promise<string[]> {
    const normalizedBundleId = bundleId.toLowerCase()
    const cached = macApplicationPathQueries.get(normalizedBundleId)
    if (cached) return cached

    const query = new Promise<string[]>((resolvePaths) => {
      execFile(
        '/usr/bin/mdfind',
        [`kMDItemCFBundleIdentifier == "${this.quoteMacSpotlightQueryValue(bundleId)}"`],
        { encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 1200 },
        (error, stdout) => {
          if (error) {
            resolvePaths([])
            return
          }
          resolvePaths(
            stdout
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          )
        }
      )
    })
    macApplicationPathQueries.set(normalizedBundleId, query)
    return query
  }

  private async getNativeIconDataUrl(path: string): Promise<string | null> {
    const icon = await this.options.getFileIcon(path)
    return icon.isEmpty() ? null : icon.toDataURL()
  }

  private async getMacApplicationIconDataUrl(bundleId: string): Promise<string | null> {
    const applicationPaths = [
      ...(await this.readMacApplicationPathsForBundleId(bundleId)),
      ...this.macApplicationPathsForBundleId(bundleId)
    ]
    const visitedPaths = new Set<string>()

    for (const applicationPath of applicationPaths) {
      if (visitedPaths.has(applicationPath)) continue
      visitedPaths.add(applicationPath)
      try {
        const icon = await this.getNativeIconDataUrl(applicationPath)
        if (icon) return icon
      } catch {
        continue
      }
    }

    return null
  }

  private async getMacDefaultApplicationIconDataUrl(filePath: string): Promise<string | null> {
    if (process.platform !== 'darwin') return null

    const extension = extname(filePath).slice(1).toLowerCase()
    if (!extension) return null

    const bundleId = this.macDefaultApplicationBundleIdForExtension(
      await this.readMacLaunchServicesHandlers(),
      extension
    )
    return bundleId ? this.getMacApplicationIconDataUrl(bundleId) : null
  }

  async getLocalFileIconDataUrl(filePath: string): Promise<string | null> {
    const target = this.options.access.assertLocalFilePathAllowed(filePath, '读取图标', {
      resolveSymlinks: true
    })
    try {
      const defaultApplicationIcon = await this.getMacDefaultApplicationIconDataUrl(target)
      if (defaultApplicationIcon) return defaultApplicationIcon
      return this.getNativeIconDataUrl(target)
    } catch {
      return null
    }
  }
}
