import { useUiLanguage } from '../../../lib/i18n'
import { wrapperCopy } from '../lib/wrapperCopy'
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
  useUiLanguage()
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
        {wrapperCopy.openOutputDirectory}
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
      <Tooltip title={outputScope ? '' : wrapperCopy.missingResultAuthorization}>
        <span>
          <Button
            size="small"
            disabled={!outputScope || !onOpenRemoteResult}
            onClick={() => {
              if (outputScope) onOpenRemoteResult?.(run, outputScope.root, 'directory')
            }}
          >
            {wrapperCopy.openOutputDirectory}
          </Button>
        </span>
      </Tooltip>
      {runScope ? (
        <Button
          size="small"
          disabled={!onOpenRemoteResult}
          onClick={() => onOpenRemoteResult?.(run, runScope.root, 'directory')}
        >
          {wrapperCopy.viewRunFiles}
        </Button>
      ) : null}
      {primaryReports.map((output) => (
        <Button
          key={output.id}
          size="small"
          disabled={!onOpenRemoteResult}
          onClick={() => onOpenRemoteResult?.(run, output.path, 'file')}
        >
          {wrapperCopy.viewOutput(output.id)}
        </Button>
      ))}
    </>
  )
}
