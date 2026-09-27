// Register resources as they are acquired. Failed assembly rolls them back in
// reverse order; successful assembly transfers ownership to the returned app.
export async function initializeApp<T>(assemble: (rollback: AsyncDisposableStack) => T | Promise<T>): Promise<T> {
  const rollback = new AsyncDisposableStack()
  try {
    const app = await assemble(rollback)
    rollback.move()
    return app
  } catch (error) {
    try { await rollback.disposeAsync() }
    catch (cleanupError) {
      // AsyncDisposableStack runs every cleanup even if one fails. Preserve
      // both failures so cleanup errors cannot hide the initialization error.
      throw new SuppressedError(cleanupError, error, 'App initialization and cleanup failed')
    }
    throw error
  }
}
