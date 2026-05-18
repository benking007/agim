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
import ApprovalsRoute from '@/routes/approvals'
import RemindersRoute from '@/routes/reminders'
import MemosRoute from '@/routes/memos'
import MemoryLayout from '@/routes/memory/layout'
import MemoryFactsRoute from '@/routes/memory/facts'
import MemoryPersonaRoute from '@/routes/memory/persona'
import MemoryVectorRoute from '@/routes/memory/vector'
import MemorySkillsRoute from '@/routes/memory/skills'
import WorkspaceRoute from '@/routes/workspace'

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
  {
    path: '/approvals',
    element: (
      <RequireAuth>
        <ApprovalsRoute />
      </RequireAuth>
    ),
  },
  {
    path: '/reminders',
    element: (
      <RequireAuth>
        <RemindersRoute />
      </RequireAuth>
    ),
  },
  {
    path: '/memos',
    element: (
      <RequireAuth>
        <MemosRoute />
      </RequireAuth>
    ),
  },
  {
    path: '/memory',
    element: (
      <RequireAuth>
        <MemoryLayout />
      </RequireAuth>
    ),
    children: [
      { index: true,     element: <Navigate to="facts" replace /> },
      { path: 'facts',   element: <MemoryFactsRoute /> },
      { path: 'persona', element: <MemoryPersonaRoute /> },
      { path: 'vector',  element: <MemoryVectorRoute /> },
      { path: 'skills',  element: <MemorySkillsRoute /> },
    ],
  },
  {
    path: '/workspace',
    element: (
      <RequireAuth>
        <WorkspaceRoute />
      </RequireAuth>
    ),
  },
  { path: '*', element: <NotFoundRoute /> },
])

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />
}
