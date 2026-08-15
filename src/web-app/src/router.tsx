/**
 * router.tsx — single source of truth for the SPA routing config.
 *
 * Routes split into two tiers:
 *   * Eager: /login + / (chat) — entry points the operator hits
 *     immediately, so loading them inline avoids a chunk fetch on
 *     the critical first-paint path.
 *   * Lazy: everything else, via react-router's `lazy:` property.
 *     Each `() => import(...)` produces its own Vite chunk, so
 *     /memory etc. only pay their KB when the user navigates there.
 *
 * The whole tree is wrapped in <ErrorBoundary> at the root so an
 * uncaught render error in any child route falls back to the
 * friendly "Something went wrong" surface instead of a blank page.
 */

import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { RequireAuth } from '@/components/shell/require-auth'
import { ErrorBoundary } from '@/components/shell/error-boundary'

import LoginRoute from '@/routes/login'
import ChatRoute from '@/routes/chat'
import NotFoundRoute from '@/routes/not-found'
import { MobileChatRedirect } from '@/components/chat/mobile-chat-redirect'
import { FirstRunRedirect } from '@/components/setup/first-run-redirect'

/** Wrap a `lazy:` factory so the route renders behind RequireAuth.
 *  We can't apply the auth wrapper via element AND lazy, so the
 *  wrap happens once the module loads. */
function authedLazy(factory: () => Promise<{ default: React.ComponentType }>) {
  return async () => {
    const mod = await factory()
    const Cmp = mod.default
    return {
      element: (
        <RequireAuth>
          <Cmp />
        </RequireAuth>
      ),
    }
  }
}

/** Plain `lazy:` for nested route children — they inherit auth from
 *  the parent route's element. */
function lazy(factory: () => Promise<{ default: React.ComponentType }>) {
  return async () => {
    const mod = await factory()
    const Cmp = mod.default
    return { element: <Cmp /> }
  }
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    path: '/setup',
    lazy: authedLazy(() => import('@/routes/setup')),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <FirstRunRedirect>
          <MobileChatRedirect>
            <ChatRoute />
          </MobileChatRedirect>
        </FirstRunRedirect>
      </RequireAuth>
    ),
  },
  {
    path: '/dashboard',
    lazy: authedLazy(() => import('@/routes/dashboard')),
  },
  {
    path: '/tasks',
    lazy: authedLazy(() => import('@/routes/tasks/layout')),
    children: [
      { index: true,       lazy: lazy(() => import('@/routes/tasks/overview')) },
      { path: 'jobs',      lazy: lazy(() => import('@/routes/tasks/jobs')) },
      { path: 'subtasks',  lazy: lazy(() => import('@/routes/tasks/subtasks')) },
      { path: 'bgjobs',    lazy: lazy(() => import('@/routes/tasks/bgjobs')) },
      { path: 'schedules', lazy: lazy(() => import('@/routes/tasks/schedules')) },
      { path: 'outbox',    lazy: lazy(() => import('@/routes/tasks/outbox')) },
      { path: 'a2a',       lazy: lazy(() => import('@/routes/tasks/a2a')) },
      // P1 follow-up — cross-thread admin views (heartbeat / asks).
      { path: 'heartbeat', lazy: lazy(() => import('@/routes/tasks/heartbeat')) },
      { path: 'asks',      lazy: lazy(() => import('@/routes/tasks/asks')) },
      // /tasks/plans UI retired; GET /api/plans stays. Keep the bookmark.
      { path: 'plans',     element: <Navigate to="/tasks" replace /> },
      // Loop Engineering audit (per-run history under ~/.agim/loops/history).
      { path: 'loops',     lazy: lazy(() => import('@/routes/tasks/loops')) },
    ],
  },
  {
    path: '/approvals',
    lazy: authedLazy(() => import('@/routes/approvals')),
  },
  {
    path: '/reminders',
    lazy: authedLazy(() => import('@/routes/reminders')),
  },
  {
    path: '/memos',
    lazy: authedLazy(() => import('@/routes/memos')),
  },
  {
    path: '/memory',
    lazy: authedLazy(() => import('@/routes/memory/layout')),
    children: [
      { index: true,     lazy: lazy(() => import('@/routes/memory/overview')) },
      { path: 'facts',   lazy: lazy(() => import('@/routes/memory/facts')) },
      { path: 'persona', lazy: lazy(() => import('@/routes/memory/persona')) },
      { path: 'distill', lazy: lazy(() => import('@/routes/memory/distill')) },
      { path: 'vector',  lazy: lazy(() => import('@/routes/memory/vector')) },
      // Skills moved into Settings → 技能 (2026-05 second pass). Old
      // /memory/skills + /skills bookmarks redirect to the combined
      // Settings home.
      { path: 'skills',  element: <Navigate to="/settings/agim-skills" replace /> },
    ],
  },
  {
    // Backward-compat: /skills and /skills/installed land on the merged
    // Settings → 技能 area. Keep these forever; they're tiny and protect
    // prior bookmarks / IM-pinned links.
    path: '/skills',
    children: [
      { index: true,        element: <Navigate to="/settings/agim-skills" replace /> },
      { path: 'installed',  element: <Navigate to="/settings/agim-skills/installed" replace /> },
    ],
  },
  {
    path: '/workspace',
    lazy: authedLazy(() => import('@/routes/workspace')),
  },
  {
    path: '/observability',
    lazy: authedLazy(() => import('@/routes/observability/layout')),
    children: [
      { index: true,    element: <Navigate to="health" replace /> },
      { path: 'health', lazy: lazy(() => import('@/routes/observability/health')) },
      { path: 'topn',   lazy: lazy(() => import('@/routes/observability/topn')) },
      { path: 'audit',  lazy: lazy(() => import('@/routes/observability/audit')) },
    ],
  },
  {
    path: '/settings',
    lazy: authedLazy(() => import('@/routes/settings/layout')),
    children: [
      { index: true,        element: <Navigate to="start" replace /> },
      { path: 'start',      lazy: lazy(() => import('@/routes/settings/start')) },
      { path: 'messengers', lazy: lazy(() => import('@/routes/settings/messengers')) },
      { path: 'email',      lazy: lazy(() => import('@/routes/settings/email')) },
      { path: 'viewer',     lazy: lazy(() => import('@/routes/settings/viewer')) },
      { path: 'agents',     lazy: lazy(() => import('@/routes/settings/agents')) },
      { path: 'policy',     lazy: lazy(() => import('@/routes/settings/policy')) },
      { path: 'security',   lazy: lazy(() => import('@/routes/settings/security')) },
      // R13 follow-up — generic "/settings/env" raw editor removed. The
      // domain-specific pages (email / policy / viewer / memory) still
      // mount their own UIs against /api/env for the keys they own; the
      // catch-all editor was a foot-gun and the user explicitly asked
      // for it gone. /api/env GET+PUT endpoints stay (admin-gated).
      { path: 'service',    lazy: lazy(() => import('@/routes/settings/service')) },
      { path: 'admins',     lazy: lazy(() => import('@/routes/settings/admins')) },
      { path: 'workspaces', lazy: lazy(() => import('@/routes/settings/workspaces')) },
      { path: 'llm',          lazy: lazy(() => import('@/routes/settings/llm')) },
      { path: 'mcp',          lazy: lazy(() => import('@/routes/settings/mcp')) },
      { path: 'native-agent', element: <Navigate to="/settings/llm" replace /> },
      // v1.2.126 — web_search provider chain + per-provider API keys.
      { path: 'search',       lazy: lazy(() => import('@/routes/settings/search')) },
      { path: 'stt',          lazy: lazy(() => import('@/routes/settings/stt')) },
      // v1.2.129 — admin generates mobile QR for /m/chat.
      { path: 'mobile',       lazy: lazy(() => import('@/routes/settings/mobile')) },
      {
        path: 'agim-skills',
        lazy: lazy(() => import('@/routes/settings/agim-skills/layout')),
        children: [
          { index: true,        lazy: lazy(() => import('@/routes/settings/agim-skills/overview')) },
          { path: 'installed',  lazy: lazy(() => import('@/routes/settings/agim-skills/installed')) },
          // v1.2.151 — system-prompt injection block editor. Operators
          // see the auto block + can override with their own version.
          { path: 'injection',  lazy: lazy(() => import('@/routes/settings/agim-skills/injection')) },
        ],
      },
    ],
  },
  // v1.2.129 — mobile chat. Renders OUTSIDE the admin shell (no
  // sidebar / no settings layout). Auth still required (cookie set by
  // /m/login auto-submit, which the QR points at).
  {
    path: '/m/chat',
    lazy: authedLazy(() => import('@/routes/m/chat')),
  },
  { path: '*', element: <NotFoundRoute /> },
], {
  future: { v7_relativeSplatPath: true },
})

export function AppRouter(): JSX.Element {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </ErrorBoundary>
  )
}
