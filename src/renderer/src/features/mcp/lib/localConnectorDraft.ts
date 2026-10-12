import type {
  LocalMcpConnectorRequest,
  LocalMcpRuntime,
  LocalMcpRuntimeOption
} from '../../../../../shared/mcpConnectorCatalog'

export interface LocalConnectorEnvRow {
  id: string
  name: string
  value: string
}

export interface LocalConnectorDraft {
  name: string
  runtime: LocalMcpRuntime
  command: string
  argsText: string
  envRows: LocalConnectorEnvRow[]
  cwd: string
}

export interface LocalConnectorInitialDraft {
  tab: 'local'
  name: string
  runtimeHint?: 'bun'
  command: string
  args: readonly string[]
}

const namePattern = /^[a-z][a-z0-9_-]{1,63}$/i
const runtimeRefPattern = /^phi:[a-z][a-z0-9-]{0,62}@(0|[1-9][0-9]*)$/
const environmentCommandPattern = /^[A-Za-z0-9_+.-]+$/
const envNamePattern = /^[A-Z_][A-Z0-9_]*$/

export function emptyLocalConnectorDraft(): LocalConnectorDraft {
  return {
    name: '',
    runtime: { kind: 'environment', ref: '' },
    command: '',
    argsText: '',
    envRows: [],
    cwd: ''
  }
}

export function draftToFormState(
  draft: LocalConnectorInitialDraft,
  runtimes: readonly LocalMcpRuntimeOption[]
): LocalConnectorDraft {
  const bunAvailable = runtimes.some((runtime) => runtime.kind === 'bun' || runtime.ref === 'bun')
  const runtimeRef = runtimes.some((runtime) => runtime.ref === 'phi:python@1')
    ? 'phi:python@1'
    : ''
  return {
    name: draft.name,
    runtime:
      draft.runtimeHint === 'bun' && bunAvailable
        ? { kind: 'bun' }
        : { kind: 'environment', ref: draft.runtimeHint === 'bun' ? '' : runtimeRef },
    command: draft.command,
    argsText: draft.args.join('\n'),
    envRows: [],
    cwd: ''
  }
}

export function parseLocalConnectorArgs(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

function reservedEnvironmentName(name: string): boolean {
  return (
    name === 'PATH' ||
    name === 'HOME' ||
    name === 'LANG' ||
    name === 'TMPDIR' ||
    name === 'PYTHONPATH' ||
    name === 'PYTHONHOME' ||
    name === 'NODE_OPTIONS' ||
    name === 'NODE_PATH' ||
    name === 'JAVA_TOOL_OPTIONS' ||
    name === 'BASH_ENV' ||
    name === 'ENV' ||
    name === 'IFS' ||
    name.startsWith('PHI_') ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('BUN_') ||
    name.startsWith('CONDA_') ||
    name.startsWith('R_LIBS')
  )
}

function localConnectorEnvironment(rows: readonly LocalConnectorEnvRow[]): Record<string, string> {
  const populated = rows.filter((row) => row.name.trim() || row.value)
  if (populated.length > 32) throw new Error('环境变量最多可填写 32 项')

  return populated.reduce<Record<string, string>>((result, row) => {
    const name = row.name.trim()
    if (!envNamePattern.test(name)) throw new Error(`环境变量名称无效：${name || '空名称'}`)
    if (reservedEnvironmentName(name)) throw new Error(`不能设置保留变量 ${name}`)
    if (name in result) throw new Error(`环境变量 ${name} 重复`)
    if (row.value.length > 4096) throw new Error(`环境变量 ${name} 的值不能超过 4096 个字符`)
    if (/[\0\r\n]/.test(row.value)) throw new Error(`环境变量 ${name} 的值不能包含换行或 NUL`)
    return { ...result, [name]: row.value }
  }, {})
}

export function buildLocalConnectorRequest(draft: LocalConnectorDraft): LocalMcpConnectorRequest {
  const name = draft.name.trim()
  if (!namePattern.test(name)) {
    throw new Error('连接器名称需为 2–64 位字母、数字、下划线或连字符，并以字母开头')
  }

  const command = draft.command.trim()
  if (!command || /[\0\r\n]/.test(command)) throw new Error('请输入有效命令')
  if (draft.runtime.kind === 'environment') {
    if (!runtimeRefPattern.test(draft.runtime.ref)) throw new Error('请选择已就绪的 Phi 运行环境')
    if (!environmentCommandPattern.test(command)) {
      throw new Error('环境中的命令需为不含路径的命令名')
    }
  } else if (draft.runtime.kind === 'bun') {
    if (command !== 'x' && command !== 'run') {
      throw new Error('Phi 内置 Bun 命令只能是 x 或 run')
    }
  } else if (!command.startsWith('/')) {
    throw new Error('本机命令需使用绝对路径')
  }

  const args = parseLocalConnectorArgs(draft.argsText)
  if (args.length > 64) throw new Error('参数最多可填写 64 项')
  for (const arg of args) {
    if (arg.length > 4096) throw new Error('每个参数不能超过 4096 个字符')
    if (arg.includes('\0')) throw new Error('参数不能包含 NUL')
  }

  const cwd = draft.cwd.trim()
  if (cwd && !cwd.startsWith('/')) throw new Error('工作目录需使用绝对路径')

  return {
    name,
    runtime: draft.runtime,
    command,
    args,
    env: localConnectorEnvironment(draft.envRows),
    ...(cwd ? { cwd } : {})
  }
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", `'"'"'`)}'`
}

export function formatLocalConnectorArgv(command: string, args: readonly string[]): string {
  return [command, ...args]
    .filter((part, index) => index > 0 || part.length > 0)
    .map(quoteArg)
    .join(' ')
}

export function localConnectorDraftError(draft: LocalConnectorDraft): string | null {
  try {
    buildLocalConnectorRequest(draft)
    return null
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}
