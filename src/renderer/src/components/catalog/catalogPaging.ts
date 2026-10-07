export const CATALOG_DEFAULT_PAGE_SIZE = 10

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
