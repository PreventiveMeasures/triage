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
  BlobNotFoundError: new () => Error
  BlobPreconditionFailedError?: new () => Error
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
    blob: { size: number | null; etag?: string; uploadedAt?: Date | string | number }
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
    options?: { token?: string; abortSignal?: AbortSignal; ifMatch?: string },
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
// paths so callers can treat them as success (delete) or not-found (read).
// SDK error subclasses retain `.name === 'Error'`; identify the missing-blob
// class from the same lazily loaded SDK instance that performs the request.
// Store/configuration failures must propagate, never masquerade as cache misses.
export function isNotFound(err: unknown, sdk: Pick<VercelBlobSdk, 'BlobNotFoundError'>): boolean {
  return err instanceof sdk.BlobNotFoundError
}

export async function loadVercelBlobSdk(): Promise<VercelBlobSdk> {
  // @ts-ignore optional peer dep: '@vercel/blob'
  const mod = (await import('@vercel/blob')) as VercelBlobSdk
  return mod
}
