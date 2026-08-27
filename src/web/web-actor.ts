/**
 * Actor id stamped on web-chat approvals / jobs.
 *
 * Register (agent RouteContext.userId) and resolve (WS approval-action)
 * MUST use the same value. Logged-in sessions use the account id;
 * anonymous sessions use `web:<threadId>`.
 *
 * Mixing the two (pending = usr_xxx, click = web:web-…) makes
 * requiresExplicitDecision tools such as agim_exit_plan_mode silently
 * ignore the Approve click — the tool spinner never resolves.
 */
export function webChatActorUserId(
  accountUserId: string | undefined,
  threadId: string,
): string {
  const account = accountUserId?.trim()
  if (account) return account
  return `web:${threadId}`
}
