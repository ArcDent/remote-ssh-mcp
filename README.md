# remote-ssh-mcp

给 AI agent 用的远程运维工具（一个 MCP 服务）。agent 只要说出 `~/.ssh/config` 里的主机别名，比如 `web1`，就能在那台服务器上跑命令、查容器、改配置、看服务状态，效果等同于 `ssh web1 …`，但不用 agent 自己拼 ssh 命令和多层引号。

## 能做什么

- 在 `~/.ssh/config` 里配好的任意主机上跑命令，结果直接返回给 agent。
- 一次调用同时跑几条互不依赖的命令，或在几台主机上同时跑同一条命令，结果按标签分段返回。
- 脚本和数据经标准输入传过去，在容器里跑命令，在 Windows 主机上跑 PowerShell，都不需要 agent 自己处理多层引号，减轻运维负担。
- 耗时长的命令放到后台跑，之后查进度、列出任务或停掉任务，不用 `sleep` 轮询。
- 写远端文件或只改其中几处，会覆盖前自动备份到 `~/ops-backups/`。
- 非 root 账号也能以 root 身份运行命令，sudo 要密码时由 agent 传入。
- 输出里的密码、token 默认打码。
- 重启关机、装包卸包这类危险命令默认拦下，并提示 agent 让用户手动执行。

## 工具一览

默认只给 agent 三个工具：

| 想做什么 | 工具 | 会不会改东西 |
|---|---|---|
| 跑任意命令 | `exec` | 会 |
| 覆盖、追加或局部修改文件 | `file_write` | 会，会在覆盖和修改前进行自动备份 |
| 在后台跑耗时长的命令，查看、列出或停掉任务 | `job` | 会 |

另外 9 个工具默认不出现，要用时在环境变量 `SSH_MCP_TOOLS` 里列出名字：
- `file_read`（读文件）
- `backup_file`（备份文件或目录）
- `docker_ps` （容器列表）
- `docker_exec`（容器操作）
- `docker_logs`（容器日志）
- `sys_snapshot`（内存、磁盘、负载、端口）
- `service_status`（systemd 服务）
- `http_probe`（网址连通性和出口 IP）
- `xui_api`（x-ui 面板接口）

它们能做的事用 `exec` 也都能做，所以默认不给出，可以按需添加。

- 每个工具的完整参数用 `npm run call -- --list --json` 查看
- 工具返回的第一行是 `exit=` 加退出码，后面是命令输出
- 输出太长时只保留开头和结尾，默认每路输出（标准输出、标准错误各算一路）最多 4000 字符，可用 `max_chars` 调整

### exec 的参数

只传 `host` 和 `cmd` 就是最普通的用法，其余参数可选，在下面列出：

| 参数 | 用途 | 例子 |
|---|---|---|
| `cmds` | 同时跑最多 10 条互不依赖的命令，结果按标签分段，各带退出码；有先后依赖的步骤仍写进一个 `cmd` 用 `&&` 连 | `{"host":"web1","cmds":{"ps":"docker ps","disk":"df -h /"}}` |
| `host` 传数组 | 同一条命令在几台主机上同时跑，每台一段 | `{"host":["web1","web2"],"cmd":"uptime"}` |
| `stdin` | 一段文本作为命令的标准输入，脚本、SQL 不用转义 | `{"host":"web1","cmd":"python3 -","stdin":"print('hi')"}` |
| `container` | 在这个 docker 容器里跑，标准输入照样能传 | `{"host":"web1","container":"app","cmd":"cat /etc/os-release"}` |
| `shell` | `posix`（默认）、`pwsh`（PowerShell 7）或 `powershell`（Windows PowerShell 5.1），其中PowerShell 脚本编码后传过去，不怕引号 | `{"host":"win1","shell":"powershell","cmd":"Get-Service sshd"}` |
| `sudo`、`pswd` | 以 root 身份运行，见下面的「以 root 身份运行」 | `{"host":"web1","cmd":"id -un","sudo":true}` |
| `redact` | 默认 `true`，把 `password=`、`token:`、`Bearer …` 这类值换成 `<redacted>`；要看原值时传 `false` | `{"host":"web1","cmd":"cat .env","redact":false}` |
| `timeout` | 秒，默认 60，最多 3600 | |
| `max_chars` | 每路输出上限，默认 4000，其中分段时各段共用，短的段省下的额度让给长的段 | |

几点说明：

- `cmds` 和数组形式的 `host` 可以一起用，一次最多 **20 段**；同一台主机最多同时开 **8 个 ssh 会话**，多出的排队。
- `stdin` 只能配 `cmd`，不能和 `cmds` 一起传。

### job 的用法

用 `action` 选要做的事，`host` 只能传一台主机：

| action | 用途 | 例子 |
|---|---|---|
| `start` | 在后台跑 `cmd`，立刻返回任务号，ssh 断开后照常运行；`stdin`、`container` 的用法同 `exec` | `{"action":"start","host":"web1","cmd":"tar czf /root/site.tgz /var/www"}` |
| `status` | 看任务状态和日志最后 200 行；传 `timeout` 时等任务结束再返回，最多等 `timeout` 秒 | `{"action":"status","host":"web1","id":"j20261029-041307-f2ba","timeout":600}` |
| `list` | 列出主机上的任务，新的在前，最多 30 个，每个一行，带状态、用时和命令开头 | `{"action":"list","host":"web1"}` |
| `kill` | 停掉任务和它启动的子进程 | `{"action":"kill","host":"web1","id":"j20261029-041307-f2ba"}` |

任务有四种状态：

| 状态 | 含义 |
|---|---|
| `running` | 还在跑 |
| `done` | 已结束，带退出码 |
| `killed` | 被 `kill` 停掉；退出码 143 表示收到停止信号后退出，137 表示 5 秒内没退出、被强制停掉 |
| `lost` | 进程没了，也没留下退出码，比如主机重启过 |

`kill` 在不同情况下的效果：

| 情况 | kill 之后 |
|---|---|
| Linux、macOS 主机，以及 Windows 上的 Git Bash、MSYS2、Cygwin | 任务和它启动的子进程都停掉，包括 `ping.exe` 这类 Windows 原生程序 |
| 用 `container` 在容器里启动的任务 | 停掉的是主机上的 `docker exec`，容器里的进程可能继续跑 |

- `cmd` 按 POSIX shell 写，Windows 主机上在 Git Bash 里跑；返回的 pid 是 Windows 进程号。
- 任务文件（命令、标准输入、日志、退出码）放在主机的 `~/.mcp-jobs/<任务号>/`，结束超过 7 天的会在下次 `start` 时删掉。

### file_write 的 edits

不想整份重写时，用 `edits` 代替 `content`：

```json
{"host":"web1","path":"/etc/nginx/nginx.conf","edits":[{"old":"listen 80;","new":"listen 8080;"}]}
```

- 每个 `old` 的内容必须在文件里刚好出现一次，否则工具报错并写明出现了几次，此时不对文件进行任何操作。
- 工具在本机算好替换再写回，写之前核对文件在这期间没被改过，然后照常先备份、再整体替换。只支持 1 MB 以内的 UTF-8 文本文件。

### 以 root 身份运行

每个工具都能加 `sudo: true`，整条命令以 root 身份运行。sudo 要密码时再传 `pswd`，一般填登录用户自己的密码；主机的 sudo 配置里设了 `rootpw` 时才填 root 的密码。

```json
{"host":"web1","cmd":"systemctl restart nginx","sudo":true,"pswd":"<登录用户的密码>"}
```

| 情况 | 结果 |
|---|---|
| 主机的 sudo 免密 | 只传 `sudo: true` 就行，传了 `pswd` 也用不上 |
| 本来就用 root 登录 | 直接运行，主机没装 sudo 也行 |
| sudo 要密码，传了 `pswd` | 以 root 身份运行 |
| sudo 要密码，没传 `pswd` | 立即失败，提示传 `pswd` |
| `pswd` 错了 | 失败，只试一次，不会连错几次把账号锁住 |
| 非 root 登录，主机没装 sudo | 失败，`exit=127` |

带 sudo 时家目录也换成 root 的，这两个工具的文件位置随之改变：

| 工具 | 带 sudo 时 |
|---|---|
| `file_write` | 自动备份存进 `/root/ops-backups/` |
| `job` | 任务文件放在 `/root/.mcp-jobs/`；用 sudo 启动的任务，`status`、`list`、`kill` 也要带 sudo，否则看不到 |

- `pswd` 只能和 `sudo: true` 一起传。
- `shell` 是 `pwsh` 或 `powershell` 时不能用 sudo。

## 适用范围

- 适合在 `~/.ssh/config` 里配好的 Linux 主机上排查问题、改配置。
- Windows 主机用 `exec` 加 `shell`（可用 `SSH_MCP_HOST_SHELLS` 设成默认），其余工具都按 Linux 命令写。
- Windows PowerShell 5.1 和 pwsh 7 已在 Windows 11（Win32-OpenSSH，默认 shell 为 Git Bash）上实测过。
- 需要交互式终端的操作（`top`、`vim`）请直接开 ssh。

## 超时

`exec` 和 `docker_exec` 的 `timeout` 可设 1 到 3600 秒，默认 60 秒，更久的命令用 `job` 放到后台跑。运行期间每 10 秒向客户端报一次进度，免得长命令被 agent 丢弃。

到点后远端命令会不会真的停下，分为以下情况：

| 情况 | 到点后 |
|---|---|
| 主机有 GNU `timeout`（常见 Linux），或是 Windows 上的 Git Bash、MSYS2、Cygwin | 主机先发 TERM，5 秒后再发 KILL，连同子进程一起停掉，不留进程 |
| 主机没有 GNU `timeout`（busybox、macOS），或其他 Windows 主机上的 PowerShell | 只断开本机的 ssh，远端命令可能继续跑 |
| 在容器里跑（`container`、`docker_exec`） | 停掉的是主机上的 `docker exec`，容器里的进程可能继续跑 |

- 超时会返回停止前已有的输出，并写明实际跑了多久，如 `超时：命令运行 4.5s 后被主机停止（上限 4s，exit=124）`；只断开了 ssh 时会提醒命令可能还在主机上运行。
- 客户端取消调用时工具立即返回，远端命令继续跑，直到主机端 `timeout` 到点。
- 每台主机第一次调用时会多一次探测，判断它属于上表哪种情况。

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

装好后可以先在仓库里试一次调用，看到的就是 agent 拿到的结果。下面的输出是示例，主机名、端口和进程已经换成通用值：

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
| `SSH_MCP_TOOLS` | 默认不设，只暴露 `exec`、`file_write` 和 `job`。设了就只暴露列出的工具（逗号分隔，`exec` 总在），如 `exec,file_write,job,xui_api`；设为 `all` 暴露全部 12 个。 |
| `SSH_MCP_HOST_SHELLS` | 主机的默认 shell，逗号分隔的 `别名=shell`，如 `arcwin=powershell`。`exec` 的说明里会在这些主机名后标出 shell，不传 `shell` 时就用它。 |
| `SSH_MCP_ALLOW_POWER` | 默认不设，`exec` / `docker_exec` 拦截电源类命令：reboot、shutdown、poweroff、halt、`init 0/6`、`systemctl reboot/poweroff/halt`、`systemctl start poweroff.target`、写 `/proc/sysrq-trigger`、`wpeutil reboot` 等，PowerShell 下还有 Restart-Computer、Stop-Computer。命令名不分大小写，`shutdown.exe` 也算。设为 `1` 才放开。 |
| `SSH_MCP_ALLOW_PKG` | 默认不设，拦截装包类命令：apt / apt-get / aptitude / yum / dnf / apk 的 install、remove、purge、upgrade 等，`dpkg -i/-r/-P/--configure`（只模拟的 `apt-get -s` 等不拦），以及 Windows 的 choco / winget / scoop 的 install、uninstall、upgrade 和 msiexec /i /x；PowerShell 下还有 Install-Package 等。设为 `1` 才放开。 |

## 安全

- 只连 `~/.ssh/config` 里的主机别名，直接写 IP 或 `user@ip` 会被拒绝。
- 危险命令被拦时，工具提示 agent 让你自己 ssh 上去执行。
- `cmd` 是 `sh`、`bash -s` 这类从标准输入读脚本的命令时，`stdin` 里的脚本同样要过危险命令检查。
- 只演示不执行的装包命令放行：apt / apt-get / aptitude 带 `-s`、`--simulate`、`--dry-run`、`--just-print`、`--no-act` 时不拦。
- `pswd` 不会出现在远端的进程列表里，也不会写进主机上的文件。
- `file_write` 拒绝把 `<redacted>` 写进原本没有它的文件，免得把打码后的内容写回去、覆盖掉真密码。

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
