/**
 * Splits one RFC4180-style CSV row, matching `samplesheet.ts`'s `csvField`
 * writer — a field is quoted when it contains a comma, quote, or newline,
 * with embedded quotes doubled. A plain `line.split(',')` (this module's
 * previous implementation) silently misaligns every later column once a
 * path contains a comma, since that's exactly the case the writer now
 * quotes around instead of leaving bare.
 */
export function parseSamplesheetRow(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

/** Parses the CSV `buildPairedEndFastqSamplesheet` writes (see samplesheet.ts). */
export function parseSamplesheetCsv(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.split('\n').filter((line) => line.length > 0)
  const [header = [], ...rows] = lines.map(parseSamplesheetRow)
  return { header, rows }
}
