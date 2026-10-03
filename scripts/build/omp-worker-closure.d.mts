export declare const OMP_WORKER_ENTRY: string
export declare function packageNameOf(specifier: string): string
export declare function collectOmpWorkerSources(repoRoot: string): {
  files: string[]
  packages: string[]
}
export declare function ompWorkerOutputPath(sourcePath: string): string
export declare function ompWorkerOutputFiles(repoRoot: string): string[]
export declare function copyOmpWorkerClosure(repoRoot: string): void
export declare function collectOmpWorkerPackageDirs(repoRoot: string): string[]
export declare function collectOmpWorkerPackageAssets(repoRoot: string): string[]
