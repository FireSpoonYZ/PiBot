# Linux 中心部署

中心管理页、API、SSE 与 `/v1/link` 共用一个内部 HTTP listener，默认端口 `8080`。HTTPS/WSS 由用户自己的反向代理提供。中心进程通过内部调用控制 Relay；不需要对公网域名进行回环连接。

## 镜像与配置

`compose.yaml` 默认使用 `ghcr.io/firespoonyz/e-launcher-center:latest`。`center.yml` 在版本 tag 发布 `<version>` 与稳定 `latest`，main 构建只发布 `sha-<完整提交>`；其他分支和 PR 只构建验证，不覆盖稳定标签。正式流水线的实际运行状态见[进度记录](open-source-release-progress.md)。

```sh
umask 077
cp center.env.example center.env
# 编辑 CENTER_PUBLIC_URL=https://center.example.com
docker compose up -d
docker compose logs center
```

源码构建使用 `sh scripts/center-build.sh`，再按 Compose 注释选择 `e-launcher-center:local` 与 `build:`。Dockerfile 会从 `scripts/pi-main.json` 的固定提交准备 Pi tarball，再分别安装中心和 Host 依赖。无需把宿主 node_modules 或本地 build 目录放进镜像。

Compose 默认只发布 `127.0.0.1:8080`；容器反代可使用同一 Docker 网络的 `center:8080` 并移除 ports。数据放在 `center-data` volume，容器以非 root 用户运行。Hermes 的 Python 只在中心镜像内运行，Android 不需要 Python。

镜像还在 `/opt/bitwarden-cli` 内置固定版本官方 Bitwarden CLI（`@bitwarden/cli` 2026.10.1），供 Vault 的 Vaultwarden 外部密码库使用：适配器只在容器回环上启动 `bw serve`，不新增任何发布端口；API key 与主密码只经私密通道（交互式 stdin 提示与 `POST /unlock` JSON 体）进入，不写 argv/env/文件/日志。自管部署如需替换可信 CLI 入口，可设绝对路径 `PIBOT_BW_CLI`（见 `center.env.example`）；秘密一律在中心 Vault 设置页输入，不写入 env 文件。

## 反向代理

所有路径转发到同一后端，保留外部 Host（含端口），为 WebSocket 传递 Upgrade/Connection，SSE 关闭缓冲。Nginx 示例：

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

空数据目录启动后进入初始化模式：

- `GET /api/health` 返回 `{"status":"setup"}`。
- `GET /api/setup` 返回初始化状态和非秘密地址，不返回初始化码。
- 日志及 DATA_ROOT 的 `center-setup-token` 文件提供一次性初始化码。
- 在网页填入初始化码与至少 12 字符的所有者密码，提交后生成独立加密密钥、会话密钥及所有者密码哈希。
- `center-config.json` 以原子、仅新建方式落盘；初始化完成后切换到正常服务，`/api/health` 变为 `ready`。

配置文件与 token 文件使用私有权限。DATA_ROOT 需要支持 hardlink 的本地文件系统；已有业务数据但缺少完整配置时拒绝生成新密钥。重启复用原配置，没有网页重置或覆盖已有密钥的入口。

完整旧环境变量配置仍可使用：`CENTER_ENCRYPTION_KEY_HEX`、`CENTER_SESSION_KEY_HEX`、`CENTER_OWNER_PASSWORD_HASH` 三项必须同时提供，并保留原值。两个 key 各为独立 32 字节 hex；密码哈希格式为 `scrypt$<salt hex>$<key hex>`。旧 env 不自动搬进配置文件；持久配置存在时，冲突的密钥覆盖会被拒绝。

## 配对与设备身份

桌面和 Android 首次连接使用所有者密码配对，密码只用于当次登录。客户端先保存固定设备 ID 和待确认注册令牌，再通过 owner/CSRF 认证提交 `POST /api/devices`。同 ID、同令牌的重试恢复原注册；不同令牌返回冲突。显式重新配对才轮换凭据，保留 Bot 与会话。

新设备 ID 必须为 1–200 个可由 HTTP 头承载的可见 ASCII 字符，`center-` 前缀保留。中心只存令牌哈希。设备在线状态、配置应用、服务注册和进程运行分别报告。

独立 Node Host 也可使用 `host-core/host-service-cli.js identity --data-root <绝对路径>` 取得身份，然后通过 owner 登记接口配置凭据；已有数据目录不得随意更换 ID。`serve` 使用独立的控制令牌和设备令牌，参数分别指向环境变量名；私有 CA 用 `--center-ca-file`，npm 使用随包固定路径。

## 模型、能力与客户端版本

登录中心后管理 provider、模型、凭据、设备 Bot 与受管能力。共享默认模型和单 Bot 覆盖采用修订检查；设备回执显示实际应用结果。Skill 管理和 Hermes 学习见[Bot 管理与学习](bot-management-learning.md)。

Billion Context 为独立受管插件，按[插件说明](../plugins/billion-context/README.md)构建、上传和启用；已有显式关闭或 overrides 不会被默认绑定覆盖。

“客户端版本”先保存上传草稿，再显式发布或撤回。NSIS/DEB 需要 updater 签名，APK 需要 versionCode，所有文件流式核对大小和摘要。设备认证后才能查询、下载；中心分发签名，不保存发布私钥。元数据生成与正式签名要求见[发布说明](releasing.md)。

## 升级、备份与迁移

备份时先停止本中心的写入，再归档 DATA_ROOT，包括 `center-config.json`、数据库及制品。配置中含解密已存凭据所需的密钥，备份目录应为私有权限。旧 env 部署还需单独保存 `center.env`；反代证书由反代系统保存。

```sh
docker compose stop center
umask 077
docker compose run -T --rm --no-deps --entrypoint tar center -C /data -czf - . > "$BACKUP_DIR/center-data.tar.gz"
docker compose up -d --no-deps center
```

旧双监听 8443/8790 部署迁移到同一 HTTP 入口时，先保留原数据与密钥，再修改中心和反代。公共 origin 不变时，客户端重新取得中心公布的 WSS 地址。现网若需临时兼容旧端口，由反代转发旧入口，迁移后移除。

升级使用原 volume；不要执行 `docker compose down -v`，不要通过更换密钥或清库修复启动错误。回退数据库时使用对应停机快照，不假定旧程序能读取新 schema。

本次本机 Linux、Windows 和 Android 模拟器的实际验证范围见[进度记录](open-source-release-progress.md)。正式 CI、Windows SCM/跨账户安装、正式签名迁移与完整长期运行仍按该记录跟踪。
