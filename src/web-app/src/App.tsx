/**
 * App — placeholder root component for M1.
 *
 * PR-4 wires it to:
 *   * usePrefs (zustand) — theme cycle + language switch live in the
 *     persistent store, not local component state.
 *   * useTranslation — every label routed through i18n (common.json +
 *     errors.json are cold-loaded inline; route ns lazy-load later).
 *   * QueryClient — `useQuery` against `api.getHealth()` proves the
 *     react-query plumbing + Bearer client + ApiClientError → toast
 *     pipeline end-to-end. The agim backend's /api/health is public,
 *     so this works without a token.
 *
 * Real route assembly (RouterProvider + RequireAuth + /chat /tasks
 * etc.) ships in PR-5+. Don't grow this file — new routes go in
 * routes/, new shell pieces in components/shell/.
 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Laptop, Moon, Sparkles, SunMedium } from 'lucide-react'

import { api } from '@/lib/api/endpoints'
import { describeError } from '@/lib/api/errors'
import { usePrefs, type Lang, type ThemeMode } from '@/stores/prefs'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const SAMPLE_JOBS = [
  { id: 193, agent: 'claude-code', status: 'delivered', preview: '没问题了。你把代码…' },
  { id: 192, agent: 'claude-code', status: 'delivered', preview: '这个趋势线依旧没画…' },
  { id: 191, agent: 'claude-code', status: 'failed', preview: '先不发版本' },
  { id: 190, agent: 'opencode', status: 'pending', preview: '关于技能安装，可以…' },
] as const

const STATUS_VARIANT = {
  delivered: 'success',
  failed: 'danger',
  pending: 'warning',
} as const

export default function App(): JSX.Element {
  const { t } = useTranslation()
  const theme = usePrefs((s) => s.theme)
  const setTheme = usePrefs((s) => s.setTheme)
  const lang = usePrefs((s) => s.lang)
  const setLang = usePrefs((s) => s.setLang)

  // End-to-end smoke: react-query + endpoints.ts + client.ts + i18n
  // all chained. /api/health is public, so this works on a fresh
  // login-less localhost. PR-5 starts proving the same chain on the
  // token-gated endpoints.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  })

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-surface px-4 py-3 pt-safe shadow-sm">
        <span className="text-md font-semibold">
          <span className="mr-2">🤖</span>
          {t('appName')}
        </span>
        <Badge variant="accent">v2 · PR-4</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Select value={lang} onValueChange={(v) => setLang(v as Lang)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t('lang.en')}</SelectItem>
              <SelectItem value="zh">{t('lang.zh')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                <span className="inline-flex items-center gap-2">
                  <Laptop className="h-4 w-4" /> {t('theme.system')}
                </span>
              </SelectItem>
              <SelectItem value="light">
                <span className="inline-flex items-center gap-2">
                  <SunMedium className="h-4 w-4" /> {t('theme.light')}
                </span>
              </SelectItem>
              <SelectItem value="dark">
                <span className="inline-flex items-center gap-2">
                  <Moon className="h-4 w-4" /> {t('theme.dark')}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  toast.success(t('states.saved'), {
                    description: 'Toast → i18n → ' + t('theme.label') + ': ' + t(`theme.${theme}`),
                  })
                }
              >
                <Bell className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('actions.confirm')}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Agim Web v2 — state smoke
            </h1>
            <p className="mt-1 text-sm text-text-dim">
              QueryClient + i18n + zustand 三件套均挂载；下面 `/api/health` 调用
              证明 fetch → ApiClientError → toast 全链路通。
            </p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button>
                <Sparkles /> Try Dialog
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('confirm.deleteTitle')}</DialogTitle>
                <DialogDescription>{t('confirm.deleteDescription')}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <Label htmlFor="demo-name">{t('actions.edit')}</Label>
                <Input id="demo-name" placeholder="agim 在此" />
              </div>
              <DialogFooter>
                <Button variant="ghost">{t('actions.cancel')}</Button>
                <Button variant="destructive">{t('confirm.destructiveAction')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>End-to-end: QueryClient + ApiClient + i18n</CardTitle>
            <CardDescription>
              <code>useQuery</code> against <code>api.getHealth()</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {health.isPending && (
              <div className="text-sm text-text-dim">{t('states.loading')}</div>
            )}
            {health.error && (
              <div className="text-sm text-danger">
                {describeError(health.error, t).message}
              </div>
            )}
            {health.data !== undefined && (
              <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">
{JSON.stringify(health.data, null, 2)}
              </pre>
            )}
          </CardContent>
          <CardFooter className="text-xs text-text-muted">
            queryKey=[&apos;health&apos;] · staleTime 30s · retry 1
          </CardFooter>
        </Card>

        <Tabs defaultValue="components" className="mt-8">
          <TabsList>
            <TabsTrigger value="components">{t('nav.settings')}</TabsTrigger>
            <TabsTrigger value="jobs">{t('nav.tasks')}</TabsTrigger>
          </TabsList>

          <TabsContent value="components">
            <Card>
              <CardHeader>
                <CardTitle>shadcn 组件</CardTitle>
                <CardDescription>
                  全部用 i18n key — 切语言时所有按钮 / Toast 同步翻译。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button>{t('actions.save')}</Button>
                  <Button variant="secondary">{t('actions.edit')}</Button>
                  <Button variant="outline">{t('actions.refresh')}</Button>
                  <Button variant="ghost">{t('actions.cancel')}</Button>
                  <Button variant="destructive">{t('actions.delete')}</Button>
                  <Button variant="link">{t('actions.next')}</Button>
                  <Button disabled>{t('states.loading')}</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge>Default</Badge>
                  <Badge variant="success">{t('actions.save')}</Badge>
                  <Badge variant="warning">{t('actions.cancel')}</Badge>
                  <Badge variant="danger">{t('actions.delete')}</Badge>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="jobs">
            <Card>
              <CardHeader>
                <CardTitle>{t('nav.tasks')}</CardTitle>
                <CardDescription>
                  示例数据；M2 PR-10 接 useJobs() 真接 /api/jobs。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">#</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>{t('actions.search')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {SAMPLE_JOBS.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell className="font-mono text-text-muted">#{j.id}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{j.agent}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[j.status]}>{j.status}</Badge>
                        </TableCell>
                        <TableCell className="text-text-dim">{j.preview}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
