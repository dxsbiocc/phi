import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'

const MAX_PROMPT_BYTES = 8 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024
const ANSI_ESCAPE = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'gu')

export function buildConnectorSetupPrompt(setup: McpConnectorSetupProgress): string {
  const title = cleanText(setup.title ?? setup.id, 256)
  const summary = cleanText(setup.summary ?? setup.id, 1_024)
  const error = cleanText(setup.error ?? '未知错误', 1_024)
  const reason = setup.failureReason ? cleanText(setup.failureReason, 200) : undefined
  const detail = setup.detail ? utf8Tail(cleanText(setup.detail), MAX_OUTPUT_BYTES) : undefined
  const readmeUrl = setup.setupHint?.readmeUrl
    ? cleanText(setup.setupHint.readmeUrl, 500)
    : undefined
  const commands = setup.setupHint?.commands?.map((command) => cleanText(command, 200)) ?? []
  const intent = setup.failureKind === 'needs-setup' ? '完成初始化和配置' : '排查启动失败'

  const prompt = [
    `请帮我${intent}这个本地 MCP 连接器：${title}。`,
    '',
    '请先阅读这个服务的文档，弄清它需要先做哪些初始化或配置，并告诉我需要我提供什么。需要运行初始化命令时，请在终端里起草命令（使用终端草稿，把授权码、密钥等敏感信息列为必填项），由我自己确认并在终端里输入；不要让我把密钥贴到对话里，也不要把它们写进任何文件、日志或命令行参数。全部完成后，告诉我回到「后台任务」点击重试。',
    '',
    `运行方式：${summary}`,
    `运行类型：${setup.kind ?? 'local-stdio'}`,
    `失败信息：${error}`,
    reason ? `识别到的原因：${reason}` : undefined,
    detail ? `进程输出（末尾）：\n${detail}` : undefined,
    readmeUrl ? `README：${readmeUrl}` : undefined,
    commands.length ? `建议命令（仅供检查，不要自动执行）：\n${commands.join('\n')}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')

  return utf8Head(prompt, MAX_PROMPT_BYTES)
}

function cleanText(value: string, maxCharacters = Number.POSITIVE_INFINITY): string {
  return stripControlCharacters(value.replace(ANSI_ESCAPE, ''))
    .replace(/\r\n?/gu, '\n')
    .slice(0, maxCharacters)
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 9 || code === 10 || code === 13 || (code > 31 && (code < 127 || code > 159))
    })
    .join('')
}

function utf8Head(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, '')
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(bytes.length - maxBytes)).replace(/^\uFFFD/u, '')
}
