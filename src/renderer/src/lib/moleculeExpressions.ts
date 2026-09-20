const RENDERABLE_MOLECULE_FIELD_NAMES = new Set([
  'smiles',
  'canonicalsmiles',
  'isomericsmiles',
  'mol',
  'molblock',
  'molfile',
  'sdf'
])

const SMILES_ATOM_PATTERN = /(?:Br|Cl|[BCNOPSFIbcnops])/
const SMILES_STRUCTURE_PATTERN = /[=#()[\]@+\-\\/0-9]/

export function normalizedMoleculeField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isRenderableMoleculeField(field: string): boolean {
  return RENDERABLE_MOLECULE_FIELD_NAMES.has(normalizedMoleculeField(field))
}

export function smilesExpressionFromInlineCode(value: string): string | null {
  const text = value.trim()
  if (text.length < 8 || text.length > 600) return null
  if (/\s/.test(text)) return null
  if (!SMILES_ATOM_PATTERN.test(text) || !SMILES_STRUCTURE_PATTERN.test(text)) return null
  return text
}
