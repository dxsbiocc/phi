import { EMPTY_ASSET_CACHE_REPORT, type AssetCacheReport } from './asset-cache'
import type { R8RunResult } from './runner'

export interface R8Receipt {
  readonly schema: 1
  readonly mode: 'execute'
  readonly runId: string
  readonly ok: boolean
  readonly startedAt: string
  readonly finishedAt: string
  readonly host: string
  readonly runtimeRootConfigured: string
  readonly runtimeRoot: string | null
  readonly runtimeRootCreated: boolean | null
  readonly commit: string
  readonly commitAfter: string
  readonly commitStable: boolean
  readonly bundleHash: string
  readonly bundleHashAfter: string
  readonly bundleStable: boolean
  readonly trackedFilesModifiedAfter: number
  readonly ompVersion: string | null
  readonly childExitCode: number | null
  readonly elapsedMs: number
  readonly cases: ReadonlyArray<{ name: string; elapsedMs: number | null; detail: unknown }>
  readonly providerRequests: number | null
  readonly providerPurposes: R8RunResult['providerPurposes'] | null
  /** The prepare phase: one production startup, measured apart from the cases. */
  readonly prepare: R8RunResult['prepare'] | null
  /** Cases' startups only (the prepare startup is in `prepare`). */
  readonly startup: R8RunResult['startup']
  readonly assetCache: AssetCacheReport & { readonly failure?: string }
  readonly rpcStartup: NonNullable<R8RunResult['rpcStartup']>
  readonly remoteOperations: NonNullable<R8RunResult['remoteOperations']>
  readonly tunnels: R8RunResult['tunnels'] | null
  readonly cleanup: R8RunResult['cleanup'] & { localRunDirectoryRemoved: boolean }
  readonly failure: { phase: string; kind: string; reason: string } | null
}

export interface ReceiptParts {
  readonly result: R8RunResult | undefined
  readonly runId: string
  readonly host: string
  readonly runtimeRootConfigured: string
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly commit: string
  readonly commitAfter: string
  readonly bundleHash: string
  readonly bundleHashAfter: string
  readonly trackedFilesModifiedAfter: number
  readonly childExitCode: number | null
  readonly childFailure?: string
  readonly localRunDirectoryRemoved: boolean
  readonly assetCache?: AssetCacheReport & { readonly failure?: string }
}

const EMPTY_CLEANUP: R8RunResult['cleanup'] = {
  applicationClosed: false,
  rpcClosed: false,
  generationDirectoriesRemoved: false,
  tunnelsClosed: false,
  ownedTestRootRemoved: false,
  transportsClosed: false,
  failures: []
}

export function buildReceipt(parts: ReceiptParts): R8Receipt {
  const { result } = parts
  const commitStable = parts.commit === parts.commitAfter
  const bundleStable = parts.bundleHash === parts.bundleHashAfter
  const childClean = parts.childExitCode === 0
  const ok = Boolean(result?.ok) && commitStable && bundleStable && childClean
  const failure = ok
    ? null
    : {
        phase: result?.failedPhase ?? (result ? 'integrity' : 'child'),
        kind: result?.failureKind ?? 'INTEGRITY',
        reason:
          result?.failureReason ??
          parts.childFailure ??
          (!commitStable
            ? 'HEAD changed during the run'
            : !bundleStable
              ? 'The extension bundle changed during the run'
              : !childClean
                ? 'The run process did not exit cleanly'
                : 'Unknown failure')
      }
  return {
    schema: 1,
    mode: 'execute',
    runId: parts.runId,
    ok,
    startedAt: parts.startedAt.toISOString(),
    finishedAt: parts.finishedAt.toISOString(),
    host: parts.host,
    runtimeRootConfigured: parts.runtimeRootConfigured,
    runtimeRoot: result?.runtimeRoot ?? null,
    runtimeRootCreated: result?.runtimeRootCreated ?? null,
    commit: parts.commit,
    commitAfter: parts.commitAfter,
    commitStable,
    bundleHash: parts.bundleHash,
    bundleHashAfter: parts.bundleHashAfter,
    bundleStable,
    trackedFilesModifiedAfter: parts.trackedFilesModifiedAfter,
    ompVersion: result?.ompVersion ?? null,
    childExitCode: parts.childExitCode,
    elapsedMs: parts.finishedAt.getTime() - parts.startedAt.getTime(),
    cases: (result?.cases ?? []).map((entry) => ({
      name: String(entry.case),
      elapsedMs: typeof entry.elapsedMs === 'number' ? entry.elapsedMs : null,
      detail: entry
    })),
    providerRequests: result?.providerRequests ?? null,
    providerPurposes: result?.providerPurposes ?? null,
    prepare: result?.prepare ?? null,
    startup: result?.startup ?? [],
    assetCache: parts.assetCache ?? EMPTY_ASSET_CACHE_REPORT,
    rpcStartup: result?.rpcStartup ?? [],
    remoteOperations: result?.remoteOperations ?? [],
    tunnels: result?.tunnels ?? null,
    cleanup: {
      ...(result?.cleanup ?? EMPTY_CLEANUP),
      localRunDirectoryRemoved: parts.localRunDirectoryRemoved
    },
    failure
  }
}

const seconds = (ms: number | null): string => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`)

export function renderSummary(receipt: R8Receipt, receiptPath: string): string {
  const lines = [
    `Remote R8 on ${receipt.host}: ${receipt.ok ? 'PASS' : 'FAIL'} (${seconds(receipt.elapsedMs)})`,
    `  commit ${receipt.commit.slice(0, 12)}, extension bundle ${receipt.bundleHash.slice(0, 12)}, OMP ${receipt.ompVersion ?? 'n/a'}`,
    `  runtime root ${receipt.runtimeRoot ?? receipt.runtimeRootConfigured}${receipt.runtimeRootCreated ? ' (created by this run)' : ''}`
  ]
  if (receipt.prepare)
    lines.push(
      `  prepare: ${receipt.prepare.status}, ${seconds(receipt.prepare.elapsedMs)}, ${receipt.prepare.remoteCommands} remote commands, ${receipt.prepare.installedOrRepaired ? 'installed or repaired something' : 'nothing to install'}`
    )
  for (const entry of receipt.cases) lines.push(`  case ${entry.name}: ${seconds(entry.elapsedMs)}`)
  for (const report of receipt.startup) {
    lines.push(
      `  startup #${report.attempt} (${report.kind}): ${report.status}, ${seconds(Number(report.totalMs))}, ${report.remoteCommands} remote commands`
    )
  }
  const cleanup = receipt.cleanup
  const cleanOk =
    cleanup.failures.length === 0 &&
    cleanup.applicationClosed &&
    cleanup.rpcClosed &&
    cleanup.generationDirectoriesRemoved &&
    cleanup.tunnelsClosed &&
    cleanup.ownedTestRootRemoved &&
    cleanup.transportsClosed
  lines.push(`  cleanup: ${cleanOk ? 'confirmed' : 'NOT confirmed'}`)
  if (receipt.failure)
    lines.push(`  failure in ${receipt.failure.phase}: ${receipt.failure.reason}`)
  lines.push(`  receipt: ${receiptPath}`)
  return lines.join('\n')
}
