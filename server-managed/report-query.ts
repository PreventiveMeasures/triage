// Large workspaces remain a single request. Bound both the stored input and
// the encoded response, independently of the per-upload size limit.
export const MAX_REPORT_QUERY_COUNT = 4096
export const MAX_REPORT_QUERY_BYTES = 1024 * 1024 * 1024
