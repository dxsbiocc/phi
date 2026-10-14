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
