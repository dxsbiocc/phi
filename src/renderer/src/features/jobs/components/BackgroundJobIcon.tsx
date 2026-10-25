import { Box } from '@mui/material'
import { GoPackage, GoTerminal, GoUpload } from 'react-icons/go'

import { PhiIcons } from '../../../icons'
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
  'notebook-ai': '#FFF1E5'
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
    case 'environment':
      return <GoPackage size={22} />
  }
}

export function BackgroundJobIcon({ kind }: { kind: JobKind }): React.JSX.Element {
  return (
    <Box
      aria-hidden
      data-phi-background-job-icon={kind}
      sx={{
        width: 36,
        height: 36,
        borderRadius: 1.5,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        bgcolor: iconColors[kind],
        color: kind === 'jupyter' || kind === 'notebook-ai' ? 'text.primary' : '#fff'
      }}
    >
      <JobSymbol kind={kind} />
    </Box>
  )
}
