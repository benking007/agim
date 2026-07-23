# Web 端点合同维护

Agim 将服务端路由清单与 SPA API 封装分开维护：

- **实现来源**：`src/web/*.ts` 域模块（`*-api.ts`、`auth.ts` 等）。`src/web/server.ts` 只做 pathname **prefix 委托**，多数 exact/dynamic 匹配不在组合根内。
- `src/web-app/tools/endpoints.json`：由提取器扫描上述源文件生成的直接 REST 路由清单。
- `src/web-app/src/lib/api/endpoints.ts`：手工维护的类型化 SPA facade，不是生成文件。

架构背景见 [`architecture/current.md`](./architecture/current.md)。

## 日常检查

```bash
npm run check:contracts
```

检查包含两层：

1. 重新扫描 `src/web/*.ts`（排除 `*.test.ts`）并与已提交的 `endpoints.json` 比较；`--check` 模式不会写文件。
2. 使用 TypeScript AST 读取 `endpoints.ts` 中的 `client.get/post/put/patch/delete` 调用，确认每个 SPA 封装都对应真实服务端路由，并拒绝重复封装。

CI 与 npm 发布工作流都会执行该命令。

## 新增或删除路由

在对应域模块（例如 `src/web/jobs-api.ts`）增删路由后，若 `server.ts` 尚无该前缀委托，再补一条 prefix。然后执行：

```bash
npm --prefix src/web-app run update-endpoints
npm run check:contracts
```

提交并审查 `endpoints.json` 的变更。普通静态路由（`p === '...'` / `url.pathname === '...'`）会自动提取；使用 `url.pathname.match(...)` 的动态路由还需在 `tools/extract-endpoints.mjs` 的 `dynamicRoutes` 中声明。提取器会拒绝未声明的新动态路由和已经失效的旧声明。

只有 SPA 实际使用某个路由时，才在 `src/lib/api/endpoints.ts` 中增加类型化封装。不要重新引入覆盖该文件的生成器。

## 范围边界

清单覆盖 `startWebServer` 路径上可直达的 REST 路由（含域模块内匹配）。`/api/llm`、`/api/mcp`、`/api/goals` 等委托路由器的**内部子路径细节**仍以各模块测试为准；顶层前缀与已声明的动态路由会出现在清单中。
