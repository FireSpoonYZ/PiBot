# Linux 中心部署

中心管理页、API、SSE 与 `/v1/link` 共用容器内的 HTTP `8080`。外部设备经同一个 HTTPS 地址访问，`/v1/link` 使用 WSS。中心进程通过内部调用控制 Relay。

## 镜像与配置

正式中心镜像支持 Linux `amd64` 和 `arm64`。源码中的 `compose.yaml` 使用 `ghcr.io/firespoonyz/pibot-center:latest`，发行版附带的 Compose 文件固定到同版镜像标签。普通分支或 PR 构建镜像用于验证，正式发布才推送版本标签与 `latest`。 [发布说明](releasing.md)

下载同一发行版的 `compose.yaml`、`compose.https.yaml`、`Caddyfile`、`center.env.example` 后，在同一目录执行以下命令。 [GitHub Releases](https://github.com/FireSpoonYZ/PiBot/releases/latest)

```sh
umask 077
cp center.env.example center.env
# 编辑 center.env，将 CENTER_PUBLIC_URL 设为实际 HTTPS 根地址。
docker compose -f compose.yaml -f compose.https.yaml up -d
docker compose -f compose.yaml -f compose.https.yaml ps
```

自带 Caddy 需要域名已指向服务器，以及可用的 TCP 80 和 443。已有 HTTPS 反向代理时，改用 `docker compose up -d`，按下节配置。中心端口默认只映射到 `127.0.0.1:8080`。使用容器反代时可让代理加入同一 Docker 网络，访问 `center:8080`，并移除中心的 `ports`。中心数据保存在 `center-data` volume，容器以非 root 用户运行。

镜像内置固定版本的 Bitwarden CLI `@bitwarden/cli@2026.10.1`，用于 Vaultwarden 外部密码库。`bw serve` 只在容器回环上运行。自管部署可用 `PIBOT_BW_CLI` 指定可信的绝对路径，Vault 登录资料在中心设置页输入。 [Vault 文档](vault.md)

### 使用 DEB 包在 Ubuntu / Debian 直接部署

无需 Docker 时，可从发行页下载 `PiBot-<VERSION>-center-linux-amd64.deb`（或 `arm64`）直接安装。DEB 包内置固定版本的 Node.js `26.13.0` 与 `@bitwarden/cli@2026.10.1`（安装目录 `/usr/lib/pibot-center`，数据目录 `/var/lib/pibot-center`，配置文件 `/etc/pibot-center/center.env`），与桌面端 `e-launcher-desktop` 包互不冲突：

```sh
sudo apt install ./PiBot-<VERSION>-center-linux-amd64.deb
sudo pibot-center status
sudo pibot-center setup-token
```

服务 `pibot-center.service` 默认监听本机回环 `127.0.0.1:8080`；按下方反向代理章节配置 HTTPS/WSS 后，即可在网页使用 `sudo pibot-center setup-token` 输出的初始化码完成首次设置（也可编辑 `/etc/pibot-center/center.env` 后执行 `sudo systemctl restart pibot-center`）。覆盖安装新版本 `.deb` 会自动重启服务并完整保留 `/etc/pibot-center/center.env` 与 `/var/lib/pibot-center` 数据。

### 从源码构建中心镜像

```sh
sh scripts/center-build.sh
```

在 Compose 中将中心的 `image` 改为 `pibot-center:local`，再用上述命令启动。Dockerfile 使用 Node.js `26.13.0`，分别按锁文件安装中心前端、中心服务与 Host 依赖，构建网页并准备内置插件。镜像包含 Bot 学习所需的 Python。桌面和 Android 客户端使用各自的 Node 运行时。

## 反向代理

所有路径转发到同一后端，保留外部 Host（含端口），为 WebSocket 传递 Upgrade/Connection，SSE 关闭缓冲。下面是 Nginx 的 location 配置。

```nginx
location /v1/link {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

`CENTER_PUBLIC_URL` 必须是 HTTPS 根 origin（协议、主机与可选端口），不能带子路径、用户信息、查询或片段。WSS 地址自动推导为 `wss://<host>/v1/link`。不再设置 `CENTER_LINK_URL`、第二个 Relay 端口或中心 TLS 证书。

只有代理可信时才设置 `CENTER_TRUST_PROXY`，可用逗号分隔的 IP/CIDR，默认 `false`。Hindsight、外部模型、HTTP MCP 等后端仍由部署者提供，本 Compose 不额外编排这些业务。

## 首次初始化

空数据目录启动后进入初始化模式。

- `GET /api/health` 返回 `{"status":"setup"}`。
- `GET /api/setup` 返回初始化状态和非秘密地址，不返回初始化码。
- 日志及 DATA_ROOT 的 `center-setup-token` 文件提供一次性初始化码。
- 在网页填入初始化码与至少 12 字符的所有者密码，提交后生成独立加密密钥、会话密钥及所有者密码哈希。
- `center-config.json` 以原子、仅新建方式落盘；初始化完成后切换到正常服务，`/api/health` 变为 `ready`。

配置文件与 token 文件使用私有权限。DATA_ROOT 需要支持 hardlink 的本地文件系统；已有业务数据但缺少完整配置时拒绝生成新密钥。重启复用原配置，没有网页重置或覆盖已有密钥的入口。

旧部署仍可使用环境变量配置。`CENTER_ENCRYPTION_KEY_HEX`、`CENTER_SESSION_KEY_HEX`、`CENTER_OWNER_PASSWORD_HASH` 三项必须同时提供，并保留原值。两个 key 各为独立 32 字节 hex。密码哈希格式为 `scrypt$<salt hex>$<key hex>`。旧 env 按原方式读取。持久配置存在时，冲突的密钥覆盖会被拒绝。

## 配对与设备身份

桌面与 Android 首次连接使用管理页签发的一次性配对码（桌面粘贴，Android 扫码或粘贴）；旧版中心没有配对码时改用所有者密码。所有者密码只用于当次登录：客户端先保存固定设备 ID 和待确认注册令牌，再通过 owner/CSRF 认证提交 `POST /api/devices`。同 ID、同令牌的重试恢复原注册；不同令牌返回冲突。显式重新配对才轮换凭据，保留 Bot 与会话。

**配对码。** 在管理页「设备与 Bot → 添加设备」生成：格式为 `pibot1.` + base64url(JSON `{u, c, a?}`)，`u` 是中心的公开 HTTPS 地址，`c` 是 24 字节随机密钥，`a` 是可选的私有 CA（PEM，可含多张证书；窗口里的二维码在两张以上证书时放不下，桌面仍可复制粘贴）。中心只存 `c` 的 SHA-256，明文只在签发响应里出现一次。码 10 分钟有效、只能兑换一次；关闭「添加设备」窗口会使未使用的码立即作废。兑换接口 `POST /api/pairing/redeem` 不需要所有者会话，由设备自带设备 ID 与令牌；限流按来源地址每分钟最多 30 次（中心在 Caddy 等反向代理之后时，需按上文设置 `CENTER_TRUST_PROXY`，否则所有请求共享代理地址的额度）。错误码为 `PAIRING_CODE_INVALID`（401）、`PAIRING_CODE_USED`（409）、`PAIRING_CODE_EXPIRED`（410）、`DEVICE_ALREADY_REGISTERED`（409）、`PAIRING_CODE_DEVICE_MISMATCH`（409）。

通用码用于新增设备：可以登记新的设备 ID，也可以把管理页里删除过的设备（中心按撤销保存）以原 ID 加回，按新设备处理；被删除时清掉的 Bot 与绑定不会恢复。设备 ID 仍在使用中时返回 `DEVICE_ALREADY_REGISTERED`，所以泄露的通用码无法顶替在用的设备。要重新绑定在用的设备，所有者在该设备卡片上点「重新配对」，签发只对此设备有效的专属码；本机凭据丢失时用这个入口。删除设备不会删除指向它的 Webhook 路由；同一 ID 加回、并且报告的 Bot ID 相同时，这些路由会重新生效，不需要时请在 Webhook 页删除。已兑换的码允许同一设备、同一令牌在 10 分钟内重放，用于响应丢失后的重试，前提是该令牌仍是此码创建的凭据（设备在此期间被删除时不能借重放加回）。重新绑定会换令牌，Bot 与会话保留，所有者改过的设备名不被覆盖；`center-` 前缀仍然保留。配对码存于中心数据库（schema 9），回滚需恢复停机快照，升级之后新建的数据会随之丢失。

配对码在有效期内等同于所有者授权新增一台设备，请像密码一样对待：只在要配对的设备上粘贴，不要贴进聊天或工单。私有 CA 在管理页保存一次（`GET/PUT /api/pairing/ca`，只接受 PEM 证书，不接受私钥或其他文本），此后签发的码自带它；已签发的码不会追加。若中心前面是公共证书（如 Let’s Encrypt）则不需要设置。

这一功能把数据库升级到 schema 9（新增 `pairing_codes`、`pairing_settings`）。升级前先按下文备份，升级后旧版程序不能读取新库，回退时恢复升级前的停机快照；升级之后中心新产生的数据会随快照回退一并丢失。

新设备 ID 必须为 1–200 个可由 HTTP 头承载的可见 ASCII 字符，`center-` 前缀保留。中心只存令牌哈希。设备在线状态、配置应用、服务注册和进程运行分别报告。

独立 Node Host 也可使用 `host-core/host-service-cli.js identity --data-root <绝对路径>` 取得身份，然后通过 owner 登记接口配置凭据；已有数据目录不得随意更换 ID。`serve` 使用独立的控制令牌和设备令牌，参数分别指向环境变量名；私有 CA 用 `--center-ca-file`，npm 使用随包固定路径。

## 模型、能力与客户端版本

登录中心后管理 provider、模型、凭据、设备 Bot 与受管能力。共享默认模型和单 Bot 覆盖采用修订检查。设备回执显示实际应用结果。Skill 与 Bot 学习的操作见专项文档。 [Bot 管理与学习](bot-management-learning.md)

新中心会准备内置的受管插件，其中 Billion Context 默认启用。自定义版本可通过制品上传，Bot 已保存的显式禁用和 overrides 会保留。 [Billion Context 插件](../plugins/billion-context/README.md)

“客户端版本”先保存上传草稿，再显式发布或撤回。NSIS/DEB 需要 updater 签名，APK 需要 versionCode，所有文件流式核对大小和摘要。设备认证后才能查询、下载；中心分发签名，不保存发布私钥。元数据生成与正式签名要求见[发布说明](releasing.md)。

## 按层定位故障

在有源码和 Node.js 的环境中，可从仓库根运行只读的网络检查。

```sh
node scripts/check-center.mjs https://center.example.com
```

该命令检查 `/api/health` 和 `/v1/link` 的 WebSocket Upgrade。继续用下表确认设备认证、Host、配置、模型与 Shower。只有发行资产时，使用下方的 `curl` 示例。

从出现问题的设备所在网络检查公开地址。在服务器上先访问 `http://127.0.0.1:8080/api/health`，再访问公开 HTTPS 地址，可以区分容器启动与反向代理问题。

```sh
curl -fsS --max-time 10 http://127.0.0.1:8080/api/health
curl -fsS --max-time 10 https://center.example.com/api/health
```

| 层 | 检查入口 | 如何解释结果 |
| --- | --- | --- |
| 容器与 HTTP | `docker compose ps`、`docker compose logs --tail=50 center`、本机 `/api/health` | `setup` 表示等待初始化，`ready` 表示中心已启动。初始化日志含一次性码，分享日志前应先移除 |
| 公开 HTTPS | 从客户端网络访问公开 `/api/health` | 本机 HTTP 正常而公开 HTTPS 失败时，检查 DNS、端口、证书链和反代地址。私有 CA 部署需让客户端信任对应 CA |
| Host 服务 | Linux 运行 `pibot-host status`，Windows PowerShell 运行 `& "$env:ProgramFiles\pibot\pibot-host.exe" status`。Android 打开 PiBot，查看前台服务通知与客户端连接状态 | 桌面的 `configured`、`running`、`ready` 分别代表已有有效配置、进程运行、本机认证控制接口响应。Windows 需要配对的用户登录。Linux 可进一步查 `systemctl --user status e-launcher-host.service` |
| Relay 与设备身份 | 登录中心的「设备与 Bot」，确认配对的目标设备在线 | 设备在线说明目标 Host 已连上 Relay。HTTPS 健康但设备离线时，检查 `/v1/link` 的 Upgrade 与 SSE 代理设置，再查设备身份、令牌和 CA |
| 配置应用 | 查看设备卡片的「配置版本」「已应用版本」及应用状态 | 「已应用」且两个版本一致，表示 Host 已应用中心当前配置。「等待空闲」表示 Host 尚在执行。遇到「应用失败」，先查看设备回执里的错误码 |
| 模型 | 在「服务商与模型」检查服务商、凭据和目标模型，再确认「设备与 Bot」中的全局默认或 Bot 覆盖 | 在线且配置已应用后，从该 Bot 聊天发一条短消息。模型返回的认证、地址或模型错误可以在对应服务商配置中排查 |
| Shower | 在目标 Bot 聊天尝试打开虚拟屏 | Android 的 `SHOWER_UNAVAILABLE` 可先查 Shizuku 是否运行，`SHOWER_PERMISSION_REQUIRED` 可到 PiBot 的「设置 → 通知与后台运行 → Shizuku」授权。Windows 查交互式登录与虚拟屏配置，Linux 查 Xvnc 与桌面依赖 |

需要单独确认反代的 WebSocket Upgrade 时，可以发送一次无凭据的 HTTP/1.1 握手。`101 Switching Protocols` 表示请求到达 Relay 的 Upgrade 入口，设备认证结果以「设备与 Bot」为准。看到 `101` 后命令可能等待至 `--max-time` 到期。

```sh
curl --http1.1 -i --no-buffer --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://center.example.com/v1/link
```

平台依赖、服务日志与安装说明见各端文档。 [桌面](../desktop/README.md) · [Android](../mobile/README.md) · [Shower](shower-cross-platform.md)

## 升级、备份与迁移

备份时先停止本中心的写入，再归档 DATA_ROOT，包括 `center-config.json`、数据库及制品。配置中含解密已存凭据所需的密钥，备份目录应为私有权限。旧 env 部署还需单独保存 `center.env`。反代证书由反代系统保存。将 `BACKUP_DIR` 指向已存在的私有备份目录。

```sh
test -n "$BACKUP_DIR" && test -d "$BACKUP_DIR" || exit 1
umask 077
docker compose stop center
docker compose run -T --rm --no-deps --entrypoint tar center -C /data -czf - . > "$BACKUP_DIR/center-data.tar.gz"
docker compose up -d --no-deps center
```

旧双监听 8443/8790 部署迁移到同一 HTTP 入口时，先保留原数据与密钥，再修改中心和反代。公共 origin 不变时，客户端重新取得中心公布的 WSS 地址。现网若需临时兼容旧端口，由反代转发旧入口，迁移后移除。

升级使用原 volume；不要执行 `docker compose down -v`，不要通过更换密钥或清库修复启动错误。回退数据库时使用对应停机快照，不假定旧程序能读取新 schema。

2026-11-06 隔离环境中 Linux、Windows 和 Android 模拟器的实际验证范围见历史进度。发行版本和签名要求以发布说明为准。 [历史验收](open-source-release-progress.md) · [发布说明](releasing.md)
