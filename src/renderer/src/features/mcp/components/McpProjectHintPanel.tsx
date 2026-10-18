import { useUiLanguage } from '../../../lib/i18n'
import { connectorCopy } from '../lib/connectorCopy'
import { Box, Chip, Link, List, ListItem, Stack, Typography } from '@mui/material'

import type { GithubProjectHint } from '../../../../../shared/githubSourceTypes'

export function McpProjectHintPanel({ hint }: { hint: GithubProjectHint }): React.JSX.Element {
  useUiLanguage()

  const facts = [
    hint.entry ? connectorCopy.entryPoint(hint.entry) : undefined,
    hint.nodeEngine ? `Node ${hint.nodeEngine}` : undefined,
    hint.needsBuild ? connectorCopy.buildRequired : undefined,
    hint.npm ? connectorCopy.publishedNpm : undefined
  ].filter((fact): fact is string => Boolean(fact))

  return (
    <Box
      role="status"
      sx={{
        border: 1,
        borderColor: 'info.main',
        borderRadius: 2,
        bgcolor: 'action.hover',
        p: 2
      }}
    >
      <Stack spacing={1.5}>
        <Typography sx={{ fontWeight: 700 }}>{hint.summary}</Typography>
        {facts.length > 0 ? (
          <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {facts.map((fact) => (
              <Chip key={fact} size="small" variant="outlined" label={fact} />
            ))}
          </Stack>
        ) : null}
        {hint.notices.length > 0 ? (
          <List dense disablePadding sx={{ listStyleType: 'disc', pl: 2.5 }}>
            {hint.notices.map((notice) => (
              <ListItem key={notice} disableGutters sx={{ display: 'list-item', py: 0.25 }}>
                <Typography variant="body2">{notice}</Typography>
              </ListItem>
            ))}
          </List>
        ) : null}
        {hint.readmeUrl ? (
          <Link
            href={hint.readmeUrl}
            target="_blank"
            rel="noreferrer"
            sx={{ alignSelf: 'flex-start' }}
          >
            {connectorCopy.viewReadme}
          </Link>
        ) : null}
        {hint.npm ? (
          <Link
            href={`https://www.npmjs.com/package/${hint.npm.name}`}
            target="_blank"
            rel="noreferrer"
            sx={{ alignSelf: 'flex-start' }}
          >
            {connectorCopy.verifyNpmPublisher}
          </Link>
        ) : null}
      </Stack>
    </Box>
  )
}
