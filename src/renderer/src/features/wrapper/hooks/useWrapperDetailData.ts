import { useEffect, useMemo, useState } from 'react'

import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../../../../../shared/wrapperModuleDetailsTypes'
import { buildWrapperParamsFlowGraph, type WrapperFlowGraph } from '../lib/wrapperFlow'
import { parseWrapperNextflowDag } from '../lib/wrapperNextflowDag'
import { parseWrapperCompositionId } from '../lib/wrapperView'

export interface WrapperDetailData {
  graph: WrapperFlowGraph | undefined
  moduleDetails: WrapperModuleDetails | undefined
}

/** Files that came with the wrapper itself (read from its package archive), so no lookup by id. */
export interface PrefetchedWrapperFiles {
  dag?: string
  details?: WrapperModuleDetails
}

/**
 * What the detail view draws beyond the manifest: the structure graph and the module's own
 * metadata. An installed wrapper is looked up by id; a wrapper from an uninstalled package
 * brings its own files.
 */
export function useWrapperDetailData(
  manifest: WrapperCompositionManifest | undefined,
  prefetched?: PrefetchedWrapperFiles
): WrapperDetailData {
  const manifestId = manifest?.id
  const hasFiles = prefetched !== undefined
  const tier = manifest ? parseWrapperCompositionId(manifest.id).tier : ''
  const params = useMemo(() => (manifest ? Object.entries(manifest.params) : []), [manifest])
  const inputParams = useMemo(() => params.filter(([, param]) => param.kind === 'input'), [params])
  const outputs = useMemo(() => (manifest ? Object.entries(manifest.outputs) : []), [manifest])
  const paramsGraph = useMemo(
    // Built from the wrapper's own declared params/outputs — its real,
    // user-facing contract — not Nextflow's internal process signature.
    // See buildWrapperParamsFlowGraph's own doc comment for why those two
    // can genuinely disagree (a module's process can take extra channels
    // the wrapper hardcodes off).
    () =>
      manifest
        ? buildWrapperParamsFlowGraph({
            name: manifest.name,
            inputLabels: inputParams.map(([key]) => key),
            outputLabels: outputs.map(([key]) => key)
          })
        : undefined,
    [manifest, inputParams, outputs]
  )
  // Only "workflows" (a complete multi-process pipeline) benefits from the
  // real Nextflow DAG: it has no small enumerable params that represent its
  // internal structure the way a module's do, so the params-graph above
  // would just be a handful of top-level pipeline options, not a structure
  // view at all. Keyed by the id the fetch was made for, so a still-in-flight
  // fetch from a previously-manifest wrapper never applies once selection
  // moves on (react-hooks/set-state-in-effect wants setState in the async
  // callback, not synchronously at the top of the effect).
  const [dagResult, setDagResult] = useState<{ id: string; source: string | undefined }>()
  useEffect(() => {
    if (hasFiles || !manifestId || tier !== 'workflows') return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionDag(manifestId)
      .then((dag) => {
        if (!cancelled) setDagResult({ id: manifestId, source: dag })
      })
      .catch(() => {
        if (!cancelled) setDagResult({ id: manifestId, source: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [hasFiles, manifestId, tier])
  const dagSource = prefetched
    ? prefetched.dag
    : tier === 'workflows' && dagResult && dagResult.id === manifestId
      ? dagResult.source
      : undefined
  // Nextflow's raw dag.mmd is mostly channel/value plumbing (`channel.empty`,
  // merge points, …) — parseWrapperNextflowDag collapses all of that down to
  // real processes and the direct dependencies between them. Falls back to
  // the params-graph above if parsing finds no processes (e.g. dag.mmd
  // failed to generate for this wrapper).
  const graph = useMemo(
    () => (dagSource ? parseWrapperNextflowDag(dagSource) : undefined) ?? paramsGraph,
    [dagSource, paramsGraph]
  )
  const [moduleDetailsResult, setModuleDetailsResult] = useState<{
    id: string
    details: WrapperModuleDetails | undefined
  }>()
  useEffect(() => {
    if (hasFiles || !manifestId) return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionModuleDetails(manifestId)
      .then((details) => {
        if (!cancelled) setModuleDetailsResult({ id: manifestId, details })
      })
      .catch(() => {
        if (!cancelled) setModuleDetailsResult({ id: manifestId, details: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [hasFiles, manifestId])
  const moduleDetails = prefetched
    ? prefetched.details
    : moduleDetailsResult && moduleDetailsResult.id === manifestId
      ? moduleDetailsResult.details
      : undefined
  return { graph, moduleDetails }
}
