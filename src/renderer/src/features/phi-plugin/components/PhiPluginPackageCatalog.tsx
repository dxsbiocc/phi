import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import semver from 'semver'
import type {
  PackageRegistryEntryView,
  PackageTrust,
  PackageUpdateView
} from '../../../../../shared/packageManagerTypes'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../../../lib/packageTrust'

type CatalogPlugin = PackageRegistryEntryView & {
  registryPath: string
  trust: PackageTrust
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PhiPluginPackageCatalog({
  installedIds,
  onChanged
}: {
  installedIds: ReadonlySet<string>
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [entries, setEntries] = useState<CatalogPlugin[]>([])
  const [updates, setUpdates] = useState<PackageUpdateView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchCatalog = useCallback(async (): Promise<{
    entries: CatalogPlugin[]
    updates: PackageUpdateView[]
  }> => {
    const [registries, availableUpdates] = await Promise.all([
      window.api.listPackageRegistries(),
      window.api.listPackageUpdates()
    ])
    const readable = await Promise.all(
      registries
        .filter((registry) => registry.kind !== 'bundled' && !registry.error)
        .map(async (known) => {
          try {
            return await window.api.readPackageRegistry(known.path)
          } catch {
            return null
          }
        })
    )
    const selected = new Map<string, CatalogPlugin>()
    for (const registry of readable) {
      if (!registry) continue
      for (const entry of registry.packages) {
        if (entry.type !== 'plugin') continue
        const current = selected.get(entry.id)
        if (!current || semver.gt(entry.version, current.version)) {
          selected.set(entry.id, {
            ...entry,
            registryPath: registry.dir,
            trust: registry.trust
          })
        }
      }
    }
    return {
      entries: [...selected.values()].sort((left, right) => left.title.localeCompare(right.title)),
      updates: availableUpdates
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const catalog = await fetchCatalog()
    setEntries(catalog.entries)
    setUpdates(catalog.updates)
  }, [fetchCatalog])

  useEffect(() => {
    let active = true
    void fetchCatalog()
      .then((catalog) => {
        if (active) {
          setEntries(catalog.entries)
          setUpdates(catalog.updates)
        }
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
  }, [fetchCatalog])

  async function install(entry: CatalogPlugin, update: boolean): Promise<void> {
    setBusy(entry.id)
    setError(null)
    try {
      if (update) await window.api.applyPackageUpdate('plugin', entry.id)
      else await window.api.installPackage(entry.registryPath, 'plugin', entry.id, entry.version)
      await Promise.all([load(), onChanged()])
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Stack spacing={1.25}>
      <Box>
        <Typography variant="h5">软件源目录</Typography>
        <Typography variant="body2" color="text.secondary">
          从已知软件源安装或更新 Phi 插件。
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {loading ? (
        <CircularProgress size={20} />
      ) : entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          已知软件源中没有插件包。
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5
          }}
        >
          {entries.map((entry) => {
            const installed = installedIds.has(entry.id)
            const update = updates.some((item) => item.type === 'plugin' && item.id === entry.id)
            return (
              <Paper key={entry.id} variant="outlined" sx={{ p: 1.75 }}>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>{entry.title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {entry.summary}
                    </Typography>
                    <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }}>
                      <Chip size="small" label={`v${entry.version}`} />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={PACKAGE_TRUST_LABELS[entry.trust]}
                        title={PACKAGE_TRUST_DESCRIPTIONS[entry.trust]}
                      />
                    </Stack>
                  </Box>
                  <Button
                    variant={update || !installed ? 'contained' : 'outlined'}
                    disabled={busy !== null || (installed && !update)}
                    onClick={() => void install(entry, update)}
                  >
                    {busy === entry.id
                      ? '处理中…'
                      : update
                        ? '更新'
                        : installed
                          ? '已添加'
                          : '安装'}
                  </Button>
                </Stack>
              </Paper>
            )
          })}
        </Box>
      )}
    </Stack>
  )
}
