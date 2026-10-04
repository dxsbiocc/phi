import assert from 'node:assert/strict'
import test from 'node:test'
import { windowChromeLayout } from '../src/renderer/src/lib/windowChromeLayout'

test('window chrome layout covers every platform, sidebar, and fullscreen combination', () => {
  const cases = [
    {
      input: { isMac: false, sidebarOpen: false, fullscreen: false },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 0,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 0,
        mainColumnTitlebarInset: 0
      }
    },
    {
      input: { isMac: false, sidebarOpen: false, fullscreen: true },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 0,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 0,
        mainColumnTitlebarInset: 0
      }
    },
    {
      input: { isMac: false, sidebarOpen: true, fullscreen: false },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 0,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 0,
        mainColumnTitlebarInset: 0
      }
    },
    {
      input: { isMac: false, sidebarOpen: true, fullscreen: true },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 0,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 0,
        mainColumnTitlebarInset: 0
      }
    },
    {
      input: { isMac: true, sidebarOpen: false, fullscreen: false },
      expected: {
        showMacWindowControls: true,
        topLeftChromeInset: 14,
        topLeftChromeGap: 18,
        titlebarLeadingReserve: 220,
        mainColumnTitlebarInset: 172
      }
    },
    {
      input: { isMac: true, sidebarOpen: false, fullscreen: true },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 14,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 144,
        mainColumnTitlebarInset: 96
      }
    },
    {
      input: { isMac: true, sidebarOpen: true, fullscreen: false },
      expected: {
        showMacWindowControls: true,
        topLeftChromeInset: 14,
        topLeftChromeGap: 18,
        titlebarLeadingReserve: 220,
        mainColumnTitlebarInset: 0
      }
    },
    {
      input: { isMac: true, sidebarOpen: true, fullscreen: true },
      expected: {
        showMacWindowControls: false,
        topLeftChromeInset: 14,
        topLeftChromeGap: 0,
        titlebarLeadingReserve: 144,
        mainColumnTitlebarInset: 0
      }
    }
  ] as const

  for (const { input, expected } of cases) {
    assert.deepEqual(windowChromeLayout(input), expected)
  }
})
