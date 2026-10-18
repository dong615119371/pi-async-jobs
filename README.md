# async-jobs

给 Pi 的 agent loop 加「后台作业」能力：慢命令不再占住整个回合。

一条 5 分钟的构建会卡住整轮对话，因为 Pi 的 agent loop 是同步的——工具必须先返回，模型才继续生成。本插件不改 loop，只把**等待**从工具侧移走：命令立刻返回作业号，模型继续干活，结果稍后作为一条消息送回来。

## 核心特性

| 特性 | 说明 |
| --- | --- |
| bash 自动后台化 | 异步模式开启后，命令超过宽限期仍未结束就转后台，返回作业号 |
| `expectSeconds` | 给出**任务耗时**估计来决定等多久。不杀命令、不限运行时长 |
| `mode: "background"` | 完全不等待，立即返回作业号 |
| 作业持久化 | 记录原子落盘（先写 `.tmp` 再改名）；重启后遗留的 `running` 标为 `failed` |
| 结果主动送达 | 完成或失败的作业自动唤醒模型；多个作业按 3 秒窗口合并；被 kill 的不再通知 |
| 四个工具 | `job_status` / `job_logs` / `job_kill` / `job_history` |
| 渠道注册表 | 渲染器可插拔。框架只内置 `generic`，其他渠道由对应扩展自行注册 |
| 进程树终止 | `kill` 终止整棵进程树，等进程真正退出才返回 |

> 这些工具默认**未激活**。`bash` 覆盖始终注册，但异步模式关闭时转发给 Pi 自带的 bash，行为不变。

## 安装

把 `async-jobs/` 整个目录拷进 Pi 的 extensions 目录（位置随安装方式不同，见 Pi 官方文档）。

运行时数据落在 `<Pi agent dir>/async-jobs/`：

| 文件 | 内容 |
| --- | --- |
| `<id>.json` | 作业记录（原子写） |
| `<id>.output` | 作业输出 |
| `job-history-YYYY-MM-DD.jsonl` | 持久历史（保留今天与昨天） |
| `mode.json` | 异步模式开关 |
| `config.json` | 宽限期配置 |

## 快速开始

异步模式默认关闭，先打开：

```bash
/async on     # 开启，模型才能看到后台工具
/async        # 查看当前状态
/async off    # 关闭（已跑的作业不受影响）
```

开启后，模型调用 `bash` 时可以带两个参数：

```text
bash(command: "git status")
  → 按默认宽限期（20 秒）等，秒回就正常返回结果

bash(command: "npm run build", mode: "background")
  → 直接转后台，不等

bash(command: "pytest -q", expectSeconds: 45)
  → 估 45 秒：小于 120 秒就按估计等，达到 120 秒直接转后台
```

结果会自己送回来，无需轮询。需要主动查看时用工具：

```text
job_status                   # 列出后台作业（可 cleanup / verbose）
job_logs aj-1a2b3c4d         # 看某作业的最新输出
job_kill aj-1a2b3c4d         # 停止某作业
job_history                  # 翻历史作业（跨会话）
```

用户也可直接用斜杠命令：`/jobs`、`/job-logs <id>`、`/job-kill <id>`、`/job-history [count]`。

## 工具参考

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `job_status` | 列出本会话的后台作业并读结果 | `jobs`（省略=全部）、`cleanup`（删已完成记录）、`verbose`（完整结果） |
| `job_logs` | 读某作业的最新输出 | `id`（接受唯一前缀）、`maxBytes`（默认 4000）。从输出文件尾部读 |
| `job_kill` | 停止运行中的作业 | `id`、`reason`。整棵进程树终止，等进程真没了才回 |
| `job_history` | 持久历史，旧的在前 | `count`（默认 **20**，范围 1–200）、`id`、`full`。跨重启、跨 `/reload` |

`job_status` 只列真正的后台作业——宽限期内跑完、结果内联返回的命令不算。
`job_history` 的**斜杠命令** `/job-history [count]` 默认取 **15** 条，与工具的 20 不同。

## expectSeconds 决策表

它估的是**任务耗时**，不是「你愿意等多久」。

| 取值 | 行为 |
| --- | --- |
| 省略 / 非有限数 | 用默认宽限期（20 秒），到时仍运行就转后台 |
| `x < 120` | 按 x 秒等待，到时仍运行就转后台 |
| `x ≥ 120` | 完全不等待，立刻返回作业号 |

**写大数字不会让你更快拿到结果**——它只会立刻转后台。低估是安全的：命令照跑，结果作为消息回来，只多一个来回。所以已知很长的任务（安装、克隆、构建、整套测试）不要估，直接 `mode: "background"`。

## 默认值一览

| 项 | 值 |
| --- | --- |
| 默认宽限期 | 20 秒（`config.json` 里 `graceSeconds` 可改，每次调用读取） |
| 并发上限 | 7（超出排队，槽位释放后自动启动） |
| kill 上限 | 普通 15 分钟 / 长任务 45 分钟 / **已自行后台化的命令 30 分钟**；显式 `timeout` 优先 |

第三档指命令命中 `nohup`、`setsid`、`Start-Process`、`Start-Job` 或结尾单个 `&`——这些不加自动上限，回退 30 分钟。

## 已知行为

- **子代理不能开后台作业**：`PI_SUBAGENT_DEPTH > 0` 时工具直接拒绝，防止任务层层外抛。

## 已知限制

- **只在 Windows 上开发与验证。** 进程树终止用 `taskkill /T`（再 `/F`），shell 解析查找 Git Bash。代码里有 POSIX 分支（进程组信号、`/bin/sh`），但**未经测试**。
- **进程树终止可能残留孤儿进程。** 是否终止依赖存活探测；探测不可靠时无法保证整棵子树都已结束，此时仅在结果里标记 `leaked`。

## 设计说明

**为什么改工具侧而不改 loop。** loop 同步是刻意的：工具必须先返回，模型才能接着生成。让慢命令不阻塞只有两条路——改 loop，或在工具层把「等待」抽走。这里选后者：进程照常启动，只把「报告」改成「先给作业号、结果后到」。改动面小，不碰 Pi 的核心。

**渠道注册表做什么。** 框架会跑进程、跟踪、杀掉、落盘、送达，但它不知道某个渠道的输出流长什么样——那份知识属于贡献该渠道的扩展。`channels.ts` 让扩展注册 `render` / `digest`，框架按 `record.channel` 查表。于是加渠道不用改本包，卸掉某个渠道扩展也不影响其他渠道；没注册渲染器的作业走内建回退，照样送达。

**为什么 kill 要等进程真死。** `child.kill()` 只信号直接子进程，它派生的孙子进程会活着。所以先杀整棵树（Windows 上 `taskkill /T`，再 `/F` 兜底），再用存活探测确认进程真没了才返回——「发了信号」和「已经没了」是两回事。

## 跑测试

共 10 个测试文件（`async-jobs/_*.mts`），逐个用 `node` 跑：

```bash
node async-jobs/_smoke.mts
node async-jobs/_grace.mts
node async-jobs/_gracepolicy.mts
node async-jobs/_batch.mts
node async-jobs/_channels.mts
node async-jobs/_encoding.mts
node async-jobs/_journal.mts
node async-jobs/_status.mts
node async-jobs/_timeout.mts
node async-jobs/_stress.mts
```

需要 Node 能直接运行 TypeScript（类型剥离）。全部通过时进程退出码为 0。

## License

MIT。见 `LICENSE`。
