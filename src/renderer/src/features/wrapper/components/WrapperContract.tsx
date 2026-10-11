import { Box, Chip, Stack, Typography } from '@mui/material'

import type {
  WrapperCompositionManifest,
  WrapperCompositionParam
} from '../../../../../shared/wrapperCompositionManifestTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { wrapperParamConstraint } from '../lib/wrapperPackageDetail'
import {
  parseWrapperCompositionId,
  wrapperProviderColor,
  wrapperTierLabel
} from '../lib/wrapperView'

/** The wrapper's identity block: icon, name, canonical id, summary and provider/tier chips. */
export function WrapperIdentity({
  manifest,
  icon,
  children
}: {
  manifest: WrapperCompositionManifest
  icon?: ResourceIconRef
  /** Extra controls shown under the chips. */
  children?: React.ReactNode
}): React.JSX.Element {
  const { provider, tier } = parseWrapperCompositionId(manifest.id)
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Box
        sx={{
          width: 72,
          height: 72,
          borderRadius: 1,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        <ResourceIcon icon={icon} kind="wrapper" size={72} fallbackSize={24} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
          {manifest.name}
        </Typography>
        {/* The canonical id, not the display name above, is what actually
            identifies this wrapper — keep it visible right next to the name. */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: 'var(--font-mono)', display: 'block' }}
        >
          {manifest.id}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {manifest.summary}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" color={wrapperProviderColor(provider)} label={provider} />
          <Chip size="small" variant="outlined" label={wrapperTierLabel(tier)} />
        </Stack>
        {children ? <Box sx={{ mt: 1.5 }}>{children}</Box> : null}
      </Box>
    </Stack>
  )
}

function ParamLine({
  name,
  param
}: {
  name: string
  param: WrapperCompositionParam
}): React.JSX.Element {
  const constraint = wrapperParamConstraint(param)
  return (
    <Typography variant="body2" color="text.secondary">
      {name} ({param.type}
      {param.required ? '，必填' : ''}){param.description ? ` — ${param.description}` : ''}
      {constraint ? `（${constraint}）` : ''}
    </Typography>
  )
}

/** The wrapper's declared contract: inputs, options and outputs. */
export function WrapperContractSections({
  manifest
}: {
  manifest: WrapperCompositionManifest
}): React.JSX.Element {
  const params = Object.entries(manifest.params)
  const inputs = params.filter(([, param]) => param.kind === 'input')
  const options = params.filter(([, param]) => param.kind === 'option')
  const outputs = Object.entries(manifest.outputs)
  return (
    <>
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        输入
      </Typography>
      {inputs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          无
        </Typography>
      ) : (
        inputs.map(([key, param]) => <ParamLine key={key} name={key} param={param} />)
      )}

      {options.length > 0 && (
        <>
          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            选项
          </Typography>
          {options.map(([key, param]) => (
            <ParamLine key={key} name={key} param={param} />
          ))}
        </>
      )}

      <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
        输出
      </Typography>
      {outputs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          无
        </Typography>
      ) : (
        outputs.map(([key, output]) => (
          <Typography key={key} variant="body2" color="text.secondary">
            {key} — {output.path}
            {output.primary ? '（主要）' : ''}
          </Typography>
        ))
      )}
    </>
  )
}
