# pi-opencode-delegate

给 [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs) 加后台委派能力：把活丢给 OpenCode 的免费模型，本回合立刻返回，结果稍后作为新消息回来。

这是 async-jobs 生态的第一个扩展（DLC）。它**不 import** async-jobs 的任何运行时模块——只通过 `pi.events` 拿到宿主发布的服务。

## 为什么不能 import

Pi 给每个扩展各自的 jiti 实例，且 `moduleCache: false`。两个扩展 import 同一个文件会得到**两份模块实例**——一份注册表，而引擎读的是另一份。失效是静默的：作业照样送达，只是渲染退化成兜底格式。

所以服务走 `pi.events`：Pi 每个 runtime 建一个总线，发给所有扩展。同一实例，不序列化，函数引用能原样传过去。

## 依赖

需要先装宿主：

```bash
pi install git:github.com/dong615119371/pi-async-jobs@v0.1.3
```

两个都装好后，`/async on` 开启异步模式，`delegate_async` 才可见。

## 装

```bash
pi install git:github.com/dong615119371/pi-opencode-delegate@v0.1.0
```

## 用法

```text
delegate_async(tasks: [
  { task: "把 C:/proj/a.js 里的 var 全改成 const" },
  { task: "统计 C:/proj/src 的代码行数" }
])
```

返回作业号后本回合就结束了。结果稍后自己回来。

**路径必须写绝对路径**——OpenCode 忽略工作目录，永远在用户家目录跑。
## 路径必须写绝对路径

**所有路径必须绝对**——OpenCode 忽略工作目录，永远在用户家目录跑。相对路径会静默指错地方。

## 不要走代理

OpenCode 对免费模型的 IP 风控很严格，报错原文：

```
OpenCode's free models aren't available from your current network
because we've detected abusive traffic from this IP address.
This isn't related to your account.
```

注意是 **this IP address**，不是你的用量。代理节点是共享的，同一个出口 IP 上任何人的流量都算在它头上——别人把你的额度用光了，你这边只会看到 403。

切换到直连后同一个账号立刻恢复。表现：`state: killed`、`exitCode: 1`、输出里有 `provider.auth`。

## 三个文件

| 文件 | 作用 |
|---|---|
| `index.ts` | 注册 `delegate_async` 工具；从宿主拿服务 |
| `channel.ts` | 渲染器：把 JSONL 事件流变成人读文本 |
| `consumer.ts` | 接宿主的模板（本地副本，避免跨包 import） |

## License

MIT。见 `LICENSE`。
