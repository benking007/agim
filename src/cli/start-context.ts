/**
 * Shared mutable runtime state threaded through gracefulShutdown and the start
 * foreground body. Kept in a dedicated file so both modules can share the type
 * without a circular dependency.
 */
export interface StartRuntimeContext {
  shuttingDown: boolean
  shutdownExitCode: number
  /** Set once startWebServer succeeds; undefined when the server failed to start. */
  webServer: { close: () => void; port: number } | undefined
}
