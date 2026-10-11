import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { ManagedEnvironmentPackage } from '../../../../../shared/environmentTypes'

const MANAGER_LABELS: Record<ManagedEnvironmentPackage['manager'], string> = {
  conda: 'Conda',
  pip: 'PyPI',
  github: 'GitHub',
  cran: 'CRAN'
}

export function EnvironmentPackageList({
  packages
}: {
  packages: readonly ManagedEnvironmentPackage[]
}): React.JSX.Element | null {
  if (packages.length === 0) return null
  return (
    <Box component="section" aria-labelledby="managed-environment-packages-title" sx={{ mt: 1.5 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1 }}>
        <Typography
          id="managed-environment-packages-title"
          variant="subtitle2"
          sx={{ fontWeight: 700 }}
        >
          依赖包 · {packages.length}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          版本来自当前平台锁文件
        </Typography>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 0.75,
          maxHeight: 240,
          overflowY: 'auto',
          pr: 0.5
        }}
      >
        {packages.map((dependency) => (
          <Box
            key={`${dependency.manager}:${dependency.name}`}
            data-phi-environment-package={dependency.name}
            sx={{
              minWidth: 0,
              px: 1,
              py: 0.75,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1.5
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
              <Typography
                variant="body2"
                noWrap
                title={dependency.name}
                sx={{ flex: 1, fontWeight: 600 }}
              >
                {dependency.name}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ fontFamily: 'var(--font-mono)' }}
              >
                {dependency.version ?? '锁定'}
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {MANAGER_LABELS[dependency.manager]}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
