# remote-ssh-mcp

给 AI agent 用的远程运维工具，是一个 MCP 服务。agent 只要说出 `~/.ssh/config` 里的主机别名，比如 `web1`，就能在那台服务器上跑命令、查容器、改配置、看服务状态，效果等同于 `ssh web1 …`，但不用 agent 自己拼 ssh 命令和多层引号。

## 能做什么

- 在 `~/.ssh/config` 里配好的任意主机上跑命令，结果直接返回给 agent。
- 一次调用同时跑几条互不依赖的命令，或在几台主机上同时跑同一条命令，结果按标签分段返回。
- 脚本和数据经标准输入传过去，在容器里跑命令，在 Windows 主机上跑 PowerShell，都不需要 agent 自己处理多层引号。
- 写远端文件或只改其中几处，会覆盖前自动备份到 `~/ops-backups/`。
- 把一台主机上命令的输出直接接到另一台主机的命令上，或把本机文件推到主机上，数据不落本机磁盘。
- 非 root 账号也能以 root 身份运行命令，sudo 要密码时由 agent 传入。
- 输出里的密码、token 默认打码。
- 重启关机、装包卸包这类危险命令默认拦下，并提示 agent 让用户手动执行。

## 工具一览

| 工具 | 做什么 | 默认出现 |
|---|---|---|
| `exec` | 跑任意命令 | 是 |
| `file_write` | 覆盖、追加或局部修改文件，覆盖和修改前自动备份 | 是 |
| `pipe` | 在主机之间搬数据，或把本机文件推到主机上 | 是 |
| `xui_api` | 调用 x-ui / 3x-ui 面板接口 | 否 |
| `reboot` | 重启主机并等它回来 | 否 |
| `cf_api` | 从本机调用 Cloudflare API | 否 |

默认不出现的工具，要用时在环境变量 `SSH_MCP_TOOLS` 里写上，如 `exec,file_write,pipe,xui_api`。
每个工具的参数、例子和返回格式见 [docs/tools.md](docs/tools.md)。

## 适用范围

- 适合在 `~/.ssh/config` 里配好的 Linux 主机上排查问题、改配置。
- Windows 主机用 `exec` 加 `shell`（可用 `SSH_MCP_HOST_SHELLS` 设成默认），其余工具都按 Linux 命令写。
- Windows PowerShell 5.1 和 pwsh 7 已在 Windows 11（Win32-OpenSSH，默认 shell 为 Git Bash）上实测过。
- 需要交互式终端的操作（`top`、`vim`）请直接开 ssh。

## 环境要求

- Node.js 20 或更新。
- 本机装有 OpenSSH 客户端，`~/.ssh/config` 里配好主机别名，并且能用密钥免密登录。

## 安装

把下面的配置加进你的 MCP 客户端，`npx` 会自动下载最新版：

```json
{
  "mcpServers": {
    "remote-ssh": {
      "command": "npx",
      "args": ["-y", "@arcdent/remote-ssh-mcp"]
    }
  }
}
```

想固定版本就写成 `@arcdent/remote-ssh-mcp@0.2.0`。从源码运行时，先在仓库里 `npm install`（会顺带构建），再把配置改成 `"command": "node"`、`"args": ["/path/to/remote-ssh-mcp/dist/index.js"]`。

<details>
<summary>Claude Code</summary>

```sh
claude mcp add remote-ssh -s user -- npx -y @arcdent/remote-ssh-mcp
```

要放开某类危险命令时加 `-e`，如 `claude mcp add remote-ssh -s user -e SSH_MCP_ALLOW_PKG=1 -- npx -y @arcdent/remote-ssh-mcp`。

</details>

<details>
<summary>Cursor</summary>

把上面的配置加进 `~/.cursor/mcp.json`。要放开某类危险命令时，在 `remote-ssh` 里加 `"env": { "SSH_MCP_ALLOW_PKG": "1" }`。

</details>

装好后可以先在仓库里试一次调用，看到的就是 agent 拿到的结果。

```sh
npm run call -- exec '{"host":"web1","cmds":{"disk":"df -h / | tail -1","load":"uptime","bad":"exit 3"}}'
```

```text
== disk exit=0
/dev/vda1        30G  2.1G   27G   8% /
== load exit=0
 03:49:36 up 10 days,  3:55,  0 user,  load average: 0.00, 0.02, 0.00
== bad exit=3
```

## 配置

用环境变量配置，写在客户端配置的 `env` 里（Claude Code 用 `-e`）。

| 环境变量 | 说明 |
| --- | --- |
| `SSH_MCP_TOOLS` | 默认不设，只暴露 `exec`、`file_write` 和 `pipe`。设了就只暴露列出的工具（逗号分隔，`exec` 总在），如 `exec,file_write,pipe,xui_api`；设为 `all` 暴露全部 6 个。 |
| `SSH_MCP_CF_TOKEN_DIR` | `cf_api` 读令牌的目录，放法见 [docs/tools.md](docs/tools.md#cf_api) 的「cf_api」一节。 |
| `SSH_MCP_HOST_SHELLS` | 主机的默认 shell，逗号分隔的 `别名=shell`，如 `arcwin=powershell`。`exec` 的说明里会在这些主机名后标出 shell，不传 `shell` 时就用它。 |
| `SSH_MCP_ALLOW_POWER` | 默认不设，拦截重启、关机这类电源类命令，设为 `1` 才放开。`reboot` 工具不受它影响。 |
| `SSH_MCP_ALLOW_PKG` | 默认不设，拦截装包、卸包这类命令，设为 `1` 才放开。 |

具体拦哪些命令，以及其他安全细节，见 [docs/tools.md](docs/tools.md#危险命令拦截) 的「危险命令拦截」和「安全」两节。

## 开发

```sh
npm install
npm run build
npm test
npm run call -- --list
npm run call -- exec '{"host":"web1","cmd":"uptime"}'
```

`npm run call` 用来在本地直接调用工具，运行前要先 `npm run build`。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
