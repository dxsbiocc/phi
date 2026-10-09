import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import { TbPackages } from 'react-icons/tb'

import type { ManagedEnvironmentEntry } from '../../../../../shared/environmentTypes'
import apptainerLogoSvg from '../assets/apptainer.svg?raw'
import jupyterLogoSvg from '../assets/jupyter.svg?raw'
import nextflowLogoSvg from '../assets/nextflow.svg?raw'
import pythonLogoSvg from '../assets/python.svg?raw'
import rLogoSvg from '../assets/r.svg?raw'

type EnvironmentBrandKey =
  'jupyter' | 'nextflow' | 'python' | 'r' | 'docker' | 'singularity' | 'java' | 'conda' | 'generic'

type BrandVisual = {
  key: EnvironmentBrandKey
  label: string
  logoUrl?: string
}

type Capability = {
  key: string
  label: string
}

function svgDataUrl(markup: string): string {
  return `data:image/svg+xml,${encodeURIComponent(markup)}`
}

const apptainerLogoUrl = svgDataUrl(apptainerLogoSvg)
const jupyterLogoUrl = svgDataUrl(jupyterLogoSvg)
const nextflowLogoUrl = svgDataUrl(nextflowLogoSvg)
const pythonLogoUrl = svgDataUrl(pythonLogoSvg)
const rLogoUrl = svgDataUrl(rLogoSvg)

const BRAND_VISUALS: Record<EnvironmentBrandKey, BrandVisual> = {
  jupyter: { key: 'jupyter', label: 'Jupyter', logoUrl: jupyterLogoUrl },
  nextflow: { key: 'nextflow', label: 'Nextflow', logoUrl: nextflowLogoUrl },
  python: { key: 'python', label: 'Python', logoUrl: pythonLogoUrl },
  r: { key: 'r', label: 'R', logoUrl: rLogoUrl },
  docker: { key: 'docker', label: 'Docker' },
  singularity: {
    key: 'singularity',
    label: 'Singularity / Apptainer',
    logoUrl: apptainerLogoUrl
  },
  java: { key: 'java', label: 'Java' },
  conda: { key: 'conda', label: 'Conda' },
  generic: { key: 'generic', label: '环境' }
}

function keyFromText(value: string): EnvironmentBrandKey | null {
  const normalized = value.toLowerCase()
  if (normalized.includes('jupyter')) return 'jupyter'
  if (normalized.includes('nextflow')) return 'nextflow'
  if (normalized.includes('phi:r@') || normalized.includes('phi-r')) return 'r'
  if (normalized === 'r' || normalized === 'r-base' || normalized.includes('irkernel')) return 'r'
  if (normalized.includes('python') || normalized.includes('cpython')) return 'python'
  if (normalized.includes('docker')) return 'docker'
  if (normalized.includes('singularity') || normalized.includes('apptainer')) return 'singularity'
  if (normalized.includes('openjdk') || normalized === 'java') return 'java'
  if (normalized.includes('conda') || normalized.includes('mamba')) return 'conda'
  return null
}

function environmentPrimaryBrand(environment: ManagedEnvironmentEntry): BrandVisual {
  const key = keyFromText(`${environment.ref} ${environment.label ?? ''}`) ?? 'generic'
  return BRAND_VISUALS[key]
}

const CONSUMER_CAPABILITIES: Record<
  ManagedEnvironmentEntry['consumers'][number]['kind'],
  Capability
> = {
  skill: { key: 'skills', label: '技能运行时' },
  agent: { key: 'agent', label: 'Agent 运行时' },
  plugin: { key: 'plugin', label: '插件运行时' },
  wrapper: { key: 'workflow', label: '工作流运行时' },
  notebook: { key: 'notebook-server', label: 'Notebook 服务' },
  kernel: { key: 'notebook-kernel', label: 'Notebook 内核' }
}

function environmentCapabilities(environment: ManagedEnvironmentEntry): Capability[] {
  const primaryKey = environmentPrimaryBrand(environment).key
  if (primaryKey === 'jupyter') {
    return [{ key: 'notebook-server', label: 'Notebook 服务' }]
  }
  if (primaryKey === 'nextflow') {
    return [
      { key: 'java', label: 'Java' },
      { key: 'docker', label: 'Docker' },
      { key: 'singularity', label: 'Singularity / Apptainer' }
    ]
  }
  if (primaryKey === 'python') {
    return [
      { key: 'python-kernel', label: 'Python 内核' },
      { key: 'skills', label: '技能运行时' }
    ]
  }
  if (primaryKey === 'r') {
    return [
      { key: 'r-kernel', label: 'R 内核' },
      { key: 'visualization', label: '可视化运行时' }
    ]
  }
  const byKey = new Map<string, Capability>()
  for (const consumer of environment.consumers) {
    const capability = CONSUMER_CAPABILITIES[consumer.kind]
    byKey.set(capability.key, capability)
  }
  return [...byKey.values()]
}

export function EnvironmentBrandIcon({
  environment,
  size = 64
}: {
  environment: ManagedEnvironmentEntry
  size?: number
}): React.JSX.Element {
  const visual = environmentPrimaryBrand(environment)
  return (
    <Box
      role="img"
      aria-label={`${visual.label} 官方图标`}
      sx={{
        width: size,
        height: size,
        p: 1,
        flexShrink: 0,
        borderRadius: 2.5,
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'common.white',
        border: '1px solid',
        borderColor: 'divider'
      }}
    >
      {visual.logoUrl ? (
        <Box
          component="img"
          src={visual.logoUrl}
          alt=""
          data-phi-environment-logo={visual.key}
          sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <TbPackages aria-hidden size={Math.round(size * 0.48)} color="#667085" />
      )}
    </Box>
  )
}

export function EnvironmentCapabilityChips({
  environment,
  limit = 4
}: {
  environment: ManagedEnvironmentEntry
  limit?: number
}): React.JSX.Element {
  const capabilities = environmentCapabilities(environment)
  const visible = capabilities.slice(0, limit)
  const hidden = capabilities.length - visible.length
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
      {visible.map(({ key, label }) => (
        <Chip
          key={key}
          size="small"
          variant="outlined"
          data-phi-environment-capability={key}
          label={label}
          sx={{ bgcolor: 'background.paper' }}
        />
      ))}
      {hidden > 0 ? <Chip size="small" variant="outlined" label={`+${hidden}`} /> : null}
    </Stack>
  )
}
