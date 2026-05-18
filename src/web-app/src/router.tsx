/**
 * router.tsx — single source of truth for the SPA routing config.
 *
 * PR-5 split: /login public, / protected, * → 404.
 * PR-6: `/` is the chat surface (was a placeholder).
 *
 * Subsequent PRs add /tasks /approvals /reminders /memos /memory
 * /workspace /observability /settings as lazy-imported children of
 * the RequireAuth-wrapped root.
 */

import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { RequireAuth } from '@/components/shell/require-auth'

import LoginRoute from '@/routes/login'
import ChatRoute from '@/routes/chat'
import NotFoundRoute from '@/routes/not-found'

const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <ChatRoute />
      </RequireAuth>
    ),
  },
  { path: '*', element: <NotFoundRoute /> },
])

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />
}
