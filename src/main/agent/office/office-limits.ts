export const OFFICE_CONTENT_LIMITS = Object.freeze({
  maxCellsPerOperation: 2_000,
  maxPayloadBytes: 256 * 1024,
  maxWorkbookRows: 1_000,
  maxWorkbookColumns: 10,
  maxCellTextLength: 32_767,
  maxPreviewCells: 6,
  maxPreviewValueCharacters: 120,
  maxApprovalSummaryCharacters: 1_200
})

export const OFFICE_WORKBOOK_LIMITS = Object.freeze({
  maxSheets: 20
})

// Opening/import admission is intentionally wider than one Agent or human edit operation.
export const OFFICE_WORKBOOK_ADMISSION_LIMITS = Object.freeze({
  maxRows: 1_000,
  maxColumns: 100,
  maxCells: 80_000
})

export const OFFICE_DOCUMENT_LIMITS = Object.freeze({
  maxParagraphs: 5_000,
  maxPreviewParagraphSamples: 8,
  maxParagraphTextLength: 4_000
})

export const OFFICE_PRESENTATION_LIMITS = Object.freeze({
  maxSlides: 200,
  maxTitleTextLength: 200,
  maxBodyTextLength: 2_000
})

export const OFFICE_FORMAT_LIMITS = Object.freeze({
  maxRows: 1_048_576,
  maxColumns: 16_384
})

export const OFFICE_FORMULA_LIMITS = Object.freeze({
  maxLength: 8_192
})
