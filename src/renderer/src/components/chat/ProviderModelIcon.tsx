import { Box } from '@mui/material'
import type { IconType } from 'react-icons'
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
import { PhiIcons } from '../../icons'
import { COMPOSER_ICON_SIZE } from './composerControlStyles'

const PsychologyIcon = PhiIcons.state.thinking

type ProviderIconMeta = {
  key: string
  label: string
  color: string
  Icon?: IconType
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
    color: 'text.secondary'
  }
}

export function ProviderModelIcon({
  providerId,
  disabled = false
}: {
  providerId?: string
  disabled?: boolean
}): React.JSX.Element {
  const meta = providerIconMeta(providerId)
  const color = disabled ? 'action.disabled' : meta.color

  if (meta.Icon) {
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
          fontSize: COMPOSER_ICON_SIZE,
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

  return (
    <PsychologyIcon
      data-phi-provider-icon={meta.key}
      aria-label={meta.label}
      htmlColor={undefined}
      size={COMPOSER_ICON_SIZE}
      sx={{ color }}
    />
  )
}
