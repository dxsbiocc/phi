/**
 * How Phi should run wrappers on one HPC login host. Lives in shared/ because
 * the main process builds the Nextflow launch from it and the settings screen
 * edits it. Holds no secrets.
 */

/** The `-profile` used on the cluster; each wrapper's nextflow.config defines all three. */
export type RemoteContainerRuntime = 'singularity' | 'conda' | 'docker'

export interface RemoteHpcSettings {
  /**
   * `slurm`: Nextflow, running on the login node, submits every process to Slurm.
   * `local`: processes run on the host Nextflow itself runs on (a single big node).
   */
  scheduler: 'slurm' | 'local'
  /**
   * Where the Nextflow head process runs. `login` (default): started on the login node and left
   * running there. `sbatch`: submitted as a Slurm job of its own, for sites that do not allow
   * long-lived processes on login nodes.
   */
  controller?: RemoteController
  /**
   * Extra `sbatch` flags for the head job when `controller` is `sbatch`, e.g.
   * `--time=7-00:00:00 --mem=8G`. They come last, so they override Phi's defaults.
   */
  controllerOptions?: string
  /** Where tools come from on the cluster. Defaults to singularity. */
  runtime?: RemoteContainerRuntime
  /** Slurm partition (`process.queue`). */
  queue?: string
  /** Slurm account, passed as `--account`. */
  account?: string
  /** Extra `sbatch` flags for every job, e.g. `--qos=normal`. */
  clusterOptions?: string
  /** Most jobs Nextflow keeps queued at once (`executor.queueSize`). */
  queueSize?: number
  /** Shared, writable directory where Singularity images are cached between runs. */
  singularityCacheDir?: string
  /** Absolute path of the launcher when `nextflow` is not on the login shell's PATH. */
  nextflowBin?: string
  /** Shell lines run before Nextflow starts, e.g. `module load nextflow java`. */
  setupCommands?: string[]
  /**
   * Nextflow config appended to every run on this connection, for what only this site
   * needs — e.g. `process.conda = '/shared/envs/rnaseq'` on a cluster whose compute
   * nodes cannot download environments. Per-run resources still take precedence.
   */
  nextflowConfig?: string
}

export type RemoteController = 'login' | 'sbatch'

export const DEFAULT_REMOTE_RUNTIME: RemoteContainerRuntime = 'singularity'
