import { Box, Chip, Link, List, ListItem, Stack, Typography } from '@mui/material'

import type { GithubProjectHint } from '../../../../../shared/githubSourceTypes'

export function McpProjectHintPanel({ hint }: { hint: GithubProjectHint }): React.JSX.Element {
  const facts = [
    hint.entry ? `入口 ${hint.entry}` : undefined,
    hint.nodeEngine ? `Node ${hint.nodeEngine}` : undefined,
    hint.needsBuild ? '需要构建' : undefined,
    hint.npm ? '已发布到 npm' : undefined
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
            查看 README ↗
          </Link>
        ) : null}
        {hint.npm ? (
          <Link
            href={`https://www.npmjs.com/package/${hint.npm.name}`}
            target="_blank"
            rel="noreferrer"
            sx={{ alignSelf: 'flex-start' }}
          >
            在 npmjs.com 核对发布者 ↗
          </Link>
        ) : null}
      </Stack>
    </Box>
  )
}
