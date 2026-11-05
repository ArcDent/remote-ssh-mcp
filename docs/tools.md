# 工具说明

工具清单、安装和环境变量在 [README](../README.md)。

## 返回内容

- 每个工具的完整参数用 `npm run call -- --list --json` 查看
- 除 `pipe` 和 `cf_api` 外，工具返回的第一行是 `exit=` 加退出码，后面是命令输出
- 输出太长时只保留开头和结尾，默认每路输出（标准输出、标准错误各算一路）最多 4000 字符，可用 `max_chars` 调整

## exec

只传 `host` 和 `cmd` 就是最普通的用法，其余参数可选：

| 参数 | 用途 | 例子 |
|---|---|---|
| `cmds` | 同时跑最多 10 条互不依赖的命令，结果按标签分段，各带退出码；有先后依赖的步骤仍写进一个 `cmd` 用 `&&` 连 | `{"host":"web1","cmds":{"ps":"docker ps","disk":"df -h /"}}` |
| `host` 传数组 | 同一条命令在几台主机上同时跑，每台一段 | `{"host":["web1","web2"],"cmd":"uptime"}` |
| `stdin` | 一段文本作为命令的标准输入，脚本、SQL 不用转义 | `{"host":"web1","cmd":"python3 -","stdin":"print('hi')"}` |
| `container` | 在这个 docker 容器里跑，标准输入照样能传 | `{"host":"web1","container":"app","cmd":"cat /etc/os-release"}` |
| `shell` | `posix`（默认）、`pwsh`（PowerShell 7）或 `powershell`（Windows PowerShell 5.1）；PowerShell 脚本编码后传过去，不怕引号 | `{"host":"win1","shell":"powershell","cmd":"Get-Service sshd"}` |
| `sudo`、`pswd` | 以 root 身份运行，见「以 root 身份运行」 | `{"host":"web1","cmd":"id -un","sudo":true}` |
| `conn` | 这次单独改端口、密钥、地址等连接参数，见「单次改连接参数」 | `{"host":"web1","conn":{"port":2222},"cmd":"uptime"}` |
| `redact` | 默认 `true`，把 `password=`、`token:`、`Bearer …` 这类值换成 `<redacted>`；要看原值时传 `false` | `{"host":"web1","cmd":"cat .env","redact":false}` |
| `timeout` | 秒，默认 60，最多 3600 | |
| `max_chars` | 每路输出上限，默认 4000，其中分段时各段共用，短的段省下的额度让给长的段 | |

- `cmds` 和数组形式的 `host` 可以一起用，一次最多 20 段；同一台主机最多同时开 8 个 ssh 会话，多出的排队。
- `stdin` 只能配 `cmd`，不能和 `cmds` 一起传。

## file_write

不想整份重写时，用 `edits` 代替 `content`：

```json
{"host":"web1","path":"/etc/nginx/nginx.conf","edits":[{"old":"listen 80;","new":"listen 8080;"}]}
```

- 每个 `old` 的内容必须在文件里刚好出现一次，否则工具报错并写明出现了几次，文件不会被改动。
- 工具在本机算好替换再写回，写之前核对文件在这期间没被改过，然后照常先备份、再整体替换。只支持 1 MB 以内的 UTF-8 文本文件。

## pipe

`from` 是来源，`to` 是去处，来源的数据直接流进 `to.cmd` 的标准输入，效果同 `ssh A '…' | ssh B '…'`：

| 来源写法 | 用途 | 例子 |
|---|---|---|
| `{"host","cmd"}` | 取主机上这条命令的输出 | 搬目录：`{"from":{"host":"web1","cmd":"tar -C /etc -cf - nginx"},"to":{"host":"web2","cmd":"tar -C /etc -xf -"}}` |
| `{"file"}` | 读本机文件，二进制也行 | 推脚本：`{"from":{"file":"~/deploy.sh"},"to":{"host":"web1","cmd":"cat > /root/deploy.sh"}}` |

返回的第一行是传输的字节数和 sha256，可以和对端 `sha256sum` 的结果对照；后面是两端各一段，带各自的退出码和输出：

```text
传输 5000000 字节，sha256=f2fdc7cc…
== from web1 exit=0
== to web2 exit=0
```

- 两端各自可带 `sudo`、`pswd`、`conn`，写在 `from` 或 `to` 里面。
- 两端都连得上才开始传。
- 来源中途失败时，去处收到的是已经传出的那部分，可能是空的，`cat > 文件` 会留下不完整的文件，写之前最好先确认来源命令没问题。
- 去处先结束时，工具会停掉来源。
- `to.cmd` 是 `sh`、`bash -s` 这类从标准输入读脚本的命令时，来源只能是本机文件，脚本先过危险命令检查，最大 1 MB。
- 只能往主机上写，不能写到本机。

## reboot

默认不出现，在 `SSH_MCP_TOOLS` 里写上 `reboot` 就能用，写上它就表示允许 agent 重启主机，不用另设 `SSH_MCP_ALLOW_POWER`。`SSH_MCP_ALLOW_POWER` 只管 `exec` 里的重启关机命令，两边互不影响。

```json
{"host":"web1","sudo":true,"wait":300}
```

1. 读一次 boot_id，在后台发出 `systemctl reboot`，没有 systemctl 时用 `reboot`。
2. 每 5 秒重新连一次，boot_id 变了才算重启过、主机回来了。
3. 返回大约停机多久、`uptime` 和 `systemctl --failed` 列出的失败服务。

| 情况 | 结果 |
|---|---|
| 到 `wait` 秒 boot_id 一直没变 | 报错，重启命令可能没生效 |
| 到 `wait` 秒主机还连不上 | 报错，可能还在启动，稍后用 `exec` 再看 |
| 非 root 登录且没带 `sudo` | 直接报错，不发重启 |

- `wait` 默认 300 秒，可设 30 到 900 秒。
- 只支持 Linux 主机；`sudo`、`pswd`、`conn` 的用法同 `exec`。

## cf_api

默认不出现，在 `SSH_MCP_TOOLS` 里写上 `cf_api` 才能用。请求直接从本机发往 Cloudflare，不经过 ssh。

令牌放在一个目录里，每份令牌一个文件，文件名就是令牌名，再把环境变量 `SSH_MCP_CF_TOKEN_DIR` 设成这个目录：

```sh
mkdir -p ~/.config/remote-ssh-mcp/cloudflare
# 把令牌写进 ~/.config/remote-ssh-mcp/cloudflare/own 之后
chmod 600 ~/.config/remote-ssh-mcp/cloudflare/own
```

```json
{"path":"zones/example.com/dns_records","account":"own"}
```

| 参数 | 用途 |
|---|---|
| `path` | 相对 `/client/v4/` 的路径，可带查询参数；`zones/` 后面可以直接写域名，工具先查出 zone_id 再换进去 |
| `method` | `GET`（默认）、`POST`、`PUT`、`PATCH`、`DELETE` |
| `body` | JSON 请求体 |
| `account` | 用哪份令牌，不传就用按名字排序后的第一份 |
| `max_chars` | 输出上限，默认 4000 |

- 返回的第一行是 `http=` 加状态码，后面是压成一行、打过码的响应；状态码不是 2xx 或 `success` 为 false 时算出错。
- 令牌文件的组和其他用户有任何权限就拒绝读，要先 `chmod 600`。
- 能读什么、能改什么全看令牌在 Cloudflare 那边给的权限，工具不另加限制。

## 以 root 身份运行

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

带 sudo 时家目录也换成 root 的，`file_write` 的自动备份随之存进 `/root/ops-backups/`。

- `pswd` 只能和 `sudo: true` 一起传。
- `shell` 是 `pwsh` 或 `powershell` 时不能用 sudo。

## 单次改连接参数

每个工具都能加 `conn`，只对这一次调用生效，`~/.ssh/config` 不用改。适合验证改过的端口、换过的密钥，或公网入口不通时改走内网地址：

```json
{"host":"web1","conn":{"hostname":"100.64.0.2"},"cmd":"uptime"}
```

| 字段 | 作用 |
|---|---|
| `port` | 换端口 |
| `user` | 换登录用户 |
| `identity` | 换成本机上的另一把私钥，只用这一把 |
| `jump` | 经跳板连，跳板必须是 config 里的别名 |
| `hostname` | 改连的地址；对端的主机密钥必须和这个别名在 known_hosts 里的记录一致，否则拒绝连接 |
| `password` | 用密码登录，只试一次；第一次连这台机器时自动记下它的主机密钥 |

- 带 `conn` 时不复用已有连接，每次都重新连，所以换了密钥或密码也能真正验证到。
- 改 `hostname` 前，这个别名至少要正常连过一次，known_hosts 里有它的记录，否则工具直接拒绝。
- `exec` 带 `conn` 时 `host` 只能写一台。
- 密码登录要求本机 OpenSSH 8.4 或更新。

## 超时

`exec` 和 `pipe` 的 `timeout` 可设 1 到 3600 秒，默认 60 秒。运行期间每 10 秒向客户端报一次进度，免得长命令被 agent 丢弃。

到点后远端命令会不会真的停下，分为以下情况：

| 情况 | 到点后 |
|---|---|
| 主机有 GNU `timeout`（常见 Linux），或是 Windows 上的 Git Bash、MSYS2、Cygwin | 主机先发 TERM，5 秒后再发 KILL，连同子进程一起停掉，不留进程 |
| 主机没有 GNU `timeout`（busybox、macOS），或其他 Windows 主机上的 PowerShell | 只断开本机的 ssh，远端命令可能继续跑 |
| 用 `container` 在容器里跑 | 停掉的是主机上的 `docker exec`，容器里的进程可能继续跑 |

- 超时会返回停止前已有的输出，并写明实际跑了多久，如 `超时：命令运行 4.5s 后被主机停止（上限 4s，exit=124）`；只断开了 ssh 时会提醒命令可能还在主机上运行。
- 客户端取消调用时工具立即返回，远端命令继续跑，直到主机端 `timeout` 到点。
- 每台主机第一次调用时会多一次探测，判断它属于上表哪种情况。

## 危险命令拦截

下面两类命令默认拦下，工具会提示 agent 让你自己 ssh 上去执行。各用一个环境变量放开：

| 环境变量 | 设为 `1` 才放开的命令 |
|---|---|
| `SSH_MCP_ALLOW_POWER` | 电源类命令：reboot、shutdown、poweroff、halt、`init 0/6`、`systemctl reboot/poweroff/halt`、`systemctl start poweroff.target`、写 `/proc/sysrq-trigger`、`wpeutil reboot` 等，PowerShell 下还有 Restart-Computer、Stop-Computer。命令名不分大小写，`shutdown.exe` 也算。`reboot` 工具不受它影响。 |
| `SSH_MCP_ALLOW_PKG` | 装包类命令：apt / apt-get / aptitude / yum / dnf / apk 的 install、remove、purge、upgrade 等，`dpkg -i/-r/-P/--configure`（只模拟的 `apt-get -s` 等不拦），以及 Windows 的 choco / winget / scoop 的 install、uninstall、upgrade 和 msiexec /i /x；PowerShell 下还有 Install-Package 等。 |

- 只演示不执行的装包命令放行：apt / apt-get / aptitude 带 `-s`、`--simulate`、`--dry-run`、`--just-print`、`--no-act` 时不拦。
- `cmd` 是 `sh`、`bash -s` 这类从标准输入读脚本的命令时，`stdin` 里的脚本同样要过危险命令检查。`pipe` 的去处是这类命令时，来源只能是本机文件，好先检查脚本。

## 安全

- 只连 `~/.ssh/config` 里的主机别名，直接写 IP 或 `user@ip` 会被拒绝。`conn` 的跳板也只能是别名。
- `conn` 改 HostName 时要核对主机密钥，对端必须是这个别名原来那台机器，换成别的机器会被拒绝。
- `conn.password` 不会出现在本机 ssh 的命令行里。
- `pswd` 不会出现在远端的进程列表里，也不会写进主机上的文件。
- `cf_api` 的令牌只在本机读取，工具说明里只列令牌名，令牌本身不会出现在说明和输出里。
- `file_write` 拒绝把 `<redacted>` 写进原本没有它的文件，免得把打码后的内容写回去、覆盖掉真密码。
