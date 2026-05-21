# 可选：gnome-keyring 集成（高级 / 单机维护）

> **注意**：本文档**不属于** agim 默认部署。agim 本身不依赖 dbus / gnome-keyring，纯 server 部署不需要这一层。
>
> 仅当你那台机器**真的需要** keyring（典型场景：cloudflared 在无 GUI session 下走 OAuth、ssh-agent 替代品、git credential helper 等）才参考本文。
>
> 这是机器本地的运维事务，**不会进 npm 包**，每台机器各自维护。

---

## 为什么 agim 仓库要专门给一份文档

R14（PR #51-53）修的"systemctl restart 死循环 + EADDRINUSE"故障，根因是 keyring drop-in 用了 `dbus-run-session -- bash -c '... exec agim start'` 这种 wrapper 写法。dbus / 子 shell 把 agim 子进程从 systemd 的 cgroup 里挂出去，`systemctl stop` 之后 cgroup-kill 失败、老 agim 残留、新进程撞端口。

agim 应用层已经加了 reap + 25s 优雅退出 + 启动自检三道防线兜底，但**根因还是 unit 文件错**。本文档教你**怎么写对**。

---

## ✅ 正确写法：ExecStartPre 起 daemon，ExecStart 直接 exec agim

把 keyring / dbus 的启动放在 `ExecStartPre=`，它跑完退出，**不会进 MainPID 的 cgroup**，所以不会污染 agim 自己的进程组。

`/etc/systemd/system/agim.service.d/keyring.conf`：

```ini
[Service]
# 1. 启 user-session 用的 dbus-daemon（前台跑，写 address 到固定文件，
#    然后让它继续在后台保持），完成后 ExecStartPre 退出。
ExecStartPre=/bin/bash -c ' \
  if [ ! -S /run/user/%U/bus ]; then \
    install -d -m 0700 -o %U -g %U /run/user/%U; \
    /usr/bin/dbus-daemon --session \
      --address=unix:path=/run/user/%U/bus \
      --nofork --nopidfile --print-address & \
    disown; \
    for i in $(seq 1 20); do test -S /run/user/%U/bus && break; sleep 0.1; done; \
  fi'

# 2. 启 gnome-keyring-daemon 把 secrets 服务挂上 dbus，同样后台跑。
ExecStartPre=/bin/bash -c ' \
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus; \
  if ! /usr/bin/dbus-send --session --dest=org.freedesktop.DBus \
       --print-reply /org/freedesktop/DBus \
       org.freedesktop.DBus.ListNames 2>/dev/null \
       | grep -q org.freedesktop.secrets; then \
    /usr/bin/gnome-keyring-daemon --start --components=secrets \
      --daemonize >/dev/null 2>&1 || true; \
  fi'

# 3. 让 agim 看得见这个 dbus socket。
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus"
```

**为什么这样安全：**
- `ExecStartPre=` 跑完 systemd 等它退出再起 ExecStart，pre 命令的进程**不进 MainPID cgroup**
- `dbus-daemon --nofork` + `&` + `disown` 让它作为孤儿进程进 PID 1，不在 agim 的进程树里
- `gnome-keyring-daemon --daemonize` 同样脱离当前进程组
- `ExecStart` 是干净的 `node` 进程，systemd `MainPID = node PID`, cgroup 完整
- 后续 `systemctl stop agim` → cgroup-kill 能把所有 agim 子进程一锅端

`%U` 是 systemd 的占位符，会被替换成 `User=` 指定的 uid（imhub 用户的 uid）。如果你 unit 没用专用账号、跑在 root 下，把 `%U` 换成 `0`。

---

## ❌ 错误写法（R14 故障案例）：dbus-run-session wrapper

这是 R14 故障现场的反例。**不要这样写**：

```ini
[Service]
# 反例 — 不要写在你的 unit 里
ExecStart=/usr/bin/dbus-run-session -- /bin/bash -c 'exec agim start'
```

错在哪：

1. `dbus-run-session` 自己 fork 一个 dbus-daemon 子进程，**这个子进程跟着 ExecStart 进 cgroup**
2. `bash -c` 起 subshell，**subshell 进 cgroup**
3. `exec agim start` 替换 bash 为 node，但前面那个 dbus-daemon 还在
4. systemctl stop → SIGTERM 发给 MainPID (node)；dbus-daemon 拿不到信号
5. cgroup-kill 试图清理整组 → 因为 dbus-daemon 干了些 cgroup 写操作（开 systemd-logind session？），cgroup 标记被破坏 → `Failed to kill control group /system.slice/agim.service, ignoring: Invalid argument`
6. 老 agim 留在那儿不死，新 agim 起来撞端口 → EADDRINUSE 死循环

**症状识别**（你这台机器出现过的）：

```bash
journalctl -u agim --since "5 minutes ago" | grep "Failed to kill control group"
# 命中 → 你的 unit 多半也踩了这个坑
```

```bash
systemctl status agim
# 看 MainPID — 如果是 0 但 sub state 在 activating (auto-restart) 死循环，
# 同样可能是 cgroup 坏了
```

---

## 验证 cgroup 完整

正确部署后，下面三件事都要满足：

```bash
# 1. MainPID 是真 node 进程，不是 dbus-run-session 或 bash
systemctl show agim -p MainPID
# 输出 MainPID=12345，验证：
ps -p 12345 -o comm=
# 应输出 node

# 2. cgroup 里只有 agim 及其合法子进程
systemctl status agim | grep -A 20 "CGroup:"
# 应该只看到 node、approval-bus 相关、子 agent CLI 等
# 不应看到 dbus-daemon、bash、dbus-run-session

# 3. 优雅停止能完整收尾
sudo systemctl stop agim && sleep 2
pgrep -af agim
# 应无输出（reap 兜底跟应用层 25s 强退也都能跑完）
```

如果第二步看到 dbus-daemon 在 cgroup 里，说明你写法不对 —— 换成本文上面那个 `ExecStartPre=` 模式。

---

## 跟 R14 配合

agim 应用层已经做了三道防线，独立于 unit 文件是否正确：

- **R14 §二** —— SIGTERM 后 25s 硬截止 force-exit，配合 `TimeoutStopSec=30` 给 systemd 5s 缓冲
- **R14 §三** —— Web / IM 触发 restart 时先 reap 残留 agim 进程（独立于 cgroup 是否完整）
- **R14 §六** —— start 入口检 pidfile + INVOCATION_ID，发现双开就 exit(2)

但这些都是兜底。**unit 写对了之后这些防线根本不会被触发**。把 keyring 移出 ExecStart 是根因修复。

---

## 不需要 keyring 怎么办

什么都不做。`/etc/systemd/system/agim.service.d/keyring.conf` 不存在的话，agim 完全正常工作。99% 的部署属于这种。

如果你之前装过 keyring drop-in 想清掉：

```bash
sudo systemctl stop agim
sudo rm /etc/systemd/system/agim.service.d/keyring.conf
sudo systemctl daemon-reload
sudo systemctl start agim
```
