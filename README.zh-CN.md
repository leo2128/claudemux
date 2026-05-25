[English](./README.md) · **简体中文**

# claudemux

> `claude` + `tmux`。一个 dispatcher 会话跟你对话,每个 repo 一个 teammate
> 跑在自己的 tmux session 里,你用大白话指挥整支 fleet。

## 架构

```mermaid
flowchart TB
    user(["你<br/>(终端 · 网页 · 移动端)"])

    subgraph dispatcher_dir["dispatcher 目录 · 你 repo 的共同父目录"]
        dispatcher["dispatcher<br/>(tmux 里的 claude,跟你对话)"]
        repoA[("repo-a/")]
        repoB[("repo-b/")]
        repoC[("repo-c/")]
    end

    subgraph teammates["teammates · 每个 repo 一个 tmux session"]
        tA["teammate-repo-a<br/>(claude in repo-a/)"]
        tB["teammate-repo-b<br/>(claude in repo-b/)"]
    end

    user <-->|聊天| dispatcher
    user -.->|可选:Remote Control<br/>直接驱动| tA
    dispatcher -->|tm spawn / send / wait| tA
    dispatcher -->|tm spawn / send / wait| tB
    tA -.cwd.-> repoA
    tB -.cwd.-> repoB
```

## 跨设备驱动 teammate

每个 teammate 都是真实的 `claude` REPL,自带 Remote Control URL。浏览器
打开、手机 app 打开,就是直接在跟这个 teammate 对话——不用回终端。

- 地铁上用手机看长跑的 teammate 进展
- 咖啡馆笔记本上接着派新活,dispatcher 同时继续协调其他 teammate
- 三台设备三个窗口,并行驱动同一支 fleet

`/claudemux:setup` 会帮你打开 Claude Code 的 `remoteControlAtStartup`,
之后每个 teammate 一起来就注册好自己的 URL。

## 安装

任意 Claude Code 会话里:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
/reload-plugins
```

然后 `cd` 到你 sibling repo 的共同父目录,启动 dispatcher:

```bash
cd ~/path/to/your/dev-dir
claude
```

REPL 里:

```
/claudemux:setup
```

## 快速上手

直接说人话,`dispatcher` 技能会接住:

> 派一个 teammate 去 repo-a 跑测试
>
> 看看 repo-b 现在在干啥
>
> 让 repo-a 跑 lint,同时让 repo-b 升级 react 到 19

或者直接调 `tm`:

```bash
tm spawn repo-a --prompt 'run yarn test in unit-test'   # 原子化:起 + 派 + 等 + 打印首轮回话
tm send  repo-a --prompt '接着跑 lint'                   # 同步 send,回话直接落 stdout
tm states                                               # 一览整支 fleet
tm kill  repo-a                                         # 收掉
```

## `tm` 命令

Claude Code 会话里 `tm` 自动在 `PATH` 上。会话外用法见
[在 Claude Code 之外用 `tm`](#在-claude-code-之外用-tm)。

| 子命令 | 作用 |
|---|---|
| `tm ls` | 列出在跑的 teammate session。 |
| `tm states` | 一行一个的整体快照:repo、sid、忙不忙、上次回复多大多久前、首 50 字。 |
| `tm spawn <repo> [--task <slug>] [--prompt "…"]` | 起 teammate。带 `--prompt` 即原子 bootstrap:spawn + send + 等 Stop + 把首轮回话打到 stdout。`--task <slug>` 给会话起个可读名字(`<repo>-<slug>`;ASCII 字母数字 + 中文汉字都可以);不传就是 `<repo>-<rand4>`。 |
| `tm resume <repo> [<sid-or-thread-id>] [--task <slug>] [--prompt "…"]` | 恢复旧会话。Claude 用 transcript `sid`,不传可按 mtime 选最新 jsonl。Codex 必须显式传 `/tmp/teammate-codex/<name>/thread` 或 rollout 文件名里的 thread id,会重新起 app-server daemon 并调用 `thread/resume`。`--prompt` 在重连后派 prompt(行为同 `spawn --prompt`)。 |
| `tm send <repo> --prompt "…" [--pane-quiet] [--timeout N]` | **原子 round-trip**:发 prompt + 等 Stop + 把回话打到 stdout。Stop-hook 路径还把当前 ctx 顺手打到 stderr(`ctx: N tokens · …`),消灭 send 完再单独 `tm ctx` 的高频模式;`--pane-quiet` 不打。`--prompt` 和 `tm spawn --prompt` / `tm resume --prompt` 一套写法(三动词一个 API);flag / `<repo>` 顺序自由。`--pane-quiet` 给 TUI-only(`/help` / `/effort` / 权限弹窗)兜底,这些路径不触发 hook。 退码:`0` 拿到回话;`124` sync wait 超时,但 teammate 还在跑(用 `tm wait <repo>` 续等;别重新 spawn,name 还占着);`1` 真失败(没 session / sid marker 缺失等)。 |
| `tm wait <repo> [timeout=600] [--fresh] [--pane-quiet] [--timeout N]` | 阻塞到 teammate 下一次 Stop,打回话到 stdout(ctx 走 stderr,行为同 `tm send`)。外部驱动(Remote Control / 移动端 / cron)推动的 turn 用这个收。`--fresh` 等下一次 Stop 而不是被已有 marker 立即满足(`--pane-quiet` 模式下 `--fresh` 不生效)。`--timeout N` 等价位置参数 `[timeout]`。退码同 `tm send`。 |
| `tm compact <repo> [timeout=600] [--timeout N]` | 发 `/compact` + 等 PostCompact;成功 stdout 一行 `compacted`。不读 ctx(单独跑 `tm ctx`,或者下次 `tm send` 顺手就有)。默认 600s 是因为大上下文(~300k+)实测要 3-4 分钟。退码:`0` PostCompact 触发;`1` Claude Code 回 "Not enough messages to compact"(扫 pane 命中,立即退出,不死等);`124` `--timeout` 到了 PostCompact 还没触发,compact 可能还在跑。 |
| `tm last <repo>` | 打印 teammate 上一轮回复的完整正文。fresh spawn 之后还没派活时,die 报 "no reply yet"。 |
| `tm kill <repo>` | 干掉 teammate 的 tmux session,清状态文件。 |
| `tm archive <id> [--status '<tag>']` | 把 `active-dispatcher-tasks.md` 里一个收尾的 task 搬到 archive(收尾文字从 stdin 进)。 |
| `tm ctx <repo>… \| --all [--window 200k\|1m]` | 每个 teammate 的真实上下文用量,从 jsonl 的 `usage` 字段读,比 TUI 那个百分比准。 |
| `tm history <repo> [<sid-or-thread-prefix>]` | 列 `<repo>` 的 Claude 历史 session 或 Codex thread(最新在前)。每行显示完整的 Claude `sid` 或 Codex thread id —— 即 `tm resume` 接受的字符串;当前 live session/thread 标 `*`。传 sid / thread-id 前缀则展开详情,并给出可直接粘贴的 `tm resume` 命令。 |
| `tm mem <repo>` | cat sibling 仓的 auto-memory `MEMORY.md`(FG 名 / 分支 / 进行中项目)。在塑造 `tm spawn` / `tm send --prompt` **引用 sibling 状态前**先调一下 —— dispatcher 自己的 AutoMemory 不包含 sibling 仓。文件不存在 → stderr 一行提示 + exit 0 + 空 stdout。 |
| `tm reload <repo>… \| --all` | 给 teammate 派 `/reload-plugins`,插件更新后用。 |

诊断用(上面 verb 都不合适时再用):`tm status <repo>` 抓实时 pane,
`tm poll <repo> <regex>` 等中间状态。

行为契约和磁盘状态见
[`plugins/claudemux/skills/dispatcher/SKILL.md`](plugins/claudemux/skills/dispatcher/SKILL.md)。

## `/claudemux:optimize` —— 周期自检

随包一个技能,扫 dispatcher 最近的对话,识别反复踩的坑、没沉淀的约定,
按合适的载体写进 `CLAUDE.md` 或项目 memory。跑在 fork 出来的独立上下文
里,返回一份简短报告。手动调用,或用 `CronCreate` 排成每周一次。

## 依赖

| 工具 | 用途 |
|---|---|
| Claude Code CLI | 插件挂在它上面。 |
| Node 22.7+ | `tm` 直接用 Node 的实验性 type-transform 跑 TypeScript 源码——没有 `npm install`,没有 build 步骤。22.7 是引入 `--experimental-transform-types` 的版本。 |
| `tmux` | Teammate 跑在 tmux session 里。 |
| `jq` | Stop hook 解析 harness JSON。 |
| `bash` | 插件脚本用 Bash 特性。 |
| macOS 或 Linux | 脚本用 BSD `stat`,Windows 不支持。 |

## 配置

没有。dispatcher 目录就是你 `cd` 过去跑 `claude` 的那个地方——`tm` 在
调用时直接拿 `$PWD`。换目录就 `cd` 到别处,没全局状态文件要改。

## 在 Claude Code 之外用 `tm`

`tm` 在插件里是 `bin/tm`。普通终端要用的话,做一次软链:

```bash
ln -sf ~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm ~/.local/bin/tm
```

确认 `~/.local/bin` 在 `PATH` 上。`<version>` 换成实际装的版本号。

## 已知限制

- **只支持单 dispatcher 根**。`tm spawn <repo>` 把 `<repo>` 按
  `$PWD/<repo>` 解,sibling repo 必须共享一个父目录。
- **只 macOS / Linux**。脚本用 BSD `stat`,GNU Linux 需要
  `-c %Y`——PR welcome。
- **Cron 只在 dispatcher REPL 里 fire**。`claude -p` 或 Agent Teams
  teammate 里 `CronCreate` 返回成功但永不触发。

## 本地开发

### 一次性

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

### 持久(推荐)

```bash
claude plugin marketplace add ~/src/claudemux --scope local
claude
# REPL 里:
/plugin install claudemux@claudemux
```

`/reload-plugins` 热加载 skill / command / hook / `tm` 脚本,不用重启。

clone 后跑一次启用 pre-commit hook:

```bash
git config core.hooksPath .githooks
```

它会拦截同一提交里改了某个插件 feature-class 路径却没有 changeset 声明
变更的 commit。`plugins/` 下每个插件各自独立计版:feature 提交用
`bin/changeset <插件> <patch|minor|major> "<摘要>"` 记录变更,之后由
`bin/release <插件>` 把累积的 changeset 汇成一次版本号抬升和 CHANGELOG 条目。

## 卸载

```
/plugin uninstall claudemux
```

插件和它的 hook 一起摘掉。dispatcher 目录里的 `CLAUDE.md` 留在原地——
不想要就手动删。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
