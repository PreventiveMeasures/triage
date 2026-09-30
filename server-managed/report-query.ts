// Large workspaces remain a single request. Bound both the stored input and
// the encoded response, independently of the per-upload size limit.
export const MAX_REPORT_QUERY_COUNT = 4096
export const MAX_REPORT_QUERY_BYTES = 1024 * 1024 * 1024

// The import catalog scans a bounded page, not the whole installation. A
// report larger than the byte target occupies a page by itself; upload limits
// still bound that single report and the cursor must always make progress.
export const FINDING_CATALOG_PAGE_COUNT = 128
export const FINDING_CATALOG_PAGE_BYTES = 32 * 1024 * 1024
