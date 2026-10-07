import { isValidRepoField } from '@exodus/stasis-core/bundle'

// Stasis's `packageRepo` (@exodus/stasis-core/bundle-util): the `repo` a
// build records for a dependency from its parsed package.json. That module
// also reads the disk and can't load in the browser, so its rule is mirrored
// here line for line; tests hold the two equal.

// `owner/name` from a `repository` URL or shorthand, else null.
function parseGithubRepository(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:github:|(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?(?:www\.)?github\.com(?::\d+)?\/|ssh:\/\/(?:[\w.~%!$&'()*+,;=-]*@)?(?:www\.)?github\.com:|(?:[^@/:]+@)?(?:www\.)?github\.com:))?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim().replace(/#.*$/su, ''))
  const github = match && `${match[1]}/${match[2]}`
  return github && isValidRepoField('github', github) ? github : null
}

// Dir of a `https://github.com/<github>/tree/<branch>/<dir>` homepage (one-segment branch).
function githubHomepageDirectory(homepage, github) {
  if (typeof homepage !== 'string') return undefined
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/tree\/[^/#?]+\/([^#?]+)/iu.exec(homepage.trim())
  if (!match || match[1].toLowerCase() !== github.toLowerCase()) return undefined
  try { return decodeURIComponent(match[2]) } catch { return undefined }
}

const isRootPath = path => path.replaceAll('\\', '/').split('/').every(part => part === '' || part === '.')

// A declared directory as a valid `{ directory }`: `''` at the root, `{}` where
// none is declared or it has a `..` part. Empty and `.` parts drop, as
// Stasis's posix.join with no `rel` drops them.
function declaredLocation(base) {
  if (typeof base !== 'string') return {}
  const parts = base.replaceAll('\\', '/').split('/')
  if (parts.includes('..')) return {}
  const directory = parts.filter(part => part !== '' && part !== '.').join('/')
  return isValidRepoField('directory', directory) ? { directory } : {}
}

// `{ github, directory? }` a parsed package.json's `repository` names, with a
// GitHub tree `homepage` placing it below the root where `repository.directory`
// is unset; undefined where it names no GitHub repository.
export function packageRepo(json) {
  const repository = json?.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  const github = parseGithubRepository(url)
  if (!github) return undefined
  let base = repository.directory
  if (typeof base !== 'string') {
    base = githubHomepageDirectory(json.homepage, github)
    if (base !== undefined && isRootPath(base)) base = undefined
  }
  return { github, ...declaredLocation(base) }
}
