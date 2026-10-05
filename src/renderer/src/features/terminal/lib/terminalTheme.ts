import type { ITheme } from '@xterm/xterm'

import type { EffectiveMode } from '../../../theme'
import { MINIMAL_GREY } from '../../../minimalTheme/tokens'

export const TERMINAL_FONT_FAMILY =
  '"SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Monaco, Consolas, monospace'

const DARK_THEME: Readonly<ITheme> = {
  foreground: '#E8E8E8',
  cursor: '#2E9FB3',
  selectionBackground: '#2E9FB366',
  selectionInactiveBackground: '#7E8B8E33',
  black: '#1B1B1B',
  red: '#E8604C',
  green: '#3ABAA4',
  yellow: '#EFC94C',
  blue: '#2E9FB3',
  magenta: '#D66BDF',
  cyan: '#56C7D8',
  white: '#D8DEDF',
  brightBlack: '#707A7C',
  brightRed: '#FF7868',
  brightGreen: '#60D6C1',
  brightYellow: '#FFE078',
  brightBlue: '#63C8DA',
  brightMagenta: '#ED8CF4',
  brightCyan: '#85E3EE',
  brightWhite: '#FFFFFF'
}

const LIGHT_THEME: Readonly<ITheme> = {
  foreground: '#17343A',
  cursor: '#167E93',
  selectionBackground: '#2E9FB34D',
  selectionInactiveBackground: '#4B646926',
  black: '#17343A',
  red: '#B8392C',
  green: '#167D6D',
  yellow: '#8A6800',
  blue: '#176F91',
  magenta: '#983A9E',
  cyan: '#147887',
  white: '#DCE5E7',
  brightBlack: '#5D7074',
  brightRed: '#D94C3E',
  brightGreen: '#219985',
  brightYellow: '#A88000',
  brightBlue: '#218DAF',
  brightMagenta: '#B04AB6',
  brightCyan: '#2097A8',
  brightWhite: '#F6FAFA'
}

export function createTerminalTheme(
  mode: EffectiveMode,
  surfaceBackground = mode === 'dark' ? MINIMAL_GREY[900] : '#FFFFFF'
): ITheme {
  return {
    ...(mode === 'dark' ? DARK_THEME : LIGHT_THEME),
    background: surfaceBackground,
    cursorAccent: surfaceBackground
  }
}
