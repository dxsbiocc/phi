import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  Divider,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import type {
  KnownPackageRegistryView,
  OfflinePackageImportPreview,
  PackageTrust
} from '../../../../../shared/packageManagerTypes'

const trustLabels: Record<PackageTrust, string> = {
  builtin: '内置',
  official: '官方',
  imported: '导入'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PackageSourcesSection(): React.JSX.Element {
  const [registries, setRegistries] = useState<KnownPackageRegistryView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<OfflinePackageImportPreview | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setRegistries(await window.api.listPackageRegistries())
  }, [])

  useEffect(() => {
    let active = true
    void window.api
      .listPackageRegistries()
      .then((next) => {
        if (active) setRegistries(next)
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function addDirectory(): Promise<void> {
    setBusy('add')
    setError(null)
    try {
      const path = await window.api.pickPackageRegistryDirectory()
      if (!path) return
      await window.api.readPackageRegistry(path)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(registry: KnownPackageRegistryView): Promise<void> {
    setBusy(registry.id)
    setError(null)
    try {
      setRegistries(await window.api.removePackageRegistry(registry.id))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function chooseArchive(): Promise<void> {
    setBusy('import')
    setError(null)
    try {
      const path = await window.api.pickPackageArchive()
      if (path) setPreview(await window.api.previewPackageImport(path))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function installImport(): Promise<void> {
    if (!preview) return
    setBusy('install-import')
    setError(null)
    try {
      await window.api.importPackage(preview.archivePath)
      setPreview(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Stack spacing={1.5}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5">软件源</Typography>
          <Typography variant="body2" color="text.secondary">
            管理本地 registry 目录，或导入单个离线软件包。移除软件源不会卸载内容。
          </Typography>
        </Box>
        <Button variant="outlined" disabled={busy !== null} onClick={() => void chooseArchive()}>
          导入软件包…
        </Button>
        <Button variant="contained" disabled={busy !== null} onClick={() => void addDirectory()}>
          添加目录
        </Button>
      </Stack>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {loading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">正在读取软件源…</Typography>
        </Stack>
      ) : (
        <Stack spacing={1}>
          {registries.map((registry) => (
            <Paper key={registry.id} variant="outlined" sx={{ p: 1.5 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{ alignItems: { sm: 'center' } }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }}>
                    {registry.kind === 'bundled' ? 'Phi 内置软件源' : registry.path}
                  </Typography>
                  <Typography
                    variant="caption"
                    color={registry.error ? 'error' : 'text.secondary'}
                    sx={{ overflowWrap: 'anywhere' }}
                  >
                    {registry.error ?? `${registry.packageCount ?? 0} 个软件包`}
                  </Typography>
                </Box>
                {registry.trust ? (
                  <Chip size="small" variant="outlined" label={trustLabels[registry.trust]} />
                ) : null}
                {registry.removable ? (
                  <Button
                    color="error"
                    disabled={busy !== null}
                    onClick={() => void remove(registry)}
                  >
                    移除
                  </Button>
                ) : null}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog
        open={preview !== null}
        onClose={busy ? undefined : () => setPreview(null)}
        maxWidth="sm"
        fullWidth
      >
        <Stack spacing={2} sx={{ p: 3 }}>
          <Typography variant="h5">确认导入软件包</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {preview?.archivePath}
          </Typography>
          <Divider />
          {preview?.plan.packages.map((entry) => (
            <Stack
              key={`${entry.type}:${entry.id}`}
              direction="row"
              sx={{ justifyContent: 'space-between' }}
            >
              <Typography>{entry.title}</Typography>
              <Typography color="text.secondary">
                v{entry.version}
                {entry.installedBy === 'dependency' ? ' · 依赖' : ''}
              </Typography>
            </Stack>
          ))}
          <Typography variant="body2" color="text.secondary">
            总大小 {preview?.plan.totalSize.toLocaleString('zh-CN')} 字节 · 信任级别：导入
          </Typography>
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button disabled={busy !== null} onClick={() => setPreview(null)}>
              取消
            </Button>
            <Button
              variant="contained"
              disabled={busy !== null}
              onClick={() => void installImport()}
            >
              {busy === 'install-import' ? '正在安装…' : '安装'}
            </Button>
          </Stack>
        </Stack>
      </Dialog>
    </Stack>
  )
}
