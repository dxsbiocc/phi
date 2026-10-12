export function githubImportUrlError(input: string): string | null {
  const raw = input.trim()
  if (!raw) return '请输入 GitHub 仓库地址'
  if (/%[0-9a-f]{2}/i.test(raw)) return 'GitHub 仓库地址不能包含编码路径'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'GitHub 仓库地址无效'
  }
  const authority = /^https:\/\/([^/]+)(?:\/|$)/i.exec(raw)?.[1]
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    authority?.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return '仅支持不含凭据、端口、查询参数的 https://github.com 仓库地址'
  }
  const parts = url.pathname.split('/').slice(1)
  const trailingSlash = parts.at(-1) === ''
  if (trailingSlash) parts.pop()
  if (parts.length < 2 || parts.some((part) => !part)) return 'GitHub 仓库地址无效'
  const owner = parts[0]!
  const rawName = parts[1]!
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    return 'GitHub 仓库名称无效'
  }
  if (parts.length > 2) {
    if (trailingSlash || parts[2] !== 'tree' || parts.length < 4) {
      return 'GitHub 仓库地址路径无效'
    }
    const ref = parts.slice(3).join('/')
    if (
      !/^[A-Za-z0-9._/-]{1,200}$/.test(ref) ||
      ref.includes('..') ||
      ref.startsWith('-') ||
      ref.startsWith('/') ||
      ref.endsWith('/')
    ) {
      return 'GitHub 分支或提交引用无效'
    }
  }
  return null
}
