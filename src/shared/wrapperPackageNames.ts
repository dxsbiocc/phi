const PACKAGE_ID = /^(?:module|subworkflow|workflow)-(?:nf-core|local)-(.+)$/

/** `module-nf-core-samtools` → `samtools`; ids that do not follow the convention are kept. */
export function wrapperFamilyName(packageId: string): string {
  return PACKAGE_ID.exec(packageId)?.[1] ?? packageId
}

export function isConventionalWrapperPackageId(packageId: string): boolean {
  return PACKAGE_ID.test(packageId)
}
