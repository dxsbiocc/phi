import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { ThinkingOrb } from '../src/renderer/src/features/chat/components/ThinkingOrb'
import { FacetBloomLoader } from '../src/renderer/src/features/plan/components/FacetBloomLoader'
import {
  PlanTimelineHeader,
  PlanTimelineStep
} from '../src/renderer/src/features/plan/components/PlanTimeline'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

function themed(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('facet bloom renders six petals as a labelled status', () => {
  const markup = themed(createElement(FacetBloomLoader, { label: '运行中' }))

  assert.match(markup, /role="status"/)
  assert.match(markup, /aria-label="运行中"/)
  assert.equal(markup.match(/data-phi-facet-bloom-petal="true"/g)?.length, 6)
})

test('thinking orb loops its fixed eye motion only while active and never uses canvas', () => {
  const active = themed(createElement(ThinkingOrb, { size: 16, active: true }))
  const inactive = themed(createElement(ThinkingOrb, { size: 16, active: false }))

  assert.match(active, /data-phi-thinking-orb-active="true"/)
  assert.match(active, /phi-thinking-orb-look/)
  assert.match(active, /animation:/)
  assert.doesNotMatch(active, /<canvas/)
  assert.match(inactive, /data-phi-thinking-orb-active="false"/)
  assert.match(inactive, /animation:none/)
  assert.doesNotMatch(inactive, /phi-thinking-orb-look/)
  assert.doesNotMatch(inactive, /<canvas/)
})

test('running plan title blooms while its step keeps the spinner icon', () => {
  setUiLanguage('en')
  const header = themed(
    createElement(PlanTimelineHeader, {
      tone: 'active',
      title: 'Ship the renderer loop',
      subtitle: '1/2 completed · Running'
    })
  )
  const step = themed(
    createElement(PlanTimelineStep, {
      isLast: true,
      tone: 'active',
      index: 0,
      title: 'Implement panel'
    })
  )

  assert.match(header, /data-phi-facet-bloom="true"/)
  assert.match(header, /aria-label="Running"/)
  assert.doesNotMatch(header, /phi-plan-spin-icon/)
  assert.match(step, /phi-plan-spin-icon/)
  assert.doesNotMatch(step, /data-phi-facet-bloom/)
})

test('completed plan title does not render the bloom', () => {
  setUiLanguage('en')
  const header = themed(
    createElement(PlanTimelineHeader, {
      tone: 'success',
      title: 'Ship the renderer loop',
      subtitle: '2/2 completed · Completed'
    })
  )

  assert.doesNotMatch(header, /data-phi-facet-bloom/)
  assert.doesNotMatch(header, /role="status"/)
})
