import { Navigate, useSearchParams } from 'react-router-dom'

/** Bookmarks to /tasks/subtasks land on the merged Jobs page. */
export default function SubtasksRedirect(): JSX.Element {
  const [params] = useSearchParams()
  const next = new URLSearchParams(params)
  next.set('kind', 'subtasks')
  return <Navigate to={{ pathname: '/tasks/jobs', search: next.toString() }} replace />
}
