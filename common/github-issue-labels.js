// Shared by GitHub's prefilled form and managed API issue creation.
export function newIssueLabels(isSecurity = false, configured = '') {
  const seen = new Set()
  return ['deepview', ...(isSecurity ? ['security'] : []), ...configured.split(',')]
    .map(label => label.trim()).filter(label => {
      const key = label.toLowerCase()
      if (!label || seen.has(key)) return false
      seen.add(key)
      return true
    })
}
