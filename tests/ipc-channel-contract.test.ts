import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { ALL_IPC_CHANNELS, IPC, type IpcChannel } from '../src/shared/ipcChannels'

const MAIN_ROOT = join(process.cwd(), 'src/main')
const PRELOAD_PATH = join(process.cwd(), 'src/preload/index.ts')

// Keep this allowlist narrow. Every entry must explain why a deliberately one-sided
// request has no peer; push events do not belong here because they are not requests.
const REQUEST_CHANNEL_ALLOWLIST = new Map<IpcChannel, string>([])

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function ipcReference(node: ts.Node | undefined): string | null {
  if (
    !node ||
    !ts.isPropertyAccessExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== 'IPC' ||
    !ts.isIdentifier(node.expression.name) ||
    !ts.isIdentifier(node.name)
  ) {
    return null
  }
  return `IPC.${node.expression.name.text}.${node.name.text}`
}

function increment(counts: Map<string, number>, reference: string): void {
  counts.set(reference, (counts.get(reference) ?? 0) + 1)
}

function preloadRequestReferences(): Map<string, number> {
  const syntax = sourceFile(PRELOAD_PATH)
  const counts = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(syntax) === 'ipcRenderer' &&
      node.expression.name.text === 'invoke'
    ) {
      const reference = ipcReference(node.arguments[0])
      if (reference) increment(counts, reference)
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  return counts
}

function indirectRegistrationReferences(node: ts.ForOfStatement): string[] {
  const declaration = node.initializer.declarations[0]
  const firstBinding =
    declaration && ts.isArrayBindingPattern(declaration.name)
      ? declaration.name.elements[0]
      : undefined
  if (!firstBinding || !ts.isBindingElement(firstBinding) || !ts.isIdentifier(firstBinding.name)) {
    return []
  }
  const channelVariable = firstBinding.name.text
  let registersVariable = false
  const findRegistration = (candidate: ts.Node): void => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === 'handle' &&
      ts.isIdentifier(candidate.arguments[0]) &&
      candidate.arguments[0].text === channelVariable
    ) {
      registersVariable = true
    }
    ts.forEachChild(candidate, findRegistration)
  }
  findRegistration(node.statement)
  if (!registersVariable) return []

  const references: string[] = []
  const collectReferences = (candidate: ts.Node): void => {
    const reference = ipcReference(candidate)
    if (reference) references.push(reference)
    else ts.forEachChild(candidate, collectReferences)
  }
  collectReferences(node.expression)
  return references
}

function mainRequestReferences(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const path of sourceFiles(MAIN_ROOT)) {
    const syntax = sourceFile(path)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'handle' &&
        /(?:^|\.)ipcMain$/u.test(node.expression.expression.getText(syntax))
      ) {
        const reference = ipcReference(node.arguments[0])
        if (reference) increment(counts, reference)
      } else if (ts.isForOfStatement(node)) {
        for (const reference of indirectRegistrationReferences(node)) increment(counts, reference)
      }
      ts.forEachChild(node, visit)
    }
    visit(syntax)
  }
  return counts
}

function ipcReferenceValues(): Map<string, IpcChannel> {
  const references = new Map<string, IpcChannel>()
  for (const [domainName, domain] of Object.entries(IPC)) {
    for (const [channelName, channel] of Object.entries(domain)) {
      references.set(`IPC.${domainName}.${channelName}`, channel as IpcChannel)
    }
  }
  return references
}

function literalChannelViolations(): string[] {
  const paths = [...sourceFiles(MAIN_ROOT), PRELOAD_PATH]
  const violations: string[] = []
  for (const path of paths) {
    const syntax = sourceFile(path)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const argument = node.arguments[0]
        const isLiteral =
          argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        if (isLiteral) {
          const base = node.expression.expression.getText(syntax)
          const method = node.expression.name.text
          const targetsMain =
            /(?:^|\.)ipcMain$/u.test(base) &&
            ['handle', 'on', 'once', 'removeHandler'].includes(method)
          const targetsRenderer =
            base === 'ipcRenderer' &&
            ['invoke', 'send', 'on', 'once', 'removeListener', 'removeAllListeners'].includes(
              method
            )
          const targetsWebContents =
            method === 'send' &&
            (base === 'webContents' ||
              base.endsWith('.webContents') ||
              base.endsWith('.sender') ||
              base === 'renderer')
          if (targetsMain || targetsRenderer || targetsWebContents) {
            const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1
            violations.push(`${path}:${line}: ${node.getText(syntax)}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(syntax)
  }
  return violations
}

test('IPC catalog entries are unique', () => {
  assert.equal(new Set(ALL_IPC_CHANNELS).size, ALL_IPC_CHANNELS.length)
})

test('preload request channels and main registrations have a one-to-one contract', () => {
  const preload = preloadRequestReferences()
  const main = mainRequestReferences()
  const values = ipcReferenceValues()
  const failures: string[] = []
  for (const reference of new Set([...preload.keys(), ...main.keys()])) {
    const channel = values.get(reference)
    assert.ok(channel, `Unknown IPC reference: ${reference}`)
    const preloadCount = preload.get(reference) ?? 0
    const mainCount = main.get(reference) ?? 0
    const isOneSided =
      (preloadCount === 0 && mainCount === 1) || (preloadCount === 1 && mainCount === 0)
    if (
      (preloadCount !== 1 || mainCount !== 1) &&
      !(isOneSided && REQUEST_CHANNEL_ALLOWLIST.has(channel))
    ) {
      failures.push(`${channel}: preload invokes=${preloadCount}, main registrations=${mainCount}`)
    }
  }
  for (const [channel, reason] of REQUEST_CHANNEL_ALLOWLIST) {
    assert.ok(reason.trim(), `${channel}: allowlist reason must not be empty`)
    const reference = [...values].find(([, value]) => value === channel)?.[0]
    assert.ok(reference, `${channel}: allowlist entry is not in IPC`)
    const preloadCount = preload.get(reference) ?? 0
    const mainCount = main.get(reference) ?? 0
    assert.ok(
      (preloadCount === 0 && mainCount === 1) || (preloadCount === 1 && mainCount === 0),
      `${channel}: stale allowlist entry (preload invokes=${preloadCount}, main registrations=${mainCount})`
    )
  }
  assert.deepEqual(failures, [])
})

test('Electron IPC calls do not use literal channel names', () => {
  assert.deepEqual(literalChannelViolations(), [])
})
