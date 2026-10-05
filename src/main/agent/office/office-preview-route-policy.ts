import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { OFFICE_PREVIEW_CONTROL_PATH } from './office-preview-control'

const BASE_ROUTES = new Set(['GET /', 'GET /events'])
const XLSX_ROUTES = new Set([
  `GET ${OFFICE_PREVIEW_CONTROL_PATH}`,
  'POST /api/selection',
  'POST /api/send'
])

export function officePreviewRouteAllowed(
  kind: OfficeDocumentKind | undefined,
  method: string,
  path: string
): boolean {
  const route = `${method} ${path}`
  return (
    BASE_ROUTES.has(route) || ((kind === undefined || kind === 'xlsx') && XLSX_ROUTES.has(route))
  )
}
