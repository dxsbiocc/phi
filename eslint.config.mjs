import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

const ipcChannelLiteralMessage =
  'Use the channel constant from src/shared/ipcChannels.ts instead of an IPC string literal.'
const ipcCallSelectors = [
  "CallExpression[callee.type='MemberExpression'][callee.object.name='ipcMain'][callee.property.name=/^(handle|on|once|removeHandler)$/]",
  "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.property.name='ipcMain'][callee.property.name=/^(handle|on|once|removeHandler)$/]",
  "CallExpression[callee.type='MemberExpression'][callee.object.name='ipcRenderer'][callee.property.name=/^(invoke|send|on|once|removeListener|removeAllListeners)$/]",
  "CallExpression[callee.type='MemberExpression'][callee.object.name='webContents'][callee.property.name='send']",
  "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.property.name=/^(webContents|sender)$/][callee.property.name='send']",
  "CallExpression[callee.type='MemberExpression'][callee.object.name='renderer'][callee.property.name='send']"
]
const ipcLiteralRestrictions = ipcCallSelectors.flatMap((selector) => [
  { selector: `${selector}[arguments.0.type='Literal']`, message: ipcChannelLiteralMessage },
  {
    selector: `${selector}[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]`,
    message: ipcChannelLiteralMessage
  }
])

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '.omx/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...ipcLiteralRestrictions]
    }
  },
  // Complexity ratchet, part one: the ceiling is reported everywhere so a new
  // offender is visible, and `--max-warnings` in package.json freezes the count
  // so adding one fails the build. Clean directories are promoted to errors below.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 3],
      'max-params': ['warn', 5],
      'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }]
    }
  },
  eslintConfigPrettier
)
