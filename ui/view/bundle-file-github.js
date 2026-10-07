import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'
import { bundleSourcePackageInfo } from './bundle-source-package.js'
import { moduleEcosystem } from './bundle-source-tree.js'

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
// Own source follows the bundle's stamp, an unrecorded directory being the
// repository root as in the Overview's origin link. A dependency follows its
// own repository (recorded, or its captured package.json's, as the package
// tooltips read it), and only where the directory in it is known too; it
// never borrows the application's.
export function bundleFileGithub(details, path) {
  if (details?.kind !== 'stasis' || typeof path !== 'string') return null
  const bundle = details.bundle
  let owner = null
  for (const [dir, info] of bundle?.modules ?? []) {
    const rel = dir === '.' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null
    if (rel !== null && Object.hasOwn(info.files, rel)) { owner = { dir, info, rel }; break }
  }
  if (!owner) return null
  const { dir, info, rel } = owner
  const ecosystem = moduleEcosystem(dir, info, null) ?? (dir.split('/').includes('node_modules') ? 'npm' : undefined)
  if (ecosystem === undefined) {
    const github = reportRepoGithub(bundle)
    return github ? fileLink(github, repoDirectory(bundle.repo), path, bundle.repo?.commit, null) : null
  }
  const pkg = bundleSourcePackageInfo({ name: info.name, ecosystem }, info, 0)
  if (!pkg.github || typeof pkg.directory !== 'string') return null
  return fileLink(pkg.github, pkg.directory, rel, reportRepoGithub(info) ? info.repo.commit : undefined, pkg)
}
