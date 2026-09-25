import { MIMEType } from 'node:util'

// The metadata envelope is opt-in. Wildcards keep the legacy raw report;
// an explicit, acceptable application/json range requests the envelope.
export function acceptsReportMetadata(accept: string | undefined): boolean {
  // Commas inside quoted media-type parameters do not separate ranges.
  for (const range of accept?.match(/(?:[^",]|"(?:\\.|[^"\\])*")+/gu) ?? []) {
    try {
      const media = new MIMEType(range.trim())
      if (media.essence !== 'application/json') continue
      const quality = media.params.get('q') ?? '1'
      if (/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(quality) && Number(quality) > 0) return true
    } catch { /* Ignore malformed media ranges. */ }
  }
  return false
}
