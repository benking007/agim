# Web 端点合同维护

Agim 将服务端路由清单与 SPA API 封装分开维护：

- `src/web/server.ts` 是服务端路由的实现来源。
- `src/web-app/tools/endpoints.json` 是由服务端提取的直接 REST 路由清单。
- `src/web-app/src/lib/api/endpoints.ts` 是手工维护的类型化 SPA facade，不是生成文件。

## 日常检查

```bash
npm run check:contracts
```

检查包含两层：

1. 重新扫描 `server.ts` 并与已提交的 `endpoints.json` 比较；`--check` 模式不会写文件。
2. 使用 TypeScript AST 读取 `endpoints.ts` 中的 `client.get/post/put/patch/delete` 调用，确认每个 SPA 封装都对应真实服务端路由，并拒绝重复封装。

CI 与 npm 发布工作流都会执行该命令。

## 新增或删除路由

修改 `src/web/server.ts` 后执行：

```bash
npm --prefix src/web-app run update-endpoints
npm run check:contracts
```

提交并审查 `endpoints.json` 的变更。普通静态路由会自动提取；使用 `url.pathname.match(...)` 的动态路由还需在 `tools/extract-endpoints.mjs` 的 `dynamicRoutes` 中声明。提取器会拒绝未声明的新动态路由和已经失效的旧声明。

只有 SPA 实际使用某个路由时，才在 `src/lib/api/endpoints.ts` 中增加类型化封装。不要重新引入覆盖该文件的生成器。

## 范围边界

清单覆盖 `startWebServer` 直接分发的 REST 路由。`/api/llm`、`/api/mcp`、`/api/goals` 等委托给独立协议路由器的内部路径不在此清单中；它们应在各自模块的测试中维护合同。
