import { Alert, Button } from '@mui/material'

import { useUiLanguage } from '../../../lib/i18n'
import { chatCopy } from '../lib/chatCopy'

export function LegacyRemoteSessionNotice({
  onCreateSession
}: {
  onCreateSession?: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Alert
      severity="info"
      variant="outlined"
      data-phi-legacy-remote-session="true"
      action={
        <Button size="small" disabled={!onCreateSession} onClick={onCreateSession}>
          {chatCopy.startANewSessionInThisProject}
        </Button>
      }
      sx={{ width: '100%', alignItems: 'center' }}
    >
      {chatCopy.thisSessionWasCreatedByTheLegacyRemoteRuntimeAndCannotContinue}
    </Alert>
  )
}
