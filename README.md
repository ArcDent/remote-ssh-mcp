# remote-ssh-mcp

给 AI agent 用的远程运维工具（一个 MCP 服务）。agent 只要说出 `~/.ssh/config` 里的主机别名，比如 `web1`，就能在那台服务器上跑命令、查容器、改配置、看服务状态，效果等同于 `ssh web1 …`，但不用 agent 自己拼 ssh 命令和多层引号。

## 能做什么

- 在 `~/.ssh/config` 里配好的任意主机上跑命令，结果直接返回给 agent。
- 读写远端文件，覆盖前自动备份到 `~/ops-backups/`。
- 看服务器的内存、磁盘、负载和监听端口，查 systemd 服务和 docker 容器。
- 测主机能不能访问某个网址、出口 IP 是多少，调用 x-ui 面板的接口。
- 重启关机、装包卸包这类危险命令默认拦下，交给你手动执行。

## 工具一览

一共 11 个工具：

| 想做什么 | 工具 | 会不会改东西 |
|---|---|---|
| 跑任意命令 | `exec` | 会 |
| 读文件 | `file_read` | 不会 |
| 覆盖或追加写文件 | `file_write` | 会，覆盖前自动备份 |
| 备份文件或目录 | `backup_file` | 会，在远端生成备份 |
| 列出容器 | `docker_ps` | 不会 |
| 在容器里跑命令 | `docker_exec` | 会 |
| 看容器日志 | `docker_logs` | 不会 |
| 看内存、磁盘、负载、端口 | `sys_snapshot` | 不会 |
| 查 systemd 服务状态和日志 | `service_status` | 不会 |
| 测网址连通性和出口 IP | `http_probe` | 不改主机，但会从主机发网络请求 |
| 调 x-ui 面板接口 | `xui_api` | 看调的接口，可能会改面板配置 |

每个工具的完整参数用 `npm run call -- --list --json` 查看。工具返回的第一行是 `exit=` 加退出码，后面是命令输出；输出太长时只保留开头和结尾。

## 适用范围

- 适合在 `~/.ssh/config` 里配好的 Linux 主机上排查问题、改配置。
- Windows 和 Termux 主机只能用 `exec`，其余工具都按 Linux 命令写。
- 需要交互式终端的操作（`top`、`vim`、要输密码的 `sudo`）请直接开 ssh。
- 非 root 账号的主机上，写 `/etc` 或运行 docker 可能没有权限，工具不提供 sudo 参数。

## 环境要求

- Node.js 20 或更新。
- 本机装有 OpenSSH 客户端，`~/.ssh/config` 里配好主机别名，并且能用密钥免密登录。
- 远端要有工具用到的命令：docker 类工具要 docker，`http_probe` 和 `xui_api` 要 curl，`xui_api` 还要 sqlite3。

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
npm run call -- sys_snapshot '{"host":"web1"}'
```

```text
exit=0
== mem (MB)
used 471 / 973, available 501
swap used 0 / 0
== disk /
used 2.1G / 30G (8%), avail 27G
== load
 03:49:36 up 10 days,  3:55,  0 user,  load average: 0.00, 0.02, 0.00
== listening tcp
0.0.0.0:22 sshd
*:443 nginx
127.0.0.1:8080 app
...
```

## 配置

用环境变量配置，写在客户端配置的 `env` 里（Claude Code 用 `-e`）。

| 环境变量 | 说明 |
| --- | --- |
| `SSH_MCP_ALLOW_POWER` | 默认不设，`exec` / `docker_exec` 拦截电源类命令：reboot、shutdown、poweroff、halt、`init 0/6`、`systemctl reboot/poweroff/halt` 等。设为 `1` 才放开。 |
| `SSH_MCP_ALLOW_PKG` | 默认不设，拦截装包类命令：apt / apt-get / aptitude / yum / dnf / apk 的 install、remove、purge、upgrade 等，以及 `dpkg -i/-r/-P/--configure`。设为 `1` 才放开。 |

## 安全

- 只连 `~/.ssh/config` 里的主机别名，直接写 IP 或 `user@ip` 会被拒绝。
- 危险命令被拦时，工具提示 agent 让你自己 ssh 上去执行。

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
