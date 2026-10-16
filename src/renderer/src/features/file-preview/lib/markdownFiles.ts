export function isMarkdownFilePath(path: string): boolean {
  let target = path
  if (path.startsWith('ssh://')) {
    try {
      target = decodeURIComponent(new URL(path).pathname)
    } catch {
      return false
    }
  }
  return /\.(md|markdown|mdown)$/i.test(target)
}

export function markdownDirectory(path: string): string {
  if (path.startsWith('ssh://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return '/'
    }
  }
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export { textContentsEqual as markdownContentsEqual } from './textFiles'
