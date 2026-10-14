import { createContext, useContext } from 'react'
import { createChatResourceMatcher } from './chatResourceMentions'

export const ChatResourceMentionsContext = createContext(createChatResourceMatcher([]))

export function useChatResourceMatcher(): ReturnType<typeof createChatResourceMatcher> {
  return useContext(ChatResourceMentionsContext)
}
