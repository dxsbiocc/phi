import { Box, Typography } from '@mui/material'
import { parseInputFileReferences } from '../../lib/inputReferences'
import type { ChatMessage } from '../../types'
import { FileReferenceCards } from './FileReferenceCards'

export function ChatUserMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  const parsedMessage = parseInputFileReferences(message.content)

  return (
    <>
      <FileReferenceCards paths={parsedMessage.references} variant="message" />
      {parsedMessage.body ? (
        <Box
          sx={{
            alignSelf: 'flex-end',
            maxWidth: '75%',
            minWidth: 0,
            px: 2,
            py: 1.25,
            bgcolor: 'primary.main',
            color: 'background.default',
            borderRadius: '18px'
          }}
        >
          <Typography
            variant="body1"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              lineHeight: 1.6,
              fontSize: '0.95rem'
            }}
          >
            {parsedMessage.body}
          </Typography>
        </Box>
      ) : null}
    </>
  )
}
