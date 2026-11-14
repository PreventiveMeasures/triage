// A Stasis bundle validated (GET and POST /api/bundles/:id/validation) by
// Stasis's own validation (`@exodus/stasis/validate`; its rules are in
// Stasis's doc/validate.md), the repository read the app's way: with its
// reader's GitHub access, own code by git's blob ids of the commit's listing.
import { type BundleValidation, type ValidationPlan, followingMoves, validateBundle, validateRepository } from '@exodus/stasis/validate'
import { createClient } from '@preventive/upstream/github.js'
import { upstreamGithub } from './github-errors.ts'
import { USER_AGENT } from './github-requests.ts'

export { type BundleValidation, type PlannedBundle, validationPlan } from '@exodus/stasis/validate'

// The rules a validation was made by, kept with it: one made by others is made again.
export const BUNDLE_VALIDATION_READ = 3

type Options = { deadline?: number }

// The bundle `plan`'s dependencies alone, held to their registry, own code unverified for `reason`.
export const validateDependencies = (plan: ValidationPlan, reason: string, options: Options = {}): Promise<BundleValidation> =>
  validateBundle(plan, { reason }, options)

// The bundle `plan` validated at `commit` of `fullName`, read with `token`,
// built in `directory`: own code held to git's blob ids of the commit's tree
// as upstream lists it (each listing held to its tree's id), the commit to the
// repository's own history, the dependencies to the lockfiles installing it;
// what can't be held to told in the report (own code's `reason`,
// `lockfileError`), not thrown.
export function validateAtCommit(plan: ValidationPlan, { fullName, token, commit, directory }: { fullName: string; token: string; commit: string; directory: string },
  options: Options = {}): Promise<BundleValidation> {
  const client = createClient({ token, userAgent: USER_AGENT })
  const repository = followingMoves(client, fullName)
  return upstreamGithub(() => validateRepository(plan, { repository, commit, directory },
    { ...options, strict: false, listTree: paths => client.listRepoTree({ repo: repository.name(), sha: commit, paths }) }))
}
