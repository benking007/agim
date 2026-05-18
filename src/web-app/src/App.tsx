/**
 * App — placeholder root component for M1.
 *
 * PR-1 verified the toolchain (Vite + React + TS + Tailwind tokens).
 * PR-2 adds shadcn/ui — this file now also exercises Button / Badge /
 * Card / Dialog / Tabs / Select / Tooltip / Toast / Table / Input /
 * Label so a regression in any of them is visible in the smoke route.
 *
 * Real route assembly (RequireAuth, RouterProvider, QueryClientProvider,
 * etc.) ships in PR-4 / PR-5 / PR-6 per the plan. Don't grow this file
 * into App-the-shell; new code goes into routes/ + components/shell/.
 */

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Bell, Moon, SunMedium, Laptop, Sparkles } from 'lucide-react'

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
import { Toaster } from '@/components/ui/sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type ThemeMode = 'system' | 'light' | 'dark'
const THEME_KEY = 'agim-theme'

function getInitialTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* private-mode storage exceptions */
  }
  return 'system'
}

function applyTheme(mode: ThemeMode): void {
  if (mode === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', mode)
  }
}

const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

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
  const [mode, setMode] = useState<ThemeMode>(getInitialTheme)

  useEffect(() => {
    applyTheme(mode)
    try {
      if (mode === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  return (
    <TooltipProvider>
      <div className="min-h-dvh bg-bg text-text">
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-surface px-4 py-3 pt-safe shadow-sm">
          <span className="text-md font-semibold">
            <span className="mr-2">🤖</span>Agim
          </span>
          <Badge variant="accent">v2 skeleton · PR-2</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Select value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  <span className="inline-flex items-center gap-2">
                    <Laptop className="h-4 w-4" /> 跟随系统
                  </span>
                </SelectItem>
                <SelectItem value="light">
                  <span className="inline-flex items-center gap-2">
                    <SunMedium className="h-4 w-4" /> 浅色
                  </span>
                </SelectItem>
                <SelectItem value="dark">
                  <span className="inline-flex items-center gap-2">
                    <Moon className="h-4 w-4" /> 深色
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
                    toast.success('Toast 工作正常', {
                      description: '当前主题：' + THEME_LABEL[mode],
                    })
                  }
                >
                  <Bell className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>触发 Toast</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Agim Web v2 — shadcn smoke
              </h1>
              <p className="mt-1 text-sm text-text-dim">
                每个组件都接到了项目的 HSL token，深浅主题 + system 三态都跑得通。
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
                  <DialogTitle>Hello from a v2 Dialog</DialogTitle>
                  <DialogDescription>
                    打开后 backdrop / 关闭按钮 / 滚动 / 安全区在移动端都能正确处理。
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                  <Label htmlFor="demo-name">名字</Label>
                  <Input id="demo-name" placeholder="agim 在此" />
                </div>
                <DialogFooter>
                  <Button variant="ghost">取消</Button>
                  <Button>保存</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Tabs defaultValue="components" className="mt-8">
            <TabsList>
              <TabsTrigger value="components">组件</TabsTrigger>
              <TabsTrigger value="jobs">任务示例</TabsTrigger>
              <TabsTrigger value="tokens">Token 演示</TabsTrigger>
            </TabsList>

            <TabsContent value="components">
              <Card>
                <CardHeader>
                  <CardTitle>按钮 / 徽标</CardTitle>
                  <CardDescription>
                    所有 variant 都按 hover / focus / disabled 通过 a11y 焦点环测试。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Button>Primary</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="outline">Outline</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="destructive">Destructive</Button>
                    <Button variant="link">Link</Button>
                    <Button disabled>Disabled</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge>Default</Badge>
                    <Badge variant="success">Delivered</Badge>
                    <Badge variant="warning">Pending</Badge>
                    <Badge variant="danger">Failed</Badge>
                    <Badge variant="info">Info</Badge>
                    <Badge variant="accent">Accent</Badge>
                    <Badge variant="outline">Outline</Badge>
                  </div>
                </CardContent>
                <CardFooter className="text-xs text-text-muted">
                  完整组件清单见 src/components/ui/。
                </CardFooter>
              </Card>
            </TabsContent>

            <TabsContent value="jobs">
              <Card>
                <CardHeader>
                  <CardTitle>表格 + 状态徽标</CardTitle>
                  <CardDescription>
                    M2 PR-8 会在这之上加 DataTable 包装层（排序 / 分页 / 行选）。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">#</TableHead>
                        <TableHead>Agent</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>内容</TableHead>
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

            <TabsContent value="tokens">
              <Card>
                <CardHeader>
                  <CardTitle>Token sanity check</CardTitle>
                  <CardDescription>
                    切换主题，色块即时变化。所有 shadcn 组件复用同一套 `--ag-*`。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {(['surface', 'accent', 'success', 'warning', 'danger', 'info'] as const).map(
                      (k) => (
                        <div
                          key={k}
                          className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs"
                        >
                          <span className="font-medium text-text-dim">{k}</span>
                          <span
                            className="h-8 rounded"
                            style={{ background: `hsl(var(--ag-${k}))` }}
                          />
                        </div>
                      ),
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>

        <Toaster />
      </div>
    </TooltipProvider>
  )
}
