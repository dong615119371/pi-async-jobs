# 更新日志

async-jobs 插件的所有重要变更都记录在此。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-18

### 新增

- **bash 工具**：命令超过宽限期仍未结束，自动转为后台作业并返回作业号；结果随后作为一条新消息送达。
- **`expectSeconds` 参数**：由调用方给出任务耗时的估计。估计值低于 120 秒时，按该秒数等待；达到或超过 120 秒则完全不等待，直接转为后台作业。
- **`mode: "background"`**：跳过等待，立即返回作业号。
- **四个工具**：`job_status` / `job_logs` / `job_kill` / `job_history`。
- **五个斜杠命令**（供用户使用）：`/async`、`/jobs`、`/job-logs`、`/job-kill`、`/job-history`。
- **渠道注册表（`channels.ts`）**：渲染器可插拔。框架只内置一个 `generic` 默认渲染器，不含任何特定渠道的分支；其余渠道由对应的扩展自行注册。
- **作业持久化**：作业记录按文件原子落盘（先写 `.tmp` 再改名），会话重启后可通过 `recover()` 恢复；启动时会把上次遗留在 `running` 状态的作业标记为 `failed` 并提示。
- **进程树终止**：`kill` 会终止整棵进程树，并等进程真正退出（存活探测确认），而不是只发出信号。

### 已知限制

- **目前仅在 Windows 上开发与验证**。进程树终止在 Windows 上通过 `taskkill /T`（再 `/F` 兜底）实现，shell 解析在 Windows 上查找 Git Bash（`process.ts`、`engine.ts`）。代码中另有 POSIX 分支（进程组信号、`/bin/sh`），但这些分支未经测试验证。
- **进程树终止可能残留孤儿进程**。退出与否依赖存活探测（`isAlive`），探测不可靠时无法保证整棵子树都已终止；此时只在结果中标记 `leaked`，没有可靠的检测手段（`process.ts` 记录了相关实测案例）。

### 已知行为

- **`es` 工具的超时会被强制补到 30 秒**：若调用没显式给 `timeoutSeconds`，本插件会塞一个。这是从被废弃的 `global-timeout` 扩展接管来的。
- **子代理不能开后台作业**：`PI_SUBAGENT_DEPTH > 0` 时工具直接拒绝，防止任务层层外抛。

### 测试

- 共 10 个测试文件（`async-jobs/_*.mts`），合计 **398 条断言全部通过**（PASS 398 / FAIL 0），进程退出码均为 0。
