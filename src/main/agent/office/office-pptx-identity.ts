import { officePackageEntry } from './office-open-xml-package'

const MAX_PRESENTATION_XML_BYTES = 512 * 1024
const MAX_RELATIONSHIPS_XML_BYTES = 512 * 1024

export function readOfficePptxSlideIds(bytes: Buffer): readonly string[] {
  const presentation = officePackageEntry(
    bytes,
    'ppt/presentation.xml',
    MAX_PRESENTATION_XML_BYTES
  ).toString('utf8')
  const relationships = officePackageEntry(
    bytes,
    'ppt/_rels/presentation.xml.rels',
    MAX_RELATIONSHIPS_XML_BYTES
  ).toString('utf8')
  const slideRelationships = relationshipsById(relationships)
  const usedRelationships = new Set<string>()
  const ids = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/giu)].map((match) => {
    const id = attribute(match[1] ?? '', 'id')
    const relationship = attribute(match[1] ?? '', 'r:id')
    if (
      !validSlideId(id) ||
      !relationship ||
      !slideRelationships.has(relationship) ||
      usedRelationships.has(relationship)
    ) {
      throw new Error('invalid pptx slide identity')
    }
    usedRelationships.add(relationship)
    return String(Number(id))
  })
  if (new Set(ids).size !== ids.length) throw new Error('duplicate pptx slide identity')
  return Object.freeze(ids)
}

export function officePptxStableElementPath(slideId: string, elementId: string): string {
  return `/slide[@id=${slideId}]/shape[@id=${elementId}]`
}

function relationshipsById(xml: string): ReadonlyMap<string, string> {
  const entries = [...xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)].flatMap((match) => {
    const attributes = match[1] ?? ''
    const type = attribute(attributes, 'Type')
    const id = attribute(attributes, 'Id')
    const target = attribute(attributes, 'Target')
    return type?.endsWith('/slide') && id && target ? [[id, target] as const] : []
  })
  const ids = new Set<string>()
  const targets = new Set<string>()
  for (const [id, target] of entries) {
    if (ids.has(id) || targets.has(target)) throw new Error('duplicate pptx slide relationship')
    ids.add(id)
    targets.add(target)
  }
  return new Map(entries)
}

function attribute(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`, 'iu').exec(source)
  return match?.[1] ?? match?.[2]
}

function validSlideId(value: string | undefined): value is string {
  if (!value || !/^\d{1,10}$/u.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 256 && parsed <= 0xffffffff
}
