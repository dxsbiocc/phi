import type { CommandResult, HostCommand, WorkspaceHost } from '../workspace-host/types'

const SUMMARY_TIMEOUT_MS = 15_000
const SUMMARY_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const SAFE_GIT_ENV = {
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat'
} as const

const SAFE_GIT_CONFIG = [
  'core.worktree=.',
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'color.ui=false',
  'credential.helper=',
  'diff.external='
] as const

const READ_ONLY_GIT_SCRIPT = `
original_path=$PATH
safe_path=
old_ifs=$IFS
IFS=:
set -f
for path_entry in $original_path; do
  [ -n "$path_entry" ] || continue
  case "$path_entry" in
    /*)
      case "$path_entry" in "$PWD"|"$PWD"/*) continue ;; esac
      if [ -z "$safe_path" ]; then
        safe_path=$path_entry
      else
        safe_path=$safe_path:$path_entry
      fi
      ;;
  esac
done
set +f
IFS=$old_ifs
[ -n "$safe_path" ] || safe_path=/usr/bin:/bin
git_command() {
  /usr/bin/env -i PATH="$safe_path" ${Object.entries(SAFE_GIT_ENV)
    .map(([key, value]) => `${key}='${value}'`)
    .join(' ')} git "$@"
}
if [ ! -e .git ]; then
  printf '%s\\n' '__PHI_GIT_NOT_REPOSITORY__' >&2
  exit 72
fi
if [ -L .git ] || [ ! -d .git ]; then
  printf '%s\\n' '__PHI_GIT_UNSAFE_REPOSITORY__' >&2
  exit 73
fi
{
  git_command config --name-only --get-regexp '^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(command|textconv))$'
  config_status=$?
  if [ "$config_status" -eq 0 ] || [ "$config_status" -eq 1 ]; then
    printf '%s\\n' '__PHI_GIT_CONFIG_SCAN_OK__'
  else
    printf '%s%s\\n' '__PHI_GIT_CONFIG_SCAN_ERROR_' "$config_status"
  fi
} |
(
  set -f
  filter_count=0
  scan_ok=0
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    case "$key" in
      __PHI_GIT_CONFIG_SCAN_OK__) scan_ok=1; continue ;;
      __PHI_GIT_CONFIG_SCAN_ERROR_*)
        config_status=\${key#__PHI_GIT_CONFIG_SCAN_ERROR_}
        case "$config_status" in *[!0-9]*|'') exit 71 ;; esac
        exit "$config_status"
        ;;
    esac
    if [ "\${#key}" -gt 1024 ]; then
      printf '%s\\n' '__PHI_GIT_CONFIG_LIMIT__' >&2
      exit 70
    fi
    filter_count=$((filter_count + 1))
    if [ "$filter_count" -gt 256 ]; then
      printf '%s\\n' '__PHI_GIT_CONFIG_LIMIT__' >&2
      exit 70
    fi
    case "$key" in
      *.required) set -- -c "$key=false" "$@" ;;
      *) set -- -c "$key=" "$@" ;;
    esac
  done
  if [ "$scan_ok" -ne 1 ]; then
    printf '%s\\n' '__PHI_GIT_CONFIG_SCAN_FAILED__' >&2
    exit 71
  fi
  set +f
  git_command --no-pager ${SAFE_GIT_CONFIG.map((entry) => `-c '${entry}'`).join(' ')} "$@"
)
`.trim()

function readOnlyGitCommand(args: readonly string[]): HostCommand {
  return ['/bin/sh', '-c', READ_ONLY_GIT_SCRIPT, 'phi-git-read-only', ...args]
}

export interface AvailableGitSummary {
  state: 'available'
  branch: string
  dirty: boolean
  detached: boolean
  headOid?: string
}

export type GitUnavailableReason =
  | 'git-unavailable'
  | 'not-repository'
  | 'dubious-ownership'
  | 'timeout'
  | 'output-truncated'
  | 'invalid-output'
  | 'unsafe-configuration'
  | 'unsafe-repository'
  | 'command-failed'

export interface UnavailableGitSummary {
  state: 'unavailable'
  reason: GitUnavailableReason
  message: string
}

export type GitSummary = AvailableGitSummary | UnavailableGitSummary

function validBranchName(value: string): boolean {
  if (!value || value.length > 1024) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return false
  }
  return true
}

function didTimeOut(result: CommandResult): boolean {
  return (
    result.terminationReason === 'timeout' ||
    (result.terminationReason === undefined && result.code === null && result.signal !== null)
  )
}

function commandFailure(result: CommandResult): UnavailableGitSummary {
  if (didTimeOut(result)) {
    return {
      state: 'unavailable',
      reason: 'timeout',
      message: 'Git 状态读取在 15 秒后超时；远程 NFS 可能较慢，请稍后手动刷新。'
    }
  }
  if (result.code === 127) {
    return {
      state: 'unavailable',
      reason: 'git-unavailable',
      message: 'Git 不可用：服务器或本机未安装 Git。'
    }
  }
  if (/not a git repository|__PHI_GIT_NOT_REPOSITORY__/i.test(result.stderr)) {
    return {
      state: 'unavailable',
      reason: 'not-repository',
      message: 'Git 不可用：项目目录不是 Git 仓库。'
    }
  }
  if (/dubious ownership/i.test(result.stderr)) {
    return {
      state: 'unavailable',
      reason: 'dubious-ownership',
      message: 'Git 不可用：仓库所有权不安全；Phi 未添加 safe.directory 信任。'
    }
  }
  if (/__PHI_GIT_CONFIG_(?:LIMIT|SCAN_FAILED)__/.test(result.stderr)) {
    return {
      state: 'unavailable',
      reason: 'unsafe-configuration',
      message: 'Git 配置超过安全检查上限；Phi 未执行状态读取。'
    }
  }
  if (/__PHI_GIT_UNSAFE_REPOSITORY__/.test(result.stderr)) {
    return {
      state: 'unavailable',
      reason: 'unsafe-repository',
      message: 'Git 不可用：仓库元数据必须位于项目根目录内。'
    }
  }
  return {
    state: 'unavailable',
    reason: 'command-failed',
    message: `Git 状态读取失败${result.code === null ? '' : `（退出码 ${result.code}）`}。`
  }
}

function executionFailure(error: unknown): UnavailableGitSummary {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return {
      state: 'unavailable',
      reason: 'git-unavailable',
      message: 'Git 不可用：服务器或本机未安装 Git。'
    }
  }
  return {
    state: 'unavailable',
    reason: 'command-failed',
    message: 'Git 状态读取失败。'
  }
}

function parseSummary(output: string): AvailableGitSummary | undefined {
  let branch: string | undefined
  let headOid: string | undefined
  let dirty = false
  let sawOid = false

  for (const record of output.split('\0')) {
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      if (value !== '(detached)' && !validBranchName(value)) {
        return undefined
      }
      branch = value
    } else if (record.startsWith('# branch.oid ')) {
      sawOid = true
      const value = record.slice('# branch.oid '.length)
      if (value !== '(initial)') {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) return undefined
        headOid = value
      }
    } else if (record.startsWith('# ')) {
      continue
    } else if (record) {
      if (record.startsWith('! ')) continue
      if (!/^(?:1 |2 |u |\? )/.test(record)) return undefined
      dirty = true
    }
  }

  if (!sawOid || !branch) return undefined
  const detached = branch === '(detached)'
  return {
    state: 'available',
    branch: detached ? (headOid?.slice(0, 7) ?? 'detached') : (branch ?? 'detached'),
    dirty,
    detached,
    ...(headOid ? { headOid } : {})
  }
}

export class WorkspaceGitService {
  constructor(
    private readonly host: WorkspaceHost,
    private readonly projectRoot: string
  ) {}

  async summary(): Promise<GitSummary> {
    let result: CommandResult
    try {
      result = await this.host.exec.run(
        readOnlyGitCommand([
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=normal',
          '--no-renames'
        ]),
        {
          cwd: this.projectRoot,
          env: SAFE_GIT_ENV,
          timeoutMs: SUMMARY_TIMEOUT_MS,
          maxOutputBytes: SUMMARY_MAX_OUTPUT_BYTES
        }
      )
    } catch (error) {
      return executionFailure(error)
    }
    if (didTimeOut(result)) return commandFailure(result)
    if (result.truncated || result.stdoutTruncated || result.stderrTruncated) {
      return {
        state: 'unavailable',
        reason: 'output-truncated',
        message: 'Git 状态输出超过 2 MiB 上限；无法可靠判断工作区状态。'
      }
    }
    if (result.code !== 0) return commandFailure(result)
    return (
      parseSummary(result.stdout) ?? {
        state: 'unavailable',
        reason: 'invalid-output',
        message: 'Git 返回了无法识别的状态数据。'
      }
    )
  }
}
