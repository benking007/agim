/**
 * router.tsx — single source of truth for the SPA routing config.
 *
 * PR-5 sets up the auth split:
 *   /login    public
 *   /         RequireAuth → HomeRoute (placeholder until PR-6 chat)
 *   *         404
 *
 * Subsequent PRs add /tasks /approvals /reminders /memos /memory
 * /workspace /observability /settings as lazy-imported children of
 * the RequireAuth-wrapped root.
 */

import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { RequireAuth } from '@/components/shell/require-auth'

import LoginRoute from '@/routes/login'
import HomeRoute from '@/routes/home'
import NotFoundRoute from '@/routes/not-found'

const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <HomeRoute />
      </RequireAuth>
    ),
  },
  { path: '*', element: <NotFoundRoute /> },
])

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />
}
