/**
 * Drop a WebSocket client from the live registry only if the map still
 * points at *this* connection. After a get-history rekey, a new socket
 * owns `threadId`; the old socket's close/error must not wipe that entry
 * or terminal `done` / `run-finish` frames are lost and the SPA stays
 * stuck on Running.
 */
export function unregisterClientIfCurrent<T>(
  clients: Map<string, T>,
  id: string,
  client: T,
): boolean {
  if (clients.get(id) !== client) return false
  clients.delete(id)
  return true
}
