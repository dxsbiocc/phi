import type { Element, Nodes, Root } from 'hast'
import type { SyntaxLanguage } from './syntaxHighlight'

const MARKDOWN_CODE_LANGUAGE_ALIASES: Record<string, SyntaxLanguage> = {
  bash: 'shell',
  cjs: 'javascript',
  console: 'shell',
  css: 'css',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  none: 'plain',
  plaintext: 'plain',
  py: 'python',
  python: 'python',
  python3: 'python',
  r: 'r',
  rs: 'rust',
  rscript: 'r',
  rust: 'rust',
  sh: 'shell',
  shell: 'shell',
  text: 'plain',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell'
}

export function syntaxLanguageForMarkdownCode(language: string | null): SyntaxLanguage {
  if (!language) return 'plain'
  return MARKDOWN_CODE_LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? 'plain'
}

/** Markdown parsers render an unfinished fence while an assistant is still streaming. */
function isClosedMarkdownFence(source: string): boolean {
  const opening = /^(`{3,}|~{3,})/.exec(source)?.[1]
  const lastLine = source.lastIndexOf('\n')
  if (!opening || lastLine < 0) return false
  const closing = /^[\t >]*(`{3,}|~{3,})[\t \r]*$/.exec(source.slice(lastLine + 1))?.[1]
  return Boolean(closing && closing[0] === opening[0] && closing.length >= opening.length)
}

function fenceHasClosingLine(node: Element, source: string): boolean {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  const code = node.children[0]
  if (start === undefined || end === undefined || code?.type !== 'element') return false
  const text = code.children[0]
  if (code.tagName !== 'code' || text?.type !== 'text') return false
  const fence = source.slice(start, end)
  // A marker inside the code is included in the rendered body's line count.
  return (
    fence.split('\n').length === text.value.split('\n').length + 1 && isClosedMarkdownFence(fence)
  )
}

export function rehypeClosedCodeFences(): (tree: Root, file: { toString(): string }) => void {
  return (tree, file) => {
    const source = file.toString()
    const visit = (node: Nodes): void => {
      if (node.type === 'element' && node.tagName === 'pre' && fenceHasClosingLine(node, source)) {
        node.properties['data-phi-code-closed'] = true
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}
