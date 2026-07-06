# Release guide

本文记录 Agim 的 npm 发布流程，避免因为上下文过长忘记关键细节。

Agim 的正式 npm 包名是 `agim-cli`。发布不是靠 tag 触发，而是靠 `.github/workflows/release.yml`：当 `package.json` 在 `main` 分支发生变更并被 push 后，GitHub Actions 运行 `Publish to npm`，再由 workflow 执行 `npm publish --access public`。

## 快速结论

- 发布入口：push 到 `main`。
- 必须变更：`package.json` 的 `version`。
- 应同步变更：`package-lock.json` 的版本字段。
- 不需要本机执行：`npm publish`。
- 不依赖 tag：推 tag 不会触发正式发布。
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

发布前至少跑：

```bash
npm run typecheck
npm run build
git diff --check
```

如果本次改动集中在 Web 后台，建议补充跑相关 web 测试：

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

全量 `bun test` 可以运行，但历史上有少量依赖运行环境或全局状态的用例可能在完整套件中失败。不要把这些失败误判为依赖安装问题；若与本次改动无关，需要在发布记录里说明。

全量 `npx biome lint src test` 目前可能受历史 lint/CSS 问题影响。若要作为发布前检查，需区分新增问题和既有问题。

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

只有 npm 上的版本与 `package.json` 不一致时才会安装依赖、构建、测试并发布。若 npm 已经有同版本，workflow 会跳过 publish。

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

