# remote-ssh-mcp

给 AI agent 用的远程运维工具（一个 MCP 服务）。agent 只要说出 `~/.ssh/config` 里的主机别名，比如 `web1`，就能在那台服务器上跑命令、查容器、改配置、看服务状态，效果等同于 `ssh web1 …`，但不用 agent 自己拼 ssh 命令和多层引号。

## 能做什么

- 在 `~/.ssh/config` 里配好的任意主机上跑命令，结果直接返回给 agent。
- 一次调用同时跑几条互不依赖的命令，或在几台主机上跑同一条命令，结果按标签分段。
- 脚本和数据经标准输入传过去，在容器里跑命令，在 Windows 主机上跑 PowerShell，都不用 agent 自己处理多层引号。
- 耗时长的命令放到后台跑，之后再查进度，不用 `sleep` 轮询。
- 写远端文件或只改其中几处，覆盖前自动备份到 `~/ops-backups/`。
- 输出里的密码、token 默认打码。
- 重启关机、装包卸包这类危险命令默认拦下，交给你手动执行。

## 工具一览

默认只给 agent 两个工具，工具说明每轮都要发给模型，工具越少越省：

| 想做什么 | 工具 | 会不会改东西 |
|---|---|---|
| 跑任意命令 | `exec` | 会 |
| 覆盖、追加或局部修改文件 | `file_write` | 会，覆盖和修改前自动备份 |

另外 9 个工具默认不出现，要用时在环境变量 `SSH_MCP_TOOLS` 里列出名字（见「配置」）：`file_read`（读文件）、`backup_file`（备份文件或目录）、`docker_ps` / `docker_exec` / `docker_logs`（容器）、`sys_snapshot`（内存、磁盘、负载、端口）、`service_status`（systemd 服务）、`http_probe`（网址连通性和出口 IP）、`xui_api`（x-ui 面板接口）。它们能做的事用 `exec` 也都能做。

每个工具的完整参数用 `npm run call -- --list --json` 查看。工具返回的第一行是 `exit=` 加退出码，后面是命令输出；输出太长时只保留开头和结尾，默认每路输出（标准输出、标准错误各算一路）最多 4000 字符，可用 `max_chars` 调整。

### exec 的参数

只传 `host` 和 `cmd` 就是最普通的用法，其余参数都可选：

| 参数 | 用途 | 例子 |
|---|---|---|
| `cmds` | 同时跑最多 10 条互不依赖的命令，结果按标签分段，各带退出码；有先后依赖的步骤仍写进一个 `cmd` 用 `&&` 连 | `{"host":"web1","cmds":{"ps":"docker ps","disk":"df -h /"}}` |
| `host` 传数组 | 同一条命令在几台主机上同时跑，每台一段 | `{"host":["web1","web2"],"cmd":"uptime"}` |
| `stdin` | 一段文本作为命令的标准输入，脚本、SQL 不用转义 | `{"host":"web1","cmd":"python3 -","stdin":"print('hi')"}` |
| `container` | 在这个 docker 容器里跑，标准输入照样能传 | `{"host":"web1","container":"app","cmd":"cat /etc/os-release"}` |
| `shell` | `posix`（默认）、`pwsh`（PowerShell 7）或 `powershell`（Windows PowerShell 5.1）；PowerShell 脚本编码后传过去，不怕引号 | `{"host":"win1","shell":"powershell","cmd":"Get-Service sshd"}` |
| `background` | 放到后台跑，立刻返回任务号 | `{"host":"web1","background":true,"cmd":"tar czf /root/site.tgz /var/www"}` |
| `job` | 查后台任务的状态和日志末尾；同时传 `timeout` 时等它结束再返回，最多等 `timeout` 秒 | `{"host":"web1","job":"j20261029-041307-f2ba","timeout":600}` |
| `redact` | 默认 `true`，把 `password=`、`token:`、`Bearer …` 这类值换成 `<redacted>`；要看原值时传 `false` | `{"host":"web1","cmd":"cat .env","redact":false}` |
| `timeout` | 秒，默认 60，最多 3600 | |
| `max_chars` | 每路输出上限，默认 4000；分段时各段共用，短的段省下的额度让给长的段 | |

几点说明：

- `cmds` 和 `host` 数组可以一起用，一次最多 20 段。同一台主机同时最多开 8 个 ssh 会话，多出来的排队。
- `stdin` 只能配 `cmd`。`cmd` 是 `sh`、`bash -s` 这类从标准输入读脚本的命令时，脚本内容也会过一遍危险命令检查。
- PowerShell 下脚本出错就停，退出码为 1；要把外部程序的退出码传出来，在脚本里写 `exit $LASTEXITCODE`。数据从标准输入传进去时用 `[Console]::In.ReadToEnd()` 读，按 UTF-8 解码。Windows PowerShell 5.1 的错误信息原本是 CLIXML 格式，工具会还原成纯文本。
- 后台任务的目录在主机的 `~/.mcp-jobs/<任务号>/`（命令、标准输入、日志、退出码），已结束超过 7 天的在下次启动后台任务时自动删除。后台任务只支持 `posix`。Windows 主机（Git Bash、MSYS、Cygwin）上，Win32-OpenSSH 会话结束时会停掉会话里启动的进程，所以工具改由 WMI（`Win32_Process`）启动任务，任务不属于任何会话；这时返回和查询里的 pid 是 Windows 进程号。
- 打码只认常见写法，不保证拦住所有密钥。`file_write` 拒绝把 `<redacted>` 写进原本没有它的文件，防止把打码后的内容原样写回去、冲掉真密码。

### file_write 的 edits

不想整份重写时，用 `edits` 代替 `content`：

```json
{"host":"web1","path":"/etc/nginx/nginx.conf","edits":[{"old":"listen 80;","new":"listen 8080;"}]}
```

每个 `old` 必须在文件里刚好出现一次，否则报错并写明出现了几次，文件不动。工具在本机算好替换再写回，写之前核对文件在这期间没被改过，然后照常先备份、再整体替换。只支持 1 MB 以内的 UTF-8 文本文件。

## 适用范围

- 适合在 `~/.ssh/config` 里配好的 Linux 主机上排查问题、改配置。
- Windows 主机用 `exec` 加 `shell`（可用 `SSH_MCP_HOST_SHELLS` 设成默认），其余工具都按 Linux 命令写。
- Windows PowerShell 5.1 和 pwsh 7 已在 Windows 11（Win32-OpenSSH，默认 shell 为 Git Bash）上实测过。
- 需要交互式终端的操作（`top`、`vim`、要输密码的 `sudo`）请直接开 ssh。
- 非 root 账号的主机上，写 `/etc` 或运行 docker 可能没有权限，工具不提供 sudo 参数。

## 超时

- `exec` 和 `docker_exec` 的 `timeout` 可设 1 到 3600 秒，默认 60 秒。要等更久就用 `background`。
- 命令运行期间每 10 秒向客户端发一次进度，防止耗时过长的命令被 agent 丢弃。
- 主机装有 GNU coreutils 的 `timeout` 时，命令到点由主机自己停止，连同它起的子进程（`timeout` 给命令单开一个进程组，信号发给整组）：先发 TERM，5 秒后仍未退出再发 KILL。工具返回停止前已有的输出，主机上不会留下进程。
- 主机没有 GNU `timeout` 时（busybox、macOS），到点只能断开本机的 ssh，远端命令可能继续运行。
- Windows 的 Git Bash 下，`$SHELL` 是 Git 的启动器 `bin/bash.exe`，信号只到启动器，到不了它启动的 bash 和子进程。工具在这类主机上改用 MSYS 自己的 `/usr/bin/bash` 跑命令，到点同样整组停掉。
- 用 `container` 或 `docker_exec` 时，到点停止的是主机上的 `docker exec` 客户端，容器里的进程可能继续运行。
- PowerShell 命令只在 Git Bash、MSYS2、Cygwin 这类主机上加主机端的 `timeout`（那里登录 shell 是 bash），到点和 posix 命令一样停掉；其他主机上到点只断开本机的 ssh，远端进程会运行到自己结束。
- 客户端取消调用时工具立即返回，但远端命令会继续运行，直到主机端 `timeout` 到点。
- 超时的提示写明实际等了多久，如 `超时：命令运行 4.5s 后被主机停止（上限 4s，exit=124）`；本机断开 ssh 时还会提醒命令可能还在主机上运行。
- 每台主机第一次调用时会多一次探测，看它有没有 GNU `timeout`，以及是不是 Git Bash、MSYS2、Cygwin 这类 Windows 主机。

## 环境要求

- Node.js 20 或更新。
- 本机装有 OpenSSH 客户端，`~/.ssh/config` 里配好主机别名，并且能用密钥免密登录。
- 远端要有工具用到的命令：`file_write` 的 `edits` 要 `base64` 和 `sha256sum`，`container` 和 docker 类工具要 docker，`shell` 要装对应的 PowerShell，`http_probe` 和 `xui_api` 要 curl，`xui_api` 还要 sqlite3。Windows 主机上的 `background` 要 `powershell.exe`（Windows 自带）和 `cygpath`（Git Bash、MSYS2、Cygwin 自带）。

## 安装

先在仓库里构建：

```sh
npm install && npm run build
```

然后把下面的配置加进你的 MCP 客户端，路径换成仓库所在位置：

```json
{
  "mcpServers": {
    "remote-ssh": {
      "command": "node",
      "args": ["/path/to/remote-ssh-mcp/dist/index.js"]
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```sh
claude mcp add remote-ssh -s user -- node /path/to/remote-ssh-mcp/dist/index.js
```

要放开某类危险命令时加 `-e`，如 `claude mcp add remote-ssh -s user -e SSH_MCP_ALLOW_PKG=1 -- node …`。

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
| `SSH_MCP_TOOLS` | 默认不设，只暴露 `exec` 和 `file_write`。设了就只暴露列出的工具（逗号分隔，`exec` 总在），如 `exec,file_write,xui_api`；设为 `all` 暴露全部 11 个。 |
| `SSH_MCP_HOST_SHELLS` | 主机的默认 shell，逗号分隔的 `别名=shell`，如 `arcwin=powershell`。`exec` 的说明里会在这些主机名后标出 shell，不传 `shell` 时就用它。 |
| `SSH_MCP_ALLOW_POWER` | 默认不设，`exec` / `docker_exec` 拦截电源类命令：reboot、shutdown、poweroff、halt、`init 0/6`、`systemctl reboot/poweroff/halt`、`systemctl start poweroff.target`、写 `/proc/sysrq-trigger`、`wpeutil reboot` 等，PowerShell 下还有 Restart-Computer、Stop-Computer。命令名不分大小写，`shutdown.exe` 也算。设为 `1` 才放开。 |
| `SSH_MCP_ALLOW_PKG` | 默认不设，拦截装包类命令：apt / apt-get / aptitude / yum / dnf / apk 的 install、remove、purge、upgrade 等，`dpkg -i/-r/-P/--configure`（只模拟的 `apt-get -s` 等不拦），以及 Windows 的 choco / winget / scoop 的 install、uninstall、upgrade 和 msiexec /i /x；PowerShell 下还有 Install-Package 等。设为 `1` 才放开。 |

## 安全

- 只连 `~/.ssh/config` 里的主机别名，直接写 IP 或 `user@ip` 会被拒绝。
- 危险命令被拦时，工具提示 agent 让你自己 ssh 上去执行。
- 危险命令检查是防误操作的安全带，不是沙箱。`sudo`、`timeout`、`xargs`、`doas`、`busybox` 后面的命令，`bash -c`（含 `-lc` 这类合写）、`su -c`、`eval`、`cmd /c`、`powershell -Command`（含 `-EncodedCommand`）、`Invoke-Expression` 里的命令，以及经 `stdin` 交给 `sh` 的脚本都会检查；`python -c`、`perl -e`、`Start-Process`、命令里自己写的 `docker exec`（用 `container` 参数时会检查）、嵌套 ssh 和先写进文件再运行的脚本不检查。
- 只演示不执行的装包命令放行：apt / apt-get / aptitude 带 `-s`、`--simulate`、`--dry-run`、`--just-print`、`--no-act` 时不拦。

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
