import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

// A tooltip cannot scroll, so a long subject is cut short there.
const MAX_TOOLTIP_TITLE = 200

function tooltipTitle(subject) {
  const chars = [...subject]
  return chars.length > MAX_TOOLTIP_TITLE ? `${chars.slice(0, MAX_TOOLTIP_TITLE - 1).join('').trimEnd()}…` : subject
}

// A path's segments each URI-encoded, its slashes kept.
export const encodePath = path => path.split('/').map(encodeURIComponent).join('/')

// A tag's release page on GitHub, `repository` owner/name.
export const githubTagHref = (repository, tag) => `https://github.com/${encodePath(repository)}/releases/tag/${encodePath(tag)}`

function catalogTags(commitInfo, hash) {
  return hash && commitInfo?.sha === hash && Array.isArray(commitInfo.tags) ? commitInfo.tags.filter(tag => typeof tag === 'string' && tag) : []
}

// The `data-tooltip-commit-info` value (see tooltip.js) for `hash`, from the
// `commitInfo` a managed catalog sends with a bundle, when it is for that
// commit: its subject, author and date, and its tags when the
// tooltip names `repository`, the one they were cached for. A commit is the
// same in every repository that has it (a fork's network); its tags are not.
export function bundleCommitTooltip(commitInfo, hash, repository = null) {
  const cachedFor = typeof commitInfo?.github === 'string' && typeof repository === 'string' && repository.toLowerCase() === commitInfo.github.toLowerCase()
  const tags = cachedFor ? catalogTags(commitInfo, hash) : []
  const details = hash && commitInfo?.sha === hash && typeof commitInfo.details?.subject === 'string' ? commitInfo.details : null
  if (!details && tags.length === 0) return undefined
  return JSON.stringify({ tags, ...(details ? { title: tooltipTitle(details.subject),
    authorName: details.authorName, authorLogin: details.authorLogin, date: details.committedAt ?? details.authoredAt } : {}) })
}

// `commitInfo` is what a managed catalog sends for the bundle (see
// server-managed/bundle-commits.ts): the cached details of its recorded commit
// and the tags that point to it, which ride on that commit's link. Tags link
// to the repository they were cached for, the one the bundle is stored at,
// which can differ from the one its stamp names.
export function bundleOriginLinks(bundle, prefix = '', commitInfo = null) {
  const links = []
  const github = reportRepoGithub(bundle)
  if (github) {
    const directory = [repoDirectory(bundle.repo), repoDirectory({ directory: prefix })].filter(Boolean).join('/')
    const commit = bundleCommitHash(bundle.repo?.commit)
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const base = `https://github.com/${github}`
    const tagRepository = reportRepoGithub({ repo: { github: commitInfo?.github } })
    const tags = tagRepository ? catalogTags(commitInfo, commit) : []
    links.push({ label: 'GitHub', text: github + (directory ? `/${directory}` : ''),
      href: commit || directory ? `${base}/tree/${commit ?? 'HEAD'}${path ? `/${path}` : ''}` : base,
      ...(commit ? { commit: { hash: commit, text: commit.slice(0, 7), href: `${base}/commit/${commit}`,
        ...(tags.length > 0 ? { tags: tags.map(tag => ({ name: tag, href: githubTagHref(tagRepository, tag) })) } : {}),
      } } : {}) })
  }
  const npm = bundle?.package?.npm
  if (typeof npm?.name === 'string' && NPM_NAME_RE.test(npm.name)) {
    const version = typeof npm.version === 'string' ? npm.version.trim() : ''
    links.push({ label: 'npm', text: npm.name + (version ? `@${version}` : ''),
      href: `https://www.npmjs.com/package/${npm.name}${version ? `/v/${encodeURIComponent(version)}` : ''}` })
  }
  return links
}
