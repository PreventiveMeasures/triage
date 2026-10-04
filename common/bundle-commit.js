// Match the full Git object IDs used by bundle origin links.
export function bundleCommitHash(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) ? value : null
}
