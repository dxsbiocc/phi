export type MolecularStructureFileFormat = 'pdb' | 'mmcif'

export function molecularStructureFormatForPath(path: string): MolecularStructureFileFormat | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdb')) return 'pdb'
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'mmcif'
  return null
}
