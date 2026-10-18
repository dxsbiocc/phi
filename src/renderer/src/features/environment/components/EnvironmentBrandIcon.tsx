import { environmentUi } from '../lib/environmentUi'
import { useUiLanguage } from '../../../lib/i18n'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import { TbPackages } from 'react-icons/tb'

import type { ManagedEnvironmentEntry } from '../../../../../shared/environmentTypes'
import type { ManagedEnvironmentHostResources } from '../lib/environmentPanel'
import { hostToolDisplayVersion, hostToolPresentation } from '../lib/hostEnvironmentStatus'
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
  generic: {
    key: 'generic',
    get label() {
      return environmentUi.environments
    }
  }
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
  skill: {
    key: 'skills',
    get label() {
      return environmentUi.skillRuntime
    }
  },
  agent: {
    key: 'agent',
    get label() {
      return environmentUi.agentRuntime
    }
  },
  plugin: {
    key: 'plugin',
    get label() {
      return environmentUi.pluginRuntime
    }
  },
  wrapper: {
    key: 'workflow',
    get label() {
      return environmentUi.workflowRuntime
    }
  },
  notebook: {
    key: 'notebook-server',
    get label() {
      return environmentUi.notebookServer
    }
  },
  kernel: {
    key: 'notebook-kernel',
    get label() {
      return environmentUi.notebookKernel
    }
  }
}

function environmentCapabilities(environment: ManagedEnvironmentEntry): Capability[] {
  const primaryKey = environmentPrimaryBrand(environment).key
  if (primaryKey === 'jupyter') {
    return [{ key: 'notebook-server', label: environmentUi.notebookServer }]
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
      { key: 'python-kernel', label: environmentUi.pythonKernel },
      { key: 'skills', label: environmentUi.skillRuntime }
    ]
  }
  if (primaryKey === 'r') {
    return [
      { key: 'r-kernel', label: environmentUi.rKernel },
      { key: 'visualization', label: environmentUi.visualizationRuntime }
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
  useUiLanguage()
  const visual = environmentPrimaryBrand(environment)
  return (
    <Box
      role="img"
      aria-label={environmentUi.valueOfficialIcon(visual.label)}
      sx={{
        width: size,
        height: size,
        p: 1,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
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
  useUiLanguage()
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

type HostCapabilityChip = {
  id: string
  label: string
  color: 'success' | 'warning' | 'default'
  title?: string
}

function hostCapabilityChips(resources: ManagedEnvironmentHostResources): HostCapabilityChip[] {
  const tools = resources.tools.map((tool): HostCapabilityChip => {
    const label = tool.id === 'jupyter' ? 'Jupyter' : 'Nextflow'
    const presentation = hostToolPresentation(tool)
    return {
      id: tool.id,
      label: `${label} ${presentation.label}`,
      color: presentation.color,
      title: [hostToolDisplayVersion(tool), tool.path ?? tool.detectedPath, tool.detail]
        .filter(Boolean)
        .join(' · ')
    }
  })
  const dependencies = resources.dependencies.map((dependency): HostCapabilityChip => {
    const state =
      dependency.status === 'ready'
        ? environmentUi.available
        : dependency.status === 'unavailable'
          ? environmentUi.unavailable
          : environmentUi.notDetected
    return {
      id: dependency.id,
      label: `${dependency.label} ${state}`,
      color:
        dependency.status === 'ready'
          ? 'success'
          : dependency.status === 'unavailable'
            ? 'warning'
            : 'default',
      title: [dependency.version, dependency.path, dependency.detail].filter(Boolean).join(' · ')
    }
  })
  return [...tools, ...dependencies]
}

export function EnvironmentHostCapabilityChips({
  resources,
  limit = 3
}: {
  resources: ManagedEnvironmentHostResources
  limit?: number
}): React.JSX.Element {
  useUiLanguage()
  const capabilities = hostCapabilityChips(resources)
  const visible = capabilities.slice(0, limit)
  const hidden = capabilities.length - visible.length
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
      {visible.map((capability) => (
        <Chip
          key={capability.id}
          size="small"
          color={capability.color}
          variant="outlined"
          data-phi-host-capability={capability.id}
          label={capability.label}
          title={capability.title || undefined}
        />
      ))}
      {hidden > 0 ? <Chip size="small" variant="outlined" label={`+${hidden}`} /> : null}
    </Stack>
  )
}
