// Local bundles remain freely comparable. Managed bundles need an explicit,
// identical repository assignment; two unattached uploads are not a repo.
export function bundleComparisonCandidates(bundles, integrity) {
  const base = bundles.find(bundle => bundle.integrity === integrity)
  return bundles.filter(bundle => bundle.integrity !== integrity && (base?.managedId
    ? bundle.managedId && base.repoId != null && bundle.repoId === base.repoId
    : !bundle.managedId))
}
