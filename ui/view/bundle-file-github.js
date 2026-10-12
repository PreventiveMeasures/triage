import { html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'
import { bundleCommitTooltip } from './bundle-origin-links.js'
import { bundleSourcePackageInfo } from './bundle-source-package.js'
import { moduleEcosystem } from './bundle-source-tree.js'
import { GITHUB_ICON_SVG } from './icons.js'
import { sourcePackageIcon } from './source-file-icon.js'

function fileLink(github, directory, file, commit, pkg) {
  const path = [directory, file].filter(Boolean).join('/')
  const hash = bundleCommitHash(commit)
  return {
    href: `https://github.com/${github}/blob/${hash ?? 'HEAD'}/${path.split('/').map(encodeURIComponent).join('/')}`,
    github, path, commit: hash,
    package: typeof pkg?.name === 'string' && pkg.name ? { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem } : null,
  }
}

// Where a stasis bundle file sits on GitHub, and the package it ships in,
// from the nearest module that records it, at the recorded commit if any.
// Own source follows the bundle's stamp, with what it leaves out taken from
// `assigned`, the repository and directory a managed bundle is stored at; a
// dependency follows its own repository (recorded, or its captured
// package.json's, as the package tooltips read it), never the application's.
// Best effort: a directory nothing records is taken for the repository root,
// as the Overview's origin link takes it.
export function bundleFileGithub(details, path, assigned = null) {
  if (typeof path !== 'string') return null
  // An npm version's file, where npm recorded both its repository and the
  // commit it was published from: at that commit, in the directory its
  // repository names. Best effort too: a file its build wrote may not be
  // in the repository.
  const npm = details?.npm?.manifest
  if (npm) {
    const commit = bundleCommitHash(npm.gitHead)
    return npm.github?.github && commit ? fileLink(npm.github.github, repoDirectory({ directory: npm.github.directory ?? '' }), path, commit, null) : null
  }
  if (details?.kind !== 'stasis') return null
  const bundle = details.bundle
  let owner = null
  for (const [dir, info] of bundle?.modules ?? []) {
    const rel = dir === '.' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null
    if (rel !== null && Object.hasOwn(info.files, rel)) { owner = { dir, info, rel }; break }
  }
  if (!owner) return null
  const { dir, info, rel } = owner
  // The root module is own source whatever ecosystem it records, as the
  // file tree and advisory inventory read it.
  const ecosystem = dir === '.' ? undefined : moduleEcosystem(dir, info, null) ?? (dir.split('/').includes('node_modules') ? 'npm' : undefined)
  if (ecosystem === undefined) {
    const stamped = reportRepoGithub(bundle)
    const stored = reportRepoGithub({ repo: { github: assigned?.github } })
    const github = stamped ?? stored
    if (!github) return null
    // A stored directory places only the stored repository's files.
    const directory = typeof bundle.repo?.directory === 'string' ? repoDirectory(bundle.repo)
      : stored?.toLowerCase() === github.toLowerCase() ? repoDirectory({ directory: assigned.directory }) : ''
    return fileLink(github, directory, path, stamped ? bundle.repo?.commit : undefined, null)
  }
  const pkg = bundleSourcePackageInfo({ name: info.name, ecosystem }, info, 0)
  if (!pkg.github) return null
  return fileLink(pkg.github, pkg.directory ?? '', rel, pkg.commit, pkg)
}

// A file head's GitHub link (bundleFileGithub's `github`), its tooltip naming
// the repository, the file's path in it and the commit, with what
// `commitInfo` (a managed bundle's) says of the commit, and a dependency's
// package.
export function githubFileLink(github, commitInfo = null) {
  return html`<a class="bundle-code-github-link" href=${github.href} target="_blank" rel="noopener noreferrer" aria-label="Open on GitHub"
    data-tooltip=${github.path} data-tooltip-repo=${github.github} data-tooltip-commit=${github.commit ?? nothing}
    data-tooltip-commit-info=${bundleCommitTooltip(commitInfo, github.commit, github.github) ?? nothing}
    data-tooltip-package=${github.package?.name ?? nothing} data-tooltip-ecosystem=${github.package?.ecosystem ?? nothing}
    data-tooltip-version=${github.package?.version ?? nothing}
  >${unsafeHTML(GITHUB_ICON_SVG)}${github.package ? html`<span hidden data-tooltip-package-icon>${sourcePackageIcon(github.package.ecosystem)}</span>` : nothing}</a>`
}
