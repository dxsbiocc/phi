import { Box, Button, Paper, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

import type { WorkspaceChangeSummaryItem } from '../../../types'
import type { WorkspaceDiffReference } from '../../../../../shared/workspaceChangeTypes'
import { getRendererApi } from '../../../lib/rendererApi'
import { WorkspaceDiffDialog } from './WorkspaceDiffDialog'

const STATUS_LABELS = { added: '新增', modified: '修改', deleted: '删除' } as const

export function WorkspaceChangesCard({
  item,
  onOpenFile
}: {
  item: WorkspaceChangeSummaryItem
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [selection, setSelection] = useState<{ path: string; ref: WorkspaceDiffReference } | null>(
    null
  )
  const [loaded, setLoaded] = useState<{ id: string; patch?: string; error?: string } | null>(null)

  useEffect(() => {
    if (!selection) return
    let active = true
    void getRendererApi()
      .readWorkspaceDiff(selection.ref)
      .then((patch) => {
        if (active) setLoaded({ id: selection.ref.id, patch })
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({
            id: selection.ref.id,
            error: error instanceof Error ? error.message : '差异文件无法读取'
          })
      })
    return () => {
      active = false
    }
  }, [selection])

  return (
    <>
      <Paper
        variant="outlined"
        aria-label="运行期间文件变化"
        sx={{ mx: 1, my: 0.75, p: 1.5, borderRadius: 2, minWidth: 0 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {item.truncated
            ? `运行期间已发现 ${item.totalChanged} 个文件变化`
            : `运行期间文件变化 · ${item.totalChanged} 个`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          显示 Git 可见文件的净变化；忽略的输出文件不列出，并行修改也可能出现。
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
          {item.files.map((file) => (
            <Box
              key={file.path}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                {STATUS_LABELS[file.status]}
              </Typography>
              {file.status !== 'deleted' && onOpenFile ? (
                <Button
                  size="small"
                  onClick={() => onOpenFile(file.path)}
                  aria-label={`预览改动文件 ${file.displayPath}`}
                  sx={{ minWidth: 0, p: 0, textTransform: 'none', justifyContent: 'flex-start' }}
                >
                  <Typography
                    variant="body2"
                    noWrap
                    sx={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}
                  >
                    {file.displayPath}
                  </Typography>
                </Button>
              ) : (
                <Typography
                  variant="body2"
                  noWrap
                  sx={{ minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}
                >
                  {file.displayPath}
                </Typography>
              )}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ ml: 'auto', flexShrink: 0 }}
              >
                {file.added === null || file.deleted === null
                  ? '行数不可用'
                  : `+${file.added} / −${file.deleted}`}
              </Typography>
              {file.diff && (
                <Button
                  size="small"
                  aria-label={`查看 ${file.displayPath} 的本轮差异`}
                  onClick={() => {
                    if (file.diff) setSelection({ path: file.displayPath, ref: file.diff })
                  }}
                  sx={{ flexShrink: 0 }}
                >
                  查看差异
                </Button>
              )}
            </Box>
          ))}
        </Box>
        {item.truncated && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            文件列表已截断。
          </Typography>
        )}
      </Paper>
      <WorkspaceDiffDialog
        path={selection?.path ?? null}
        patch={loaded?.id === selection?.ref.id ? (loaded?.patch ?? null) : null}
        error={loaded?.id === selection?.ref.id ? (loaded?.error ?? null) : null}
        onClose={() => setSelection(null)}
      />
    </>
  )
}
