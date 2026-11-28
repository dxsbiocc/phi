export declare function restoreOmpWorkerAssets(sourceRoot: string, unpackedRoot: string): string[]
export declare function assertBundledBun(resourcesDir: string, platformId: string): string
export declare function assertBundledWindowsRuntimes(resourcesDir: string, manifest?: unknown): void
export declare function assertBundledWindowsSidecars(resourcesDir: string, manifest: unknown): void
export declare function assertNoExcludedLocalModelPackages(unpackedRoot: string): void
export declare function afterPack(context: unknown): Promise<void>
