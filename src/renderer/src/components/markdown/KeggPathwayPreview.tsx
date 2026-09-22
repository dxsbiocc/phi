import { DatabaseHoverImagePreviewLink } from './DatabaseHoverImagePreviewLink'

export function KeggPathwayPreview({
  href,
  label
}: {
  href: string
  label: string
}): React.JSX.Element {
  return <DatabaseHoverImagePreviewLink href={href} label={label} kind="kegg-pathway" />
}
