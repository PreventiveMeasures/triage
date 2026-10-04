export interface BundleBuildDiagnostic {
  message: string
  name?: string
  code?: string
  status?: number
  stack?: string
  cause?: BundleBuildDiagnostic
}
export function bundleBuildDiagnostic(error: unknown, token: string | null): BundleBuildDiagnostic
export type BundleBuildStage = 'worker-start' | 'build' | 'scope' | 'serialize' | 'compress'
