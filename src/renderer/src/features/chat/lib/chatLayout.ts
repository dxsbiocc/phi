import { chatContentMaxWidth } from '../../../layout'

export type ChatPlacement = 'tab' | 'sidebar'

export function chatLayoutVariables(placement: ChatPlacement): Record<string, string> {
  return {
    '--phi-chat-gutter': placement === 'tab' ? '32px' : '16px',
    '--phi-chat-compact-gutter': placement === 'tab' ? '16px' : '8px',
    // Reduce the tab column cap too, so wider panes get visibly more side space.
    '--phi-chat-content-max-width': `${placement === 'tab' ? chatContentMaxWidth - 64 : chatContentMaxWidth}px`
  }
}

export const chatComposerLayoutSx = {
  px: 'var(--phi-chat-gutter)',
  pt: 1.5,
  pb: 2,
  flexShrink: 0,
  '@container phi-chat (max-width: 560px)': {
    px: 'var(--phi-chat-compact-gutter)',
    pt: 1,
    pb: 1
  }
} as const
