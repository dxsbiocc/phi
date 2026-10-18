import { getUiLanguage } from '../src/renderer/src/lib/i18n'
import { chatCopy } from '../src/renderer/src/features/chat/lib/chatCopy'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import type { KeyboardEvent, ReactElement, RefObject } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import * as inputReferences from '../src/renderer/src/lib/inputReferences'
import type { useInputInvocationReferenceMenu } from '../src/renderer/src/components/chat/useInputInvocationReferenceMenu'
import type { InputInvocationReferenceMenu } from '../src/renderer/src/components/chat/InputInvocationReferenceMenu'
import type { PromptAgentSummary, SkillSummary } from '../src/renderer/src/types'

const chatComponents = 'src/renderer/src/components/chat/'
type MenuOptions = Parameters<typeof useInputInvocationReferenceMenu>[0]
type MenuResult = ReturnType<typeof useInputInvocationReferenceMenu>

function loadModule(path: string, imports: Record<string, unknown>): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> }
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier.endsWith('/chatCopy')) return { chatCopy }
      if (specifier.endsWith('/i18n')) return { useUiLanguage: getUiLanguage }
      assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`)
      return imports[specifier]
    }
  })
  return module.exports
}

/** Run the production hook through input and keyboard updates without a DOM dependency. */
function menuHarness(initial: Partial<MenuOptions> = {}): {
  read: () => MenuResult
  change: (input: string) => MenuResult
  key: (key: string, composing?: boolean) => MenuResult
  update: (options: Partial<MenuOptions>) => MenuResult
  inserted: Array<{ body: string; reference: string; cursor: number }>
} {
  const slots: unknown[] = []
  let cursor = 0
  const inserted: Array<{ body: string; reference: string; cursor: number }> = []
  let options: MenuOptions = {
    input: '$',
    skills: [],
    promptAgents: [],
    onInsertReference: (body, reference, position) =>
      inserted.push({ body, reference, cursor: position }),
    ...initial
  }
  const loaded = loadModule(`${chatComponents}useInputInvocationReferenceMenu.ts`, {
    react: {
      useState<T>(initialValue: T | (() => T)): [T, (next: T | ((value: T) => T)) => void] {
        const index = cursor++
        if (!(index in slots)) {
          slots[index] =
            typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
        }
        return [
          slots[index] as T,
          (next) => {
            slots[index] =
              typeof next === 'function' ? (next as (value: T) => T)(slots[index] as T) : next
          }
        ]
      },
      useMemo: <T>(factory: () => T): T => factory(),
      useCallback: <T>(callback: T): T => callback
    },
    '../../lib/inputReferences': inputReferences
  })
  const hook = loaded.useInputInvocationReferenceMenu as typeof useInputInvocationReferenceMenu
  const read = (): MenuResult => {
    cursor = 0
    return hook(options)
  }
  return {
    read,
    change(input): MenuResult {
      options = { ...options, input }
      read().onInputChanged({ selectionStart: input.length } as HTMLTextAreaElement)
      return read()
    },
    key(key, composing = false): MenuResult {
      read().onKeyDown({
        key,
        nativeEvent: { isComposing: composing },
        preventDefault: () => undefined
      } as KeyboardEvent<HTMLElement>)
      return read()
    },
    update(next): MenuResult {
      options = { ...options, ...next }
      return read()
    },
    inserted
  }
}

function skill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: `/skills/${name}/SKILL.md`,
    filePath: `/skills/${name}/SKILL.md`,
    name,
    description: `${name} description`,
    source: 'user',
    scope: 'user',
    sourceCategory: 'user',
    sourceCategoryLabel: '我的',
    enabled: true,
    globalEnabled: true,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: false,
    ...overrides
  }
}

const manySkills = Array.from({ length: 24 }, (_, index) =>
  skill(`skill-${String(index).padStart(2, '0')}`)
)

test('skill shortcuts collapse identical invocations from different source paths', () => {
  const first = skill('ask-matt', { icon: { key: 'first' } })
  const duplicate = skill('ask-matt', {
    id: '/other/ask-matt/SKILL.md',
    filePath: '/other/ask-matt/SKILL.md',
    icon: { key: 'duplicate' }
  })
  const harness = menuHarness({
    skills: [skill('ask-matt', { disabled: true }), first, duplicate, skill('code-review')]
  })
  const candidates = harness.read().menuState!.candidates
  assert.deepEqual(
    Array.from(candidates, (candidate) => candidate.referenceText),
    ['$ask-matt', '$code-review']
  )
  assert.equal(candidates[0].icon?.key, 'first')
  harness.key('Enter')
  assert.deepEqual(harness.inserted, [{ body: '', reference: '$ask-matt', cursor: 0 }])
})

test('all enabled skills remain reachable beyond the first eight results', () => {
  const harness = menuHarness({ skills: [...manySkills, skill('disabled', { disabled: true })] })
  assert.equal(harness.read().menuState!.candidates.length, manySkills.length)
  for (let index = 0; index < 20; index++) harness.key('ArrowDown')
  assert.equal(harness.read().highlightedIndex, 20)
  harness.key('Tab')
  assert.equal(harness.inserted[0].reference, '$skill-20')
})

test('search covers the entire skill catalog and ranks prefixes first', () => {
  const harness = menuHarness({ skills: [...manySkills, skill('my-skill-23')] })
  const state = harness.change('$SKILL-23')
  assert.deepEqual(
    Array.from(state.menuState!.candidates, (candidate) => candidate.name),
    ['skill-23', 'my-skill-23']
  )
  assert.equal(state.highlightedIndex, 0)
})

test('arrow navigation wraps, Escape dismisses and IME leaves the menu alone', () => {
  const harness = menuHarness({ skills: manySkills })
  assert.equal(harness.key('ArrowUp').highlightedIndex, manySkills.length - 1)
  assert.equal(harness.key('ArrowDown').highlightedIndex, 0)
  assert.equal(harness.key('ArrowDown', true).highlightedIndex, 0)
  assert.equal(harness.key('Escape').menuState, null)
  assert.ok(harness.change('$skill').menuState)
})

test('successive arrow events preserve navigation before React renders again', () => {
  const harness = menuHarness({ skills: manySkills })
  const { onKeyDown } = harness.read()
  const event = {
    key: 'ArrowDown',
    nativeEvent: { isComposing: false },
    preventDefault: () => undefined
  } as KeyboardEvent<HTMLElement>
  onKeyDown(event)
  onKeyDown(event)
  assert.equal(harness.read().highlightedIndex, 2)
})

test('catalog refresh keeps the highlighted index within the remaining results', () => {
  const harness = menuHarness({ skills: manySkills })
  for (let index = 0; index < 5; index++) harness.key('ArrowDown')
  const state = harness.update({ skills: manySkills.slice(0, 2) })
  assert.equal(state.highlightedIndex, 1)
  harness.key('Enter')
  assert.equal(harness.inserted[0].reference, '$skill-01')
})

test('agent shortcuts also show the full list and preserve distinct agent identities', () => {
  const agents: PromptAgentSummary[] = Array.from({ length: 12 }, (_, index) => ({
    id: `agent-${index}`,
    name: 'Reviewer',
    description: `Agent ${index}`,
    source: 'user',
    trigger: '/prompts:Reviewer',
    ...(index === 0 ? { available: false } : {})
  }))
  const harness = menuHarness({ input: '/agent:', promptAgents: agents })
  assert.equal(harness.read().menuState!.candidates.length, agents.length)
  harness.key('Enter')
  assert.equal(harness.inserted.length, 0)
})

test('the invocation menu scrolls the selected option into view after highlight changes', () => {
  const effects: Array<() => void> = []
  const menuRef: { current: unknown } = { current: null }
  let scrolls = 0
  const loaded = loadModule(`${chatComponents}InputInvocationReferenceMenu.tsx`, {
    react: {
      useRef: () => menuRef,
      useEffect: (effect: () => void) => effects.push(effect)
    },
    'react/jsx-runtime': jsxRuntime,
    '@mui/material': Object.fromEntries(
      ['Box', 'ListItemButton', 'ListItemIcon', 'ListItemText', 'Paper', 'Typography'].map(
        (name) => [name, name]
      )
    ),
    '../../features/agent/AgentTrustPanel': {
      PromptAgentStatus: 'AgentStatus',
      RemoteAgentTrustControl: 'TrustControl'
    },
    '../ResourceIcon': { ResourceIcon: 'ResourceIcon' }
  })
  const Menu = loaded.InputInvocationReferenceMenu as typeof InputInvocationReferenceMenu
  const harness = menuHarness({ skills: manySkills })
  const render = (highlightedIndex: number): void => {
    const element = Menu({
      state: harness.read().menuState!,
      highlightedIndex,
      onHighlight: () => undefined,
      onSelect: () => undefined
    }) as ReactElement<{ ref?: RefObject<HTMLDivElement> }>
    if (element.props.ref) {
      menuRef.current = {
        querySelector: (selector: string) => {
          assert.equal(selector, '[aria-selected="true"]')
          return {
            scrollIntoView: (options: ScrollIntoViewOptions) => {
              assert.equal(options.block, 'nearest')
              scrolls++
            }
          }
        }
      }
    }
    for (const effect of effects.splice(0)) effect()
  }
  render(0)
  render(20)
  assert.equal(scrolls, 2, 'initial and updated highlights must stay visible')
})
