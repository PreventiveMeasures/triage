// The static server only needs to recognise managed pages, not resolve them.
export function parseManagedRoute(url: URL): { view: string } | null
