// Whitelist diagnostic fields; never inspect/serialize an entire upstream
// error, request, response, or workerData (which contains the GitHub token).
export function bundleBuildDiagnostic(error, token, depth = 0) {
  const redact = value => {
    let text = String(value)
    if (token) text = text.replaceAll(token, '[redacted]')
    return text.replaceAll(/\b(?:github_pat_|gh[pousr]_)[\w]+/gu, '[redacted]')
      .replaceAll(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$1[redacted]@')
      .replaceAll(/([?&](?:access_token|token|key)=)[^\s&#]*/giu, '$1[redacted]')
  }
  if (!error || typeof error !== 'object') return { message: redact(error).slice(0, 2048) }
  // Upstream HttpError messages append the response body after the status.
  // Keep the method, URL and status, but omit that body from message and stack.
  const raw = typeof error.message === 'string' ? error.message : 'Unknown error'
  const message = error.name === 'HttpError' ? raw.replace(/(\s\d{3}):[\s\S]*$/u, '$1') : raw
  const result = { message: redact(message).slice(0, 2048) }
  if (typeof error.name === 'string') result.name = redact(error.name).slice(0, 128)
  if (typeof error.code === 'string') result.code = redact(error.code).slice(0, 128)
  if (typeof error.status === 'number') result.status = error.status
  if (typeof error.stack === 'string') result.stack = redact(error.stack.replace(raw, message)).slice(0, 8192)
  if (error.cause && depth < 3) result.cause = bundleBuildDiagnostic(error.cause, token, depth + 1)
  return result
}
