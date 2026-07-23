# Release guide

本文记录 Agim 的 npm 发布流程，避免因为上下文过长忘记关键细节。

Agim 的正式 npm 包名是 `agim-cli`。发布不是靠 git tag，而是靠 `.github/workflows/release.yml`。

**首选路径**：PR 合入 `main` → **Auto Version Bump** 工作流 patch `package.json` → 同一工作流以 `workflow_call` 调用 Publish。注意：仅 bot 推送的 bump commit **不会**单独触发 push 型 Publish 钩子；必须走 `workflow_call`（或下方手动入口），否则会出现 git 版本领先 npm 的漂移。

**手动 / 回退**：在非 bot 的 `main` 提交里 bump `package.json`（+ lockfile），或在 Actions 里对 “Publish to npm” 执行 `workflow_dispatch`。

## 快速结论

- 发布入口：合入 `main` 后的 Auto Version Bump（`workflow_call`），或手动 `workflow_dispatch` / 非 bot 的 version bump push。
- 必须变更：`package.json` 的 `version`。
- 应同步变更：`package-lock.json` 的版本字段。
- 不需要本机执行：`npm publish`。
- 不依赖 tag：推 tag 不会触发正式发布。
- 发布后核对：Actions 绿灯 **且** `npm view agim-cli version` 与 `package.json` 一致；本地可用 `npm run check:npm-drift`。
- 不要求本机 `npm whoami`：发布凭据在 GitHub Actions 里，通过 `NPM_TOKEN` / trusted publishing 路径完成。

## 标准发布流程

### 1. 确认当前状态

```bash
git status --short --branch
git branch --show-current
node -p "require('./package.json').version"
npm view agim-cli version
```

发布前建议位于 `main` 分支，并确认工作区里没有不属于本次发布的改动。若存在他人的改动，不要顺手回退；先确认是否需要纳入本次发布。

### 2. 更新版本号

使用 npm 同时更新 `package.json` 和 `package-lock.json`，但不要创建 git tag：

```bash
npm version <new-version> --no-git-tag-version
```

例：

```bash
npm version 1.5.4 --no-git-tag-version
```

确认版本已经写入：

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
```

### 3. 本地验证

先用锁文件安装根项目与 Web 依赖：

```bash
npm ci
npm --prefix src/web-app ci
```

发布前至少跑：

```bash
npm run lint
npm run typecheck
npm test
npm --prefix src/web-app run typecheck
npm run build
npm --prefix src/web-app run check-i18n
npm --prefix src/web-app test -- --run
npm run test:node
git diff --check
```

`npm run test:node` 包含两层 Node 回归：先验证构建产物中的 memory recall / distill，
再通过 `npm run test:sqlite` 复用后端数据库测试，在真实 `better-sqlite3` 原生模块上覆盖
提醒、备忘录、outbox、任务恢复、审计与保留策略。Bun 中这些数据库用例会有意跳过，
因此发布前不能只执行 `npm test`。

`npm run build` 完成后会自动执行 `npm run check:dist`。该门禁会拒绝
`dist` 中的 `.test.*`、`.spec.*` 和 `__tests__` 产物，避免测试代码进入正式 npm 包。
需要检查最终 tarball 清单与体积时，可额外执行：

```bash
npm pack --dry-run
```

开发过程中若改动集中在 Web 后台，可以先跑相关用例快速回归；发布前仍需跑完上方全量 Web 测试：

```bash
npm --prefix src/web-app test -- --run \
  src/routes/dashboard.test.tsx \
  src/routes/settings/layout.test.tsx \
  src/routes/settings/security.test.tsx \
  src/routes/settings/llm.test.tsx \
  src/routes/settings/agents.test.tsx \
  src/routes/settings/messengers.test.tsx \
  src/routes/settings/workspaces.test.tsx
```

发布门禁不接受 Lint、类型检查、测试或 Web 包体积预算失败；若本机环境因 UNIX socket、DNS 或进程探测限制出现失败，应先在标准 Linux / GitHub Actions 环境确认原因，不能用“历史红”直接放行。`npm run lint` 已覆盖后端和 SPA 源码、样式与测试文件。

### 4. 提交版本

```bash
git add package.json package-lock.json <changed-files>
git commit -m "release: <new-version>"
```

例：

```bash
git commit -m "release: 1.5.4"
```

### 5. 推送 main

```bash
git push origin main
```

如果 HTTPS push 报 403 或凭据不对，切到 SSH 后重试：

```bash
git remote set-url origin git@github.com:benking007/agim.git
ssh -T git@github.com
git push origin main
```

确认远端 main 指向本次提交：

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

两边 SHA 应一致。

## GitHub Actions 发布机制

发布 workflow 位于：

```text
.github/workflows/release.yml
```

触发条件：

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'package.json'
  workflow_dispatch:
```

也就是说：

- push 到非 `main` 分支不会发布。
- 只改代码、不改 `package.json` 不会发布。
- tag push 不会发布。
- 如果是 GitHub bot 自动改版本，GitHub 可能阻止它触发另一个 workflow，这时需要手动 `workflow_dispatch`。

workflow 内部会先比较：

```bash
CURR_VERSION=$(jq -r '.version' package.json)
PUBLISHED_VERSION=$(npm view agim-cli version 2>/dev/null || echo "none")
```

只有 npm 上的版本与 `package.json` 不一致时才会安装依赖、构建、执行后端 Lint、类型检查与测试、Web i18n 与测试、Node SQLite 回归，然后发布。任何一项失败都会阻止 `npm publish`；若 npm 已经有同版本，workflow 会跳过 publish。

## 发布后验证

优先在 GitHub Actions 页面确认 `Publish to npm` 为绿色。

也可以用命令确认 npm registry：

```bash
npm view agim-cli version
```

返回值必须等于刚发布的版本号。

如果刚 push 后 npm 仍显示旧版本，不要立刻重复发版。workflow 需要时间安装依赖、构建和发布。先等待 1-3 分钟后再查：

```bash
npm view agim-cli version
```

如果仍未更新，再去 Actions 看是否未触发或失败。

## 常见坑

### 本机 `gh` 可能不是 GitHub 官方 CLI

有些机器上的 `gh` 可能是 npm 包，不是 GitHub 官方 CLI。表现为：

```text
TypeError: Cannot read properties of undefined (reading 'options')
```

不要依赖这个 `gh run list` 判断发布状态。可改用 GitHub Actions 网页，或先确认：

```bash
which gh
gh --version
```

### GitHub API 404 不一定代表 workflow 不存在

私有仓库或未带 token 的 API 请求可能返回 404。此时用浏览器里的 Actions 页面确认更可靠。

### 不要本机手动 npm publish

正常发布应交给 GitHub Actions，原因是：

- 发布凭据集中在 Actions。
- workflow 会先检查 npm 已发布版本。
- workflow 会固定执行安装、构建和测试步骤。
- 本机 npm 登录状态与官方发布路径无关。

### package-lock 也要同步

只手改 `package.json` 容易让 lockfile 版本漂移。优先使用：

```bash
npm version <new-version> --no-git-tag-version
```

### release commit 必须包含 package.json

`release.yml` 的路径过滤只监听 `package.json`。如果版本变更没有进入最终 push，发布不会触发。

## 发布完成检查清单

- [ ] `package.json` 版本已更新。
- [ ] `package-lock.json` 版本已同步。
- [ ] 本地验证通过，或已记录不影响发布的历史问题。
- [ ] release commit 已提交到 `main`。
- [ ] `origin/main` 指向本次 release commit。
- [ ] GitHub Actions `Publish to npm` 运行成功。
- [ ] `npm view agim-cli version` 返回新版本。
