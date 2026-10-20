# pi-delegate

把活外包给 OpenCode CLI。装一个包，按环境给你两种工具。

| 工具 | 需要 async-jobs？ | 行为 |
| --- | --- | --- |
| `opencode` | 不要 | **同步**。阻塞到干完，同一回合拿结果 |
| `delegate_async` | **要** | **异步**。丢出去立刻返回作业号，结果稍后作为新消息回来 |

单独装就是一把可用的同步委派工具，多出来的异步半个不会冒出来。装上 [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs)，异步那半自己开。

## 装

```bash
# 只同步
pi install git:github.com/dong615119371/pi-delegate@v0.1.0

# 同步 + 异步
pi install git:github.com/dong615119371/pi-async-jobs@v0.1.3
pi install git:github.com/dong615119371/pi-delegate@v0.1.0
```

## 什么时候用哪个

| 情况 | 用 |
| --- | --- |
| 下一步**必须**用它的输出（改 → 测 → 读 → 改） | `opencode` |
| 要串行链（`{previous}` 传递上一步结果） | `opencode` |
| 有别的事可做，结果晚点要 | `delegate_async` |
| 批量苦力活，互不相干 | `delegate_async` |

判据一句话：**除了等它，你还能不能干别的。**

## 异步那半怎么接上的

不是 import。Pi 给每个扩展各自的 jiti 实例，`moduleCache: false`——两个扩展 import 同一个文件会得到两份模块实例，一份注册表，而宿主读的是另一份。失效是静默的：作业照样送达，只是渲染退化成兜底格式。

所以走 `pi.events`：Pi 每个 runtime 建一个总线，发给所有扩展。同一实例，不序列化，函数引用能原样传过去。`consumer.ts` 是接宿主的模板。

宿主不出现时 `activate()` 返回 false，`delegate_async` 就停在注册未激活的状态。

## 硬性约束

**所有路径必须写绝对路径**——OpenCode 忽略工作目录，永远在用户家目录跑。相对路径会静默指错地方。

**不要走代理。** OpenCode 对免费模型按 IP 风控，报错原文：

```
OpenCode's free models aren't available from your current network
because we've detected abusive traffic from this IP address.
This isn't related to your account.
```

注意是 **this IP address**，不是你的用量。代理节点共享，同一个出口 IP 上别人的流量也算在它头上。切直连立马恢复。

表现：作业 `state: killed`、`exitCode: 1`、输出里有 `provider.auth`。

**只用免费模型。** 名单实时从 CLI 读，收费 id 在 spawn 之前就被拒。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 同步 `opencode` 工具；决定何时激活异步 |
| `delegate.ts` | 异步 `delegate_async` 工具 |
| `channel.ts` | 异步渲染器：JSONL 事件流 → 人读文本 |
| `consumer.ts` | 接 async-jobs 宿主的模板 |
| `cli.ts` | opencode-cli 封装 |
| `models.ts` | 免费模型列表缓存 |

## License

MIT。见 `LICENSE`。
