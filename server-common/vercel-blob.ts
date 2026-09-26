// Shared optional Vercel Blob SDK boundary for both server modes.
import type { Readable } from 'node:stream'
import type { Buffer } from 'node:buffer'

// Minimal structural shape of the bits of `@vercel/blob` we use.
// Shared so the optional peer dep doesn't have to type-resolve
// for SQLite-only deployments. Real type details live in the
// installed package; the fields/parameters we touch here are stable
// per the SDK v2 public surface.
//
// `put` accepts the SDK's full `PutBody` union (string | Readable |
// Buffer | Blob | ArrayBuffer | ReadableStream | File). We only ever
// pass a Node `PassThrough` (a Readable), but the wider type lets
// callers reuse this signature for future buffer/blob bodies without
// type gymnastics. `copy` accepts `allowOverwrite` — REQUIRED for
// version bumps since the live pathname is reused on re-upload.

type VercelBlobBody = Readable | Buffer | string | Blob | ArrayBuffer | ReadableStream<Uint8Array>
export type VercelBlobSdk = {
  put: (
    pathname: string,
    body: VercelBlobBody,
    options: {
      access: 'private' | 'public'
      addRandomSuffix?: boolean
      allowOverwrite?: boolean
      contentType?: string
      token?: string
      multipart?: boolean
      abortSignal?: AbortSignal
      cacheControlMaxAge?: number
    },
  ) => Promise<{ url: string; pathname: string }>
  head: (
    pathname: string,
    options?: { token?: string; abortSignal?: AbortSignal },
  ) => Promise<{ size: number; pathname: string; url: string }>
  get: (
    pathname: string,
    options: {
      access: 'private' | 'public'
      token?: string
      useCache?: boolean
      abortSignal?: AbortSignal
    },
  ) => Promise<{
    statusCode: 200 | 304
    stream: ReadableStream<Uint8Array> | null
    blob: { size: number | null }
  } | null>
  copy: (
    fromPathname: string,
    toPathname: string,
    options: {
      access: 'private' | 'public'
      addRandomSuffix?: boolean
      allowOverwrite?: boolean
      token?: string
      contentType?: string
      cacheControlMaxAge?: number
    },
  ) => Promise<{ url: string; pathname: string }>
  del: (
    urlOrPathname: string | string[],
    options?: { token?: string; abortSignal?: AbortSignal },
  ) => Promise<void>
  list: (options: {
    prefix?: string
    cursor?: string
    limit?: number
    mode?: 'expanded' | 'folded'
    token?: string
  }) => Promise<{
    // `uploadedAt` (a Date per the SDK v2 surface) is the blob's
    // creation time — used by the reaper's GC grace window. Optional
    // in the type because the `folded` listing path ignores it (only
    // `listLiveBlobs` reads it, and it uses the default expanded mode).
    blobs: Array<{ pathname: string; size: number; uploadedAt?: Date | string | number }>
    folders?: string[]
    cursor?: string
    hasMore: boolean
  }>
}

// Recognise "blob is gone" errors uniformly across read/write/delete
// paths so callers can treat them as success (delete) or
// not-found (read). The SDK exposes BlobNotFoundError as a class with
// `.name === 'BlobNotFoundError'`; checking the name string avoids
// importing the class at the top level (which would force the optional
// peer dep to resolve).
//
// Class-name check ONLY — the SDK's internal mapper turns every API
// `not_found` into BlobNotFoundError-by-name, so a bare-404 transport
// leak doesn't reach here. A broader `/does not exist|\b404\b/` match
// is DANGEROUS: it also matches BlobStoreNotFoundError's "This store
// does not exist.", so a config fault (revoked token, deleted store)
// would silently surface as every-blob-missing across reads/unlinks,
// masking the fatal misconfiguration. The tight name check lets
// BlobStoreNotFoundError / other classes propagate as real exceptions.
export function isNotFound(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return typeof name === 'string' && name === 'BlobNotFoundError'
}

export async function loadVercelBlobSdk(): Promise<VercelBlobSdk> {
  // @ts-ignore optional peer dep: '@vercel/blob'
  const mod = (await import('@vercel/blob')) as VercelBlobSdk
  return mod
}
