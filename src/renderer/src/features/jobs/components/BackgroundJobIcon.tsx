import { GoPackage, GoTerminal, GoUpload } from 'react-icons/go'

import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { PhiIcons } from '../../../icons'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { SidePanelIconTile } from '../../../components/SidePanelIconTile'
import type { LiveBackgroundJob } from '../lib/backgroundJobs'

type JobKind = LiveBackgroundJob['kind']

const iconColors: Record<JobKind, string> = {
  agent: '#7958D4',
  shell: '#607D98',
  wrapper: '#00A98A',
  environment: '#8B69C8',
  connector: '#3C80BC',
  upload: '#3288E8',
  jupyter: '#FFF1E5',
  'notebook-ai': '#FFF1E5',
  plugin: '#4C8F5B'
}

function JobSymbol({ kind }: { kind: JobKind }): React.JSX.Element {
  switch (kind) {
    case 'jupyter':
    case 'notebook-ai':
      return <PhiIcons.file.jupyter size={25} />
    case 'agent':
      return <PhiIcons.entity.agent size={22} />
    case 'wrapper':
      return <PhiIcons.entity.wrapper size={22} />
    case 'shell':
      return <GoTerminal size={22} />
    case 'upload':
      return <GoUpload size={22} />
    case 'connector':
      return <PhiIcons.entity.mcp size={22} />
    case 'plugin':
      return <PhiIcons.entity.plugin size={22} />
    case 'environment':
      return <GoPackage size={22} />
  }
}

/** A plugin job with its own icon shows that icon; every other job shows its kind's symbol. */
export function BackgroundJobIcon({
  kind,
  icon
}: {
  kind: JobKind
  icon?: ResourceIconRef
}): React.JSX.Element {
  if (kind === 'plugin' && icon) {
    return (
      <SidePanelIconTile
        data-phi-background-job-icon={kind}
        backgroundColor={iconColors.plugin}
        sx={{ overflow: 'hidden' }}
      >
        <ResourceIcon icon={icon} kind="plugin" size={36} fallbackSize={22} />
      </SidePanelIconTile>
    )
  }
  return (
    <SidePanelIconTile
      data-phi-background-job-icon={kind}
      backgroundColor={iconColors[kind]}
      foregroundColor={kind === 'jupyter' || kind === 'notebook-ai' ? 'text.primary' : '#fff'}
    >
      <JobSymbol kind={kind} />
    </SidePanelIconTile>
  )
}
