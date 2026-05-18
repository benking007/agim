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

import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { RequireAuth } from '@/components/shell/require-auth'

import LoginRoute from '@/routes/login'
import ChatRoute from '@/routes/chat'
import NotFoundRoute from '@/routes/not-found'
import TasksLayout from '@/routes/tasks/layout'
import JobsRoute from '@/routes/tasks/jobs'
import SubtasksRoute from '@/routes/tasks/subtasks'
import BgjobsRoute from '@/routes/tasks/bgjobs'
import SchedulesRoute from '@/routes/tasks/schedules'
import OutboxRoute from '@/routes/tasks/outbox'
import A2ARoute from '@/routes/tasks/a2a'

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
  {
    path: '/tasks',
    element: (
      <RequireAuth>
        <TasksLayout />
      </RequireAuth>
    ),
    children: [
      { index: true,       element: <Navigate to="jobs" replace /> },
      { path: 'jobs',      element: <JobsRoute /> },
      { path: 'subtasks',  element: <SubtasksRoute /> },
      { path: 'bgjobs',    element: <BgjobsRoute /> },
      { path: 'schedules', element: <SchedulesRoute /> },
      { path: 'outbox',    element: <OutboxRoute /> },
      { path: 'a2a',       element: <A2ARoute /> },
    ],
  },
  { path: '*', element: <NotFoundRoute /> },
])

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />
}
