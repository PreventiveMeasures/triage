import { npmCompareSource } from './npm-package.js'
import { npmCompareBadges, npmCompareFiles, npmDependencyTags, npmReviewLimit } from './npm-overview.js'

// Compare and Review use the same version metadata, chips, file alerts, and
// dependency changes. New package signals belong here for both views.
export function npmComparisonSource(entry) {
  return { ...npmCompareSource(entry), files: npmCompareFiles, badges: npmCompareBadges, dependencyTags: npmDependencyTags, reviewVerdictLimit: npmReviewLimit }
}
