# `src/web-app/` — agim Web 后台

当前后台是 React SPA，统一通过 `index.html` + `/assets/*` 提供页面与静态资源。
不再维护旧版多 HTML 页面形态，所有后台功能都在这一套前端中演进。

## 开发流程

需要两个终端：

```bash
# 终端 1：后端 (port 3000)
bun src/cli.ts start          # 或 node dist/cli.js start

# 终端 2：前端 dev server (port 5173) + 自动代理 /api /ws /events
npm --prefix src/web-app install   # 一次性
npm --prefix src/web-app run dev
```

打开 <http://localhost:5173/> 访问开发版前端，登录页用 token 走真后端。

## 生产构建

根目录 `npm run build` 会调用 `npm --prefix src/web-app run build`，把
`src/web-app/dist/*` 拷到 `dist/web/public/`，最终随 `agim-cli` npm 包发布。

## 目录结构（设计目标）

```
src/web-app/
├── public/                  static 资源（manifest / favicon / vendor）
├── src/
│   ├── routes/              一文件一路由（chat / tasks / approvals / ...）
│   ├── components/
│   │   ├── ui/              shadcn 原件（PR-2 引入）
│   │   ├── shell/           Topbar / Drawer / ThemeToggle / RequireAuth
│   │   ├── common/          DataTable / EmptyState / ConfirmDialog / KpiCard
│   │   └── <domain>/        per-route 业务组件
│   ├── lib/api/             fetch client / endpoints / ws / sse / error map
│   ├── hooks/               用 react-query 包 service 的 hooks
│   ├── stores/              zustand persist (theme / lang / prefs)
│   ├── i18n/                react-i18next + locales/{en,zh}/<ns>.json
│   ├── styles/              tokens.css + globals.css
│   └── types/               DTO + WS message union
├── index.html               viewport / theme bootstrap / safe-area meta
├── tailwind.config.ts       HSL token → tailwind theme
├── vite.config.ts           proxy /api /ws /events to localhost:3000
└── tsconfig.json
```

## 移动端基线（M1 已落地）

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- iOS / Android safe-area utilities：`pt-safe`/`pb-safe`/`px-safe`
- `100dvh` 高度（兼 100vh fallback）：`h-dvh` / `min-h-dvh` 工具类
- 触屏 hit target ≥ 44×44：`.tap-target` 工具类
- `touch-action: manipulation` + tap highlight 调淡（preflight）
- PWA `manifest.webmanifest` + theme-color + apple-mobile-web-app-* meta
