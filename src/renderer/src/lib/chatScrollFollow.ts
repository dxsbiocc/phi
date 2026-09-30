// Reading earlier messages should keep the viewport still. New tokens render
// below the fold; only a conversation switch, a message the user just sent,
// or an already-followed tail moves the scroll position.
export function shouldFollowLatestContent(input: {
  stuckToBottom: boolean
  replacedMessages: boolean
  userSubmittedMessage: boolean
}): boolean {
  return input.replacedMessages || input.userSubmittedMessage || input.stuckToBottom
}

// Short conversations render every row at its natural height, so storing
// measured heights only causes another render. Long conversations need heights
// for the rows currently in the window. Rows below the fold, including the
// streaming tail while the reader is looking upward, stay out of that state.
export function shouldCommitChatRowHeight(input: {
  virtualizationEnabled: boolean
  rowInWindow: boolean
}): boolean {
  return input.virtualizationEnabled && input.rowInWindow
}
