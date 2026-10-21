import { Box } from '@mui/material'
import type { IconBaseProps, IconType } from 'react-icons'
import {
  SiAnthropic,
  SiClaude,
  SiCursor,
  SiDeepseek,
  SiGithubcopilot,
  SiGoogle,
  SiGooglegemini,
  SiMetaai,
  SiMistralai,
  SiMoonshotai,
  SiOllama,
  SiOpenrouter,
  SiPerplexity,
  SiQwen,
  SiX
} from 'react-icons/si'
import { TbBrandOpenai } from 'react-icons/tb'
import { GoDependabot } from 'react-icons/go'
import { COMPOSER_ICON_SIZE } from './composerControlStyles'

/** Home mark from typesafe.ai, kept monochrome so it follows the surrounding text color. */
function TypeSafeIcon({
  size = '1em',
  color = 'currentColor',
  ...props
}: IconBaseProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16.487 24" width={size} height={size} fill={color} aria-hidden {...props}>
      <path
        fill="currentColor"
        d="M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z"
      />
    </svg>
  )
}

type ProviderIconMeta = {
  key: string
  label: string
  color: string
  Icon: IconType
}

const PROVIDER_ICON_RULES: Array<ProviderIconMeta & { matches: string[] }> = [
  {
    key: 'openai',
    label: 'OpenAI',
    color: '#10A37F',
    Icon: TbBrandOpenai,
    matches: ['openai', 'codex', 'chatgpt']
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    color: '#4D6BFE',
    Icon: SiDeepseek,
    matches: ['deepseek']
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    color: '#6D5DF6',
    Icon: SiMoonshotai,
    matches: ['moonshot', 'kimi']
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    color: '#D97757',
    Icon: SiAnthropic,
    matches: ['anthropic']
  },
  {
    key: 'claude',
    label: 'Claude',
    color: '#D97757',
    Icon: SiClaude,
    matches: ['claude']
  },
  {
    key: 'gemini',
    label: 'Gemini',
    color: '#4285F4',
    Icon: SiGooglegemini,
    matches: ['gemini']
  },
  {
    key: 'google',
    label: 'Google',
    color: '#4285F4',
    Icon: SiGoogle,
    matches: ['google']
  },
  {
    key: 'qwen',
    label: 'Qwen',
    color: '#615CED',
    Icon: SiQwen,
    matches: ['qwen', 'dashscope', 'alibaba']
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    color: '#6C5CE7',
    Icon: SiOpenrouter,
    matches: ['openrouter']
  },
  {
    key: 'ollama',
    label: 'Ollama',
    color: '#111827',
    Icon: SiOllama,
    matches: ['ollama']
  },
  {
    key: 'mistral',
    label: 'Mistral',
    color: '#FA520F',
    Icon: SiMistralai,
    matches: ['mistral']
  },
  {
    key: 'meta',
    label: 'Meta',
    color: '#0668E1',
    Icon: SiMetaai,
    matches: ['meta', 'llama']
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    color: '#1FB8CD',
    Icon: SiPerplexity,
    matches: ['perplexity']
  },
  {
    key: 'xai',
    label: 'xAI',
    color: '#111827',
    Icon: SiX,
    matches: ['xai', 'grok']
  },
  {
    key: 'cursor',
    label: 'Cursor',
    color: 'text.primary',
    Icon: SiCursor,
    matches: ['cursor']
  },
  {
    key: 'typesafe',
    label: 'TypeSafe',
    color: 'text.primary',
    Icon: TypeSafeIcon,
    matches: ['typesafe']
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot',
    color: '#6E5494',
    Icon: SiGithubcopilot,
    matches: ['copilot', 'github']
  }
]

function providerIconMeta(providerId?: string): ProviderIconMeta {
  const normalizedProviderId = providerId?.toLowerCase() ?? ''
  const matched = PROVIDER_ICON_RULES.find((rule) =>
    rule.matches.some((match) => normalizedProviderId.includes(match))
  )
  if (matched) {
    return {
      key: matched.key,
      label: matched.label,
      color: matched.color,
      Icon: matched.Icon
    }
  }
  return {
    key: 'generic',
    label: 'Model Provider',
    color: 'text.secondary',
    Icon: GoDependabot
  }
}

export function ProviderModelIcon({
  providerId,
  disabled = false,
  size = COMPOSER_ICON_SIZE
}: {
  providerId?: string
  disabled?: boolean
  size?: number
}): React.JSX.Element {
  const meta = providerIconMeta(providerId)
  const color = disabled ? 'action.disabled' : meta.color
  const BrandIcon = meta.Icon

  return (
    <Box
      component="span"
      data-phi-provider-icon={meta.key}
      aria-label={meta.label}
      title={meta.label}
      sx={{
        alignItems: 'center',
        color,
        display: 'inline-flex',
        flexShrink: 0,
        fontSize: size,
        height: '1em',
        justifyContent: 'center',
        lineHeight: 0,
        width: '1em'
      }}
    >
      <BrandIcon color="currentColor" focusable="false" size="1em" />
    </Box>
  )
}
