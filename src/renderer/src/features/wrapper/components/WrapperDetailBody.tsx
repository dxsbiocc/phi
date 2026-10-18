import { useUiLanguage } from '../../../lib/i18n'
import { wrapperCopy } from '../lib/wrapperCopy'
import { useMemo } from 'react'
import { Box, Chip, Divider, Link, Stack, Typography } from '@mui/material'
import { type Theme } from '@mui/material/styles'

import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../../../../../shared/wrapperModuleDetailsTypes'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { highlightLine } from '../../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../../lib/syntaxTheme'
import type { WrapperFlowGraph } from '../lib/wrapperFlow'
import { WrapperContractSections, WrapperIdentity } from './WrapperContract'
import { WrapperFlowDiagram } from './WrapperFlowDiagram'

/**
 * Renders raw text with this app's own YAML tokenizer (`syntaxHighlight.ts`)
 * — not a parsed/summarized view: `environment.yml` shows exactly what's on
 * disk, whatever fields it actually has, rather than only the
 * `channels`/`dependencies` shape this component happened to expect.
 */
function WrapperYamlBlock({ yaml }: { yaml: string }): React.JSX.Element {
  useUiLanguage()
  const lines = useMemo(() => yaml.replace(/\n$/, '').split('\n'), [yaml])
  return (
    <Box
      sx={{
        bgcolor: 'background.default',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        lineHeight: 1.6
      }}
    >
      {lines.map((line, index) => (
        <Box key={index} sx={{ whiteSpace: 'pre' }}>
          {highlightLine(line, 'yaml').map((token, tokenIndex) => (
            <Box
              key={tokenIndex}
              component="span"
              sx={{ color: (theme: Theme) => syntaxTokenColor(theme, token.kind) }}
            >
              {token.value}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Everything the wrapper page and the catalog preview share: identity, structure, contract and
 * module metadata. Page-specific parts (execution target, run history) come in as slots.
 */
export function WrapperDetailBody({
  manifest,
  icon,
  graph,
  moduleDetails,
  extraChips,
  identityExtras,
  afterIdentity,
  children
}: {
  manifest: WrapperCompositionManifest
  icon?: ResourceIconRef
  graph: WrapperFlowGraph | undefined
  moduleDetails: WrapperModuleDetails | undefined
  /** More chips in the identity chip row. */
  extraChips?: React.ReactNode
  /** Controls under the identity chips. */
  identityExtras?: React.ReactNode
  /** Content right below the identity block. */
  afterIdentity?: React.ReactNode
  /** Content after the metadata, e.g. run history. */
  children?: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      <WrapperIdentity manifest={manifest} icon={icon} extraChips={extraChips}>
        {identityExtras}
      </WrapperIdentity>
      {afterIdentity}

      <Divider sx={{ my: 4 }} />

      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
        {wrapperCopy.structure}
      </Typography>
      {graph && (
        // Keyed by wrapper id so switching wrappers remounts the whole
        // ReactFlow instance instead of reusing it with a new `graph`
        // prop — `fitView` only runs once on mount, so reusing the
        // instance left the old pan/zoom transform in place for a
        // completely different graph, which for a same-size-or-smaller
        // one meant the new nodes could land entirely outside the
        // visible viewport (an apparently blank diagram).
        <WrapperFlowDiagram
          key={manifest.id}
          graph={graph}
          height={graph.nodes.length > 8 ? 480 : 180}
        />
      )}

      <Divider sx={{ my: 4 }} />

      <WrapperContractSections manifest={manifest} />

      {moduleDetails?.meta && (
        <>
          <Divider sx={{ my: 4 }} />
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
            {wrapperCopy.about}
          </Typography>
          {moduleDetails.meta.description && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {moduleDetails.meta.description}
            </Typography>
          )}
          {moduleDetails.meta.keywords && moduleDetails.meta.keywords.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
              {moduleDetails.meta.keywords.map((keyword) => (
                <Chip key={keyword} size="small" variant="outlined" label={keyword} />
              ))}
            </Stack>
          )}
          {moduleDetails.meta.tools?.map((tool) => (
            <Box key={tool.name} sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {tool.name}
              </Typography>
              {tool.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  {tool.description}
                </Typography>
              )}
              <Stack
                direction="row"
                spacing={1.5}
                sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}
              >
                {tool.licence?.map((licence) => (
                  <Chip key={licence} size="small" label={licence} />
                ))}
                {tool.homepage && (
                  <Link
                    href={tool.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                  >
                    {wrapperCopy.homepage}
                  </Link>
                )}
                {tool.documentation && (
                  <Link
                    href={tool.documentation}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                  >
                    {wrapperCopy.documentation}
                  </Link>
                )}
                {tool.doi && (
                  <Link
                    href={`https://doi.org/${tool.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                  >
                    DOI
                  </Link>
                )}
              </Stack>
            </Box>
          ))}
          {moduleDetails.meta.authors && moduleDetails.meta.authors.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {wrapperCopy.authors(moduleDetails.meta.authors)}
            </Typography>
          )}
        </>
      )}

      {moduleDetails?.environment && (
        <>
          <Divider sx={{ my: 4 }} />
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
            {wrapperCopy.environment}
          </Typography>
          <WrapperYamlBlock yaml={moduleDetails.environment} />
        </>
      )}

      {children}
    </>
  )
}
