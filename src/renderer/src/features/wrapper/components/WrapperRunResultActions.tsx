import { Button, Tooltip } from '@mui/material'

import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import type { LocalPathKind } from '../../../components/MarkdownContent'
import { resolveLocalPath } from '../../../lib/localPaths'
import { wrapperResultScopeForOutput, wrapperResultScopeForRun } from '../lib/resultFiles'

export function WrapperRunResultActions({
  run,
  onOpenLocalPath,
  onOpenRemoteResult
}: {
  run: WrapperRun
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenRemoteResult?: (run: WrapperRun, path: string, kind: LocalPathKind) => void
}): React.JSX.Element {
  if (!run.remote) {
    return (
      <Button
        size="small"
        onClick={() => {
          const path = resolveLocalPath(
            run.outDir.startsWith('/') ? run.outDir : `./${run.outDir}`,
            run.cwd
          )
          if (path) onOpenLocalPath?.(path, 'directory')
        }}
      >
        打开输出目录
      </Button>
    )
  }

  const outputScope = wrapperResultScopeForRun(run, 'output')
  const runScope = wrapperResultScopeForRun(run, 'run')
  const primaryReports = (run.outputs ?? []).filter(
    (output) => output.primary && wrapperResultScopeForOutput(run, output)
  )
  return (
    <>
      <Tooltip title={outputScope ? '' : '这条旧运行记录缺少远端结果授权信息'}>
        <span>
          <Button
            size="small"
            disabled={!outputScope || !onOpenRemoteResult}
            onClick={() => {
              if (outputScope) onOpenRemoteResult?.(run, outputScope.root, 'directory')
            }}
          >
            打开输出目录
          </Button>
        </span>
      </Tooltip>
      {runScope ? (
        <Button
          size="small"
          disabled={!onOpenRemoteResult}
          onClick={() => onOpenRemoteResult?.(run, runScope.root, 'directory')}
        >
          查看运行文件
        </Button>
      ) : null}
      {primaryReports.map((output) => (
        <Button
          key={output.id}
          size="small"
          disabled={!onOpenRemoteResult}
          onClick={() => onOpenRemoteResult?.(run, output.path, 'file')}
        >
          查看{output.id === 'report' ? '报告' : output.id}
        </Button>
      ))}
    </>
  )
}
