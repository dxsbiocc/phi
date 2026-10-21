export const CATALOG_DEFAULT_PAGE_SIZE = 10

/** Classic scrollbar slot from base.css. Catalog scrollers reserve it so a full page and a short page share one right edge. */
export const CATALOG_SCROLLBAR_GUTTER = '12px'

/** Shared dialog size so skill, connector, and wrapper catalogs keep the same margins. */
export const catalogDialogPaperSx = {
  width: 'min(1100px, calc(100vw - 48px))',
  height: 'min(720px, calc(100vh - 64px))',
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: 'calc(100vh - 64px)',
  m: 3,
  borderRadius: 2,
  overflow: 'hidden'
} as const

export function getCatalogPage<T>(
  items: readonly T[],
  page: number,
  rowsPerPage: number
): { page: number; rows: T[] } {
  const lastPage = Math.max(0, Math.ceil(items.length / rowsPerPage) - 1)
  const currentPage = Math.min(Math.max(0, page), lastPage)
  return {
    page: currentPage,
    rows: items.slice(currentPage * rowsPerPage, (currentPage + 1) * rowsPerPage)
  }
}
