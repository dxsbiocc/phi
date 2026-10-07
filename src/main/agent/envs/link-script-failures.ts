import type { SourcePackage } from './contract'

export interface LinkScriptFailure {
  action: 'pre-link' | 'post-link' | 'pre-unlink'
  packageName: string
  detail: string
}

const LINK_SCRIPT_START =
  /^\s*warning\s+libmamba\s+Executing (pre-link|post-link|pre-unlink) script for package '([^']+)'\.\s*$/
const LIBMAMBA_LOG_LINE = /^\s*(?:trace|debug|info|warning|error|critical)\s+libmamba\b/
const SCRIPT_FAILURE_PATTERNS = [
  /:\s*line \d+:\s*(.+?: command not found)\s*$/,
  /:\s*line \d+:\s*(.+?: Permission denied)\s*$/,
  /(.+?: syntax error(?: near unexpected token.*)?)\s*$/,
  /(.+?: unbound variable)\s*$/,
  /(.+?: Bad substitution)\s*$/,
  /(.+? is not recognized as an internal or external command.*)\s*$/,
  /(The system cannot find the (?:file|path) specified\.?)\s*$/i
]

// "No such file or directory" is deliberately not a failure: scripts commonly remove or
// probe paths that may be absent and carry on.
/**
 * micromamba 2.9.0 logs link-script execution but can still exit zero when the
 * script's shell exits nonzero. Keep detection scoped to output following that
 * marker so unrelated transaction warnings remain warnings.
 */
function linkScriptFailuresFromOutput(output: string): LinkScriptFailure[] {
  let active: Omit<LinkScriptFailure, 'detail'> | undefined
  const failures: LinkScriptFailure[] = []
  for (const line of output.split(/\r?\n/)) {
    const started = line.match(LINK_SCRIPT_START)
    if (started) {
      active = {
        action: started[1] as LinkScriptFailure['action'],
        packageName: started[2]
      }
      continue
    }
    if (!active) continue
    if (LIBMAMBA_LOG_LINE.test(line)) {
      active = undefined
      continue
    }
    for (const pattern of SCRIPT_FAILURE_PATTERNS) {
      const failure = line.match(pattern)
      if (!failure) continue
      failures.push({ ...active, detail: failure[1].trim() })
      active = undefined
      break
    }
  }
  return failures
}

export function linkScriptFailureFromOutput(output: string): LinkScriptFailure | undefined {
  return linkScriptFailuresFromOutput(output)[0]
}

function normalizedRPackageName(name: string): string {
  return name.replace(/^(?:r|bioconductor)-/i, '').toLowerCase()
}

/** A pinned source archive replaces the failed conda R package before the prefix is finalized. */
export function isReplacedSourcePackageLinkFailure(
  failure: LinkScriptFailure,
  sourcePackages: readonly SourcePackage[]
): boolean {
  if (failure.action !== 'post-link' || !/^(?:r|bioconductor)-/i.test(failure.packageName)) {
    return false
  }
  const failedName = normalizedRPackageName(failure.packageName)
  return sourcePackages.some(
    (pkg) => pkg.language === 'r' && normalizedRPackageName(pkg.name) === failedName
  )
}

export function unreplacedLinkScriptFailureFromOutput(
  output: string,
  sourcePackages: readonly SourcePackage[]
): LinkScriptFailure | undefined {
  return linkScriptFailuresFromOutput(output).find(
    (failure) => !isReplacedSourcePackageLinkFailure(failure, sourcePackages)
  )
}
