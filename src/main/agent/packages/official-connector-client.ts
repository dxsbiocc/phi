import semver from 'semver'
import { stringify as stringifyYaml } from 'yaml'

import { readBoundedResponse } from './github-source'
import { PACKAGE_ICON_FILENAMES } from './icon-assets'
import { isRecord } from './installer-utils'
import {
  CONNECTOR_CATEGORIES,
  parsePackageManifestText,
  type HttpConnectorManifest,
  type McpPackageManifest
} from './manifest'

export const OFFICIAL_CONNECTOR_ORIGIN = 'https://phi.omicsagent.cn'
const MAX_ITEMS = 500
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ICON_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

interface ConnectorItem {
  id: string
  version: string
  category: string
  auth: string
  transport: 'http' | 'stdio'
  catalogInstallable: boolean
  directoryAuthBlocked: boolean
  iconUrl?: string
}

export interface OfficialConnectorPayload {
  manifest: McpPackageManifest
  yaml: string
  directoryAuthBlocked: boolean
  icon?: { name: string; bytes: Buffer }
}

/** HTTP connector payloads are completely described by the API manifest and optional root icon. */
export async function fetchOfficialConnectorPackages(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<OfficialConnectorPayload[]> {
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    throw new Error('官网连接器请求超时配置无效')
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let totalBytes = 0
  const timer = setTimeout(() => controller.abort(new Error('官网连接器请求超时')), timeoutMs)
  const fetcher = options.fetch ?? fetch
  const read = async (path: string, maxBytes: number): Promise<Buffer> => {
    controller.signal.throwIfAborted()
    const url = `${OFFICIAL_CONNECTOR_ORIGIN}${path}`
    const response = await abortable(
      fetcher(url, {
        headers: { Accept: path.startsWith('/api/') ? 'application/json' : 'image/*' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      }),
      controller.signal
    )
    if (!response.ok || (response.url && response.url !== url))
      throw new Error(`官网连接器请求失败或来源无效（HTTP ${response.status}）`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('官网连接器请求超时')
    const bytes = await abortable(
      readBoundedResponse(response, maxBytes, '官网连接器响应', remaining),
      controller.signal
    )
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('官网连接器下载总大小超过限制')
    return bytes
  }
  const json = async (path: string): Promise<unknown> =>
    JSON.parse((await read(path, MAX_RESPONSE_BYTES)).toString('utf8')) as unknown
  try {
    const items: ConnectorItem[] = []
    const ids = new Set<string>()
    let expectedTotal: number | undefined
    let expectedCategories: string | undefined
    for (let page = 1; page <= 5; page += 1) {
      const value = await json(`/api/mcp?page=${page}&pageSize=100`)
      if (
        !isRecord(value) ||
        !Array.isArray(value.items) ||
        !Number.isSafeInteger(value.total) ||
        (value.total as number) < 1 ||
        (value.total as number) > MAX_ITEMS ||
        value.page !== page ||
        value.pageSize !== 100 ||
        value.pageCount !== Math.ceil((value.total as number) / 100) ||
        value.items.length !== Math.min(100, (value.total as number) - (page - 1) * 100) ||
        (expectedTotal !== undefined && value.total !== expectedTotal)
      )
        throw new Error('官网连接器分页目录无效或更新时序不一致')
      expectedTotal = value.total as number
      const categories = parseCategories(value.categories, expectedTotal)
      if (expectedCategories !== undefined && expectedCategories !== JSON.stringify(categories))
        throw new Error('官网连接器分类在分页期间发生变化')
      expectedCategories = JSON.stringify(categories)
      if (
        value.meta !== undefined &&
        (!isRecord(value.meta) || value.meta.connectors !== expectedTotal)
      )
        throw new Error('官网连接器目录计数不一致')
      for (const raw of value.items) {
        const item = parseItem(raw)
        if (ids.has(item.id)) throw new Error(`官网连接器包含重复 ID：${item.id}`)
        ids.add(item.id)
        items.push(item)
      }
      if (page === value.pageCount) break
    }
    const categories = JSON.parse(expectedCategories!) as Array<{ name: string; count: number }>
    if (
      categories.some(
        (category) =>
          items.filter((item) => item.category === category.name).length !== category.count
      )
    )
      throw new Error('官网连接器分类未完整覆盖目录')
    const installable = items.filter((item) => item.catalogInstallable)
    if (!installable.length) throw new Error('官网连接器目录没有可完整安装的模块')
    if (installable.some((item) => item.transport !== 'http'))
      throw new Error('官网连接器 API 暂不能完整交付 stdio 内容，需使用签名发布目录')
    const result: OfficialConnectorPayload[] = new Array(installable.length)
    let cursor = 0
    const tasks = Array.from({ length: Math.min(4, installable.length) }, async () => {
      while (cursor < installable.length) {
        controller.signal.throwIfAborted()
        const index = cursor++
        const item = installable[index]
        try {
          const detail = await json(`/api/mcp/${item.id}`)
          if (
            !isRecord(detail) ||
            detail.kind !== 'mcp' ||
            (detail.slug !== undefined && detail.slug !== item.id) ||
            detail.version !== item.version ||
            detail.category !== item.category ||
            detail.auth !== item.auth ||
            detail.transport !== item.transport ||
            detail.catalogInstallable !== true ||
            detail.directoryAuthBlocked !== item.directoryAuthBlocked
          )
            throw new Error(`官网连接器详情与目录不一致：${item.id}`)
          const yaml = stringifyYaml(detail.package, { sortMapEntries: true })
          const manifest = parseCompleteOfficialConnectorManifest(yaml)
          if (
            manifest.id !== item.id ||
            manifest.version !== item.version ||
            manifest.connector.category !== item.category ||
            manifest.connector.auth !== item.auth
          )
            throw new Error(`官网连接器软件包与目录不一致：${item.id}`)
          const declaredIcon =
            detail.iconUrl === undefined ? undefined : iconPath(detail.iconUrl, item.id)
          const listIcon = item.iconUrl === undefined ? undefined : iconPath(item.iconUrl, item.id)
          if (declaredIcon && listIcon && declaredIcon !== listIcon)
            throw new Error(`官网连接器图标与目录不一致：${item.id}`)
          const icon = declaredIcon ?? listIcon
          result[index] = {
            manifest,
            yaml,
            directoryAuthBlocked: item.directoryAuthBlocked,
            ...(icon
              ? { icon: { name: icon.split('/').at(-1)!, bytes: await read(icon, MAX_ICON_BYTES) } }
              : {})
          }
          if (result[index].icon?.bytes.length === 0) throw new Error('官网连接器图标为空')
        } catch (error) {
          controller.abort(error)
          throw error
        }
      }
    })
    const settled = await Promise.allSettled(tasks)
    const failure = settled.find((item) => item.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return result.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  } finally {
    clearTimeout(timer)
  }
}

export function parseCompleteOfficialConnectorManifest(
  yaml: string
): McpPackageManifest & { connector: HttpConnectorManifest } {
  const manifest = parsePackageManifestText(yaml)
  if (manifest.type !== 'mcp' || manifest.connector.transport !== 'http')
    throw new Error('官网连接器 API 无法完整交付非 HTTP 软件包')
  if (manifest.dependsOn?.length)
    throw new Error('官网连接器 API 无法完整交付软件包依赖，需使用签名发布目录')
  const url = new URL(manifest.connector.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('官网连接器服务 URL 无效')
  return { ...manifest, connector: manifest.connector }
}

function parseItem(value: unknown): ConnectorItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(value.id) ||
    typeof value.version !== 'string' ||
    !semver.valid(value.version) ||
    typeof value.category !== 'string' ||
    !CONNECTOR_CATEGORIES.includes(value.category as (typeof CONNECTOR_CATEGORIES)[number]) ||
    !['none', 'oauth', 'header'].includes(String(value.auth)) ||
    !['http', 'stdio'].includes(String(value.transport)) ||
    typeof value.catalogInstallable !== 'boolean' ||
    typeof value.directoryAuthBlocked !== 'boolean' ||
    (value.iconUrl !== undefined && typeof value.iconUrl !== 'string')
  )
    throw new Error('官网连接器目录条目无效')
  if (value.iconUrl !== undefined) iconPath(value.iconUrl, value.id)
  return {
    id: value.id,
    version: value.version,
    category: value.category,
    auth: String(value.auth),
    transport: value.transport as 'http' | 'stdio',
    catalogInstallable: value.catalogInstallable,
    directoryAuthBlocked: value.directoryAuthBlocked,
    ...(typeof value.iconUrl === 'string' ? { iconUrl: value.iconUrl } : {})
  }
}

function parseCategories(value: unknown, total: number): Array<{ name: string; count: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONNECTOR_CATEGORIES.length)
    throw new Error('官网连接器分类无效')
  const seen = new Set<string>()
  const categories = value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !CONNECTOR_CATEGORIES.includes(item.name as (typeof CONNECTOR_CATEGORIES)[number]) ||
      seen.has(item.name) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 0 ||
      (item.count as number) > MAX_ITEMS
    )
      throw new Error('官网连接器分类条目无效')
    seen.add(item.name)
    return { name: item.name, count: item.count as number }
  })
  if (categories.reduce((sum, item) => sum + item.count, 0) !== total)
    throw new Error('官网连接器分类计数不一致')
  return categories
}

function iconPath(value: unknown, id: string): string {
  if (typeof value !== 'string') throw new Error('官网连接器图标 URL 无效')
  for (const filename of PACKAGE_ICON_FILENAMES) {
    const path = `/packages/resources/connectors/${id}/${filename}`
    if (value === path || value === `${OFFICIAL_CONNECTOR_ORIGIN}${path}`) return path
  }
  throw new Error('官网连接器图标必须来自同官网的当前软件包目录')
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}
