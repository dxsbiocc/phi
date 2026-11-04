import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'

const CopyIcon = PhiIcons.action.copy

export function MemberIdentityCard({
  recipient,
  errorCode,
  onCopy,
  onExport,
  onImport
}: {
  recipient: string | null
  errorCode: string | null
  onCopy: () => void
  onExport: () => void
  onImport: () => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="h6">{teamCopy.memberPublicKey}</Typography>
          <Typography variant="body2" color="text.secondary">
            {teamCopy.memberPublicKeyHint}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {teamCopy.memberPublicKeyUpgradeHint}
          </Typography>
        </Box>
        {errorCode ? (
          <Alert severity="error">
            {errorCode === 'STORE_UNAVAILABLE'
              ? teamCopy.secureStorageUnavailable
              : teamErrorText(errorCode)}
          </Alert>
        ) : null}
        {recipient ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography
              component="code"
              variant="body2"
              sx={{
                flex: 1,
                minWidth: 0,
                overflowWrap: 'anywhere',
                fontFamily: 'var(--font-mono)'
              }}
            >
              {recipient}
            </Typography>
            <Tooltip title={teamCopy.copyPublicKey}>
              <IconButton aria-label={teamCopy.copyPublicKey} onClick={onCopy}>
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ) : null}
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Button variant="outlined" disabled={!recipient} onClick={onExport}>
            {teamCopy.exportMemberBackup}
          </Button>
          <Button variant="outlined" onClick={onImport}>
            {teamCopy.importMemberBackup}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
