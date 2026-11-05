# Linux 中心部署

中心为单个 Node 22 Debian 容器：管理面（8443）与设备 relay（8790）是同
一进程的两个独立监听器。`CENTER_TLS_MODE=direct`（代码缺省）时两者都由
容器直接做 TLS，保持旧行为；`CENTER_TLS_MODE=proxy`（compose 默认）时
TLS 由已有反向代理（NAS HTTPS 入口、Nginx、Ferron 等）终止，两个监听器
在容器内是明文 HTTP/WS，只应经 loopback 或私有 Docker 网络可达，对外地
址仍必须是 https/wss；中心不按 `X-Forwarded-*` 判断安全来源。Compose 只
部署中心；Hindsight 后端及数据库使用已有外部服务。HTTP MCP 登记现有端点，
Node/npm MCP 在对应目标的受管目录安装；不自动编排 Python、uv 或 Docker MCP。

## 镜像获取

`compose.yaml` 默认使用 GHCR 预构建镜像
`ghcr.io/firespoonyz/e-launcher-center`（linux/amd64 与 linux/arm64），
由 `.github/workflows/center-image.yml` 在 main 分支推送，同提交另带
`sha-<commit>` 标签；pull_request 与 workflow_dispatch 只构建验证，不发
布。镜像尚未实际推送前（CI 未跑过 main）或需要本地修改时，按
`compose.yaml` 内注释把 `image:` 换成 `e-launcher-center:local` + `build:`
段并执行 `docker compose up -d --build`，构建前提见下节。

`center.env` 由 `center.env.example` 复制得到，只被 Compose 的 env_file
读取，不是 Docker 构建输入；含敏感配置，不要提交到版本库。

## 构建前提（源码构建）

使用 GHCR 预构建镜像时可跳过本节。

需要 Linux、Docker Engine 和 Compose 插件。先由项目维护者生成并提交与
`center-web/package.json`、`center-server/package.json` 和
`host-core/package.json` 对应的锁文件；这三个目录分别安装，且必须和
`center-contract/` 一起存在。构建不使用宿主机的 node_modules。中心服务
只通过现有 relay 源码使用 Host 模块，Host/Android 不安装中心服务器依赖。
构建包含本地的中心 Web 输出 `center-web/dist`，不访问 Host 的 Web 输出。
`host-core` 与 `center-server` 的六个 `@earendil-works/*` 依赖是固定上游 SHA 的
`build/pi-main/*.tgz`（file:），而 `.dockerignore` 排除 `build/`；根 Dockerfile 的
build 阶段会在容器内先 `COPY` `scripts/pi-main.json` 与 `prepare-pi-main.mjs` 并
`RUN node scripts/prepare-pi-main.mjs`，按同一 pin 生成 tgz 后再 `npm ci` 两组依赖，
不需要宿主机先跑 prepare，也不把本机 `build/` 加入镜像上下文。

在仓库根目录执行（此命令也可用于无 Compose 的镜像构建）：

```sh
sh scripts/center-build.sh
```

该镜像非 root 运行；Node/npm 安装型 MCP 可能需要原生编译工具或目标平台
支持，安装失败应查看中心操作/设备回执，不能视为已部署成功。不要把 Linux
的 node_modules 复制到其他平台。桌面安装包自带 `e-launcher-host` 启动器
监管的完整本机 Host（`host-runtime/` 内含内置 Node 运行时与 npm 生产依
赖），不是仅运行客户端 broker。Android 由 App 启动桥准备并传入原有
版本化 npm 资产路径，不新增第二份资产。独立 Node Host 可使用其安装的
`host-core` npm 11.6.2 依赖，并通过 `serve --npm-path` 显式传入
`npm-cli.js` 绝对路径；未提供时 Host 尝试查找安装的 npm，找不到不影响
启动，但需要 npm 的安装会报告 `NPM_UNAVAILABLE`。

## 反向代理（proxy 模式，compose 默认）

proxy 模式下容器不读 TLS 证书：8443 是明文 HTTP（管理 API 与 Web UI），
8790 是明文 WebSocket relay，升级路径固定 `/v1/link`、无 query。compose 把
两个端口只发布到宿主机 `127.0.0.1`，明文管理端不对局域网开放：跑在宿主
机上的反代（Nginx/Caddy/Ferron/NAS 自带 HTTPS 入口）直接转发；容器化反
代也可加入同一 Compose 网络，按 `center:8443` / `center:8790` 访问，此
时可整段移除 ports 发布，明文端口完全不离开容器网络。

反代规则：除 `/v1/link` 以外的全部请求转发到 `http://127.0.0.1:8443`；
`/v1/link` 转发到 `http://127.0.0.1:8790`，并必须传递 WebSocket 的
Upgrade/Connection 头与长连超时。两端都有长连接，按所用反代的惯例设置读
写超时。不要伪造或依赖 `X-Forwarded-*`。设备与客户端只访问反代后的对外
地址：`CENTER_PUBLIC_URL` 为 `https://…`，`CENTER_LINK_URL` 为
`wss://…/v1/link`；客户端 WS URL 安全规则不变（明文 ws 只允许字面
loopback），这两个 URL 与容器内明文监听是两回事。

**必须保留外部 Host 头（含端口）**：初始化与登录请求的 Origin/Host 检查以
对外 URL 为准，若反代把 Host 改写成 upstream 地址（如 Nginx 默认
`Host $proxy_host`），浏览器请求会被判 Origin 不符而 403。Nginx 等价示例：

```nginx
location /v1/link {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;   # 保留含端口的外部 Host
}
location / {
    proxy_pass http://127.0.0.1:8443;
    proxy_set_header Host $http_host;   # 保留含端口的外部 Host
}
```

Caddy/Traefik/Apache 与 NAS 自带反代向导用其「保留原始 Host / pass Host
header」等价选项；不要让上游只看到 `127.0.0.1:8443` 之类的内部 Host。

## 首次初始化（新部署）

数据目录里没有持久配置、也没有完整旧 env 时，中心进入初始化模式：
`GET /api/health` 返回 `{status:'setup'}`，`GET /api/setup` 返回
`{required:true}`（带 env 已给的 publicUrl/linkUrl 默认与 tlsMode）。启动
日志打印一次性初始化码（setup token），可用 `docker compose logs center`
读取；同一 token 也写在容器内 DATA_ROOT 的独立 0600 文件。token 只从容
器本地日志/文件获得，任何匿名 API 都不会返回它。

在浏览器打开对外地址（本机也可用 `http://127.0.0.1:8443`），初始化页要
求输入初始化码、所有者口令与 publicUrl/linkUrl。提交
（`POST /api/setup`）成功后在 DATA_ROOT 原子写入 `center-config.json`
（version 1，含对外地址、生成的加密/会话密钥与所有者口令 scrypt 哈希，
0600，绝不覆盖已有配置）；页面轮询到 `required:false` 后进入原有登录页。
口令只存 scrypt 哈希；初始化码一次性，提交串行且限速。

配置提交使用同目录 hardlink 完成原子落盘，DATA_ROOT 所在卷必须是支持
hardlink 的本地文件系统（默认的 Docker 本地 named volume / ext4 / xfs /
btrfs 均可）；不要放在 exFAT、SMB/NFS 等不支持 hardlink 的挂载上，否则初
始化或配置保存会失败。

`center-config.json` 与中心数据在同一 volume：备份 DATA_ROOT 即包含全部
密钥（见「维护和升级」），丢失它等于丢失解密已存凭证的能力。已配置部署
`GET /api/setup` 恒返回 `{required:false}`，没有重置入口；数据目录已有
数据但配置不完整（缺 config 且 env 不完整）时启动失败，而不会自动换密钥
——新密钥解不开旧数据。

## 旧 env 与 direct TLS 部署

本节对应 `CENTER_TLS_MODE=direct`（或未设置）与仍由环境变量配置的既有部
署。compose 中把 `CENTER_TLS_MODE` 改为 `direct`、取消
`./center-certs:/certs:ro` 挂载与 `CENTER_TLS_CERT_FILE`/
`CENTER_TLS_KEY_FILE` 两行注释，并按实际暴露面调整端口发布（direct 下两
个端口本身就是 TLS，可按需绑定非 loopback 地址）。

将受信任的 PEM 证书链及私钥分别放到 `center-certs/cert.pem` 和
`center-certs/key.pem`。两监听器使用同一证书；容器以镜像内 `node` 用户
读取挂载目录和文件，需授予该用户读取权限，且不要使私钥对其他用户可读。
证书的域名必须匹配对外地址。保护该目录，不要提交到版本库或复制到镜像。

以下示例在安全的交互式 shell 中执行，将域名替换为真实地址，勿启用
`set -x`；不要把口令、密钥写到 shell 历史或日志。文件必须妥善保护，
拥有 Docker 管理权限者也可读取容器环境变量。示例中的
`e-launcher-center:local` 替换为实际使用的镜像（如 GHCR tag）。生成并保
存独立加密密钥与会话密钥；重启或升级必须保留加密密钥，否则无法解密已保
存的凭证。

```sh
umask 077
read -r -s -p '中心所有者口令: ' owner_password; printf '\n'
owner_hash=$(printf %s "$owner_password" | docker run --rm -i e-launcher-center:local node center-server/cli.js password-hash)
unset owner_password
encryption_key=$(docker run --rm e-launcher-center:local node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
session_key=$(docker run --rm e-launcher-center:local node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
cat > center.env <<EOF
CENTER_PUBLIC_URL=https://center.example.com:8443
CENTER_LINK_URL=wss://center.example.com:8790/v1/link
CENTER_ENCRYPTION_KEY_HEX=$encryption_key
CENTER_SESSION_KEY_HEX=$session_key
CENTER_OWNER_PASSWORD_HASH='$owner_hash'
EOF
unset owner_hash encryption_key session_key
docker compose up -d --no-build
```

`center.env` 由 Compose 的 env_file 读取，不是 Docker 构建输入；口令哈希
采用 `scrypt$<16字节salt hex>$<64字节key hex>`，单引号防止 Compose
将其中的 `$` 视为插值。两个 key 各为独立 32 字节的 64 位 hex。
`CENTER_PUBLIC_URL` 和 `CENTER_LINK_URL` 必须是设备可访问的实际地址；
direct 模式下若要在前面再放反代，需确保两个 TLS 监听与 WebSocket 路径按
TCP 层正确转发，或改用上文 proxy 模式由反代终止 TLS。映射其他主机端口时
同步修改这些外部 URL。Compose 固定容器内数据、端口和 Web 路径；可在安全
的 `center.env` 中另外设置
`CENTER_NPM_PATH` 为容器内 npm-cli.js 的绝对路径，默认使用中心安装的
固定 npm。不要更换密钥或覆盖数据来“修复”启动失败。

## 首次登记 Host 设备

Host 机器使用绝对路径作为其独立数据目录，先执行 init，记下输出中的
`deviceId`（后续启动使用同一目录）：

```sh
node host-core/cli.js init --data-root "$HOST_DATA_ROOT"
```

在中心侧安全设置设备 token 环境变量 `HOST_DEVICE_TOKEN`，将
`HOST_DEVICE_ID` 设为上述 deviceId，通过唯一登记写入口注册。设备 token
应为 32–512 位字母、数字、下划线或连字符，与本机控制 token 不同；不要
放进命令行、历史或日志。Compose 示例使用同一个 center-data volume，
其中 `CENTER_DATA_ROOT` 是 `/data`，不是 `/data/relay`：

```sh
docker compose run -T --rm --no-deps -e HOST_DEVICE_TOKEN --entrypoint node center \
  host-core/relay-registry-cli.js register --data-root /data \
  --device-id "$HOST_DEVICE_ID" --token-env HOST_DEVICE_TOKEN
```

若中心直接运行而非 Compose，在中心机器使用实际绝对数据根执行
`node host-core/relay-registry-cli.js register --data-root "$CENTER_DATA_ROOT" --device-id "$HOST_DEVICE_ID" --token-env HOST_DEVICE_TOKEN`。
安全地将同一设备 token 提供给 Host 环境变量 `HOST_DEVICE_TOKEN`，并单独
设置本机控制 token 环境变量 `HOST_CONTROL_TOKEN`；两者不得相同。然后在
Host 机器启动（替换中心地址；私有 CA 时添加可选参数，npm 路径同理）：

```sh
node host-core/host-service-cli.js serve --data-root "$HOST_DATA_ROOT" \
  --token-env HOST_CONTROL_TOKEN --center-url https://center.example.com:8443 \
  --device-token-env HOST_DEVICE_TOKEN
# 可选：--center-ca-file /path/to/ca.pem --npm-path /absolute/path/to/npm-cli.js
```

访问管理 HTTPS 地址，使用所有者口令登录。UI 只列出已登记设备，没有网页
登记表单；Host 和 App 使用设备身份认证连接中心。Hindsight 的 URL、
凭证及 Bot 启用状态在中心作为普通插件配置，后端服务不由本 Compose
创建。部署、版本、状态以中心 operation 和设备实际回执为准，不以请求
受理或容器启动代替验收。

安装包内 Host 的 `e-launcher-host pair` 不走上述手工登记，而是 owner 会话
`POST /api/devices`：可携带已有 `deviceId` 保持原 Host 身份（例如重绑或
换机恢复）；ID 冲突返回 409 且不改动既有 token；显式 `replaceExisting`
重绑轮换 token 但保留 deviceId 与登记记录，不新建重复设备。手工
`adopt --device-id` 与所持 token 对应设备不符时报 `DEVICE_ID_MISMATCH`，
不覆盖旧 Host 数据。

## Billion Context 受管部署

BC 为独立 Host 原生插件 `@e-launcher/billion-context` 1.0.0（能力 ID `e-launcher.billion-context`），不是中心服务或 Host 内置组件。使用 [插件 README](../plugins/billion-context/README.md) 的打包和上传流程：在中心选择 `plugin`、本地制品、目标 `host`；安装实例默认启用，Bot 绑定默认关闭，逐 Bot 显式启用后检查 operation 与每台设备的实际部署回执。中心生成未随标准 npm 制品携带的依赖锁文件；Host managed installer 用该锁文件安装依赖，中心和 Host 均需可访问依赖源及可用 npm。

升级现有部署时，先在中心上传/安装插件实例并保持 Bot 绑定关闭；停止旧 Host 并保留数据后，在中心启用目标 Bot 绑定，使离线计划生成或排队；更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度，再检查设备回执。不要在旧 Host 运行时下发启用 BC：旧 Host 内置工具与插件原名冲突，旧管理器会拒绝注册；忽略 `prepareContext` 不代表可同时加载插件。新 Host 不再内嵌 BC，未绑定/未启用时不压缩，但仍做最终预算检查。保留原数据目录和历史，不能以重置状态处理兼容问题。版本更新、回滚及实际 API 请求体见插件 README；回滚插件与回滚 Host 不是同一操作，升级前备份并确认兼容性。

## 维护和升级

`center-data` Docker volume 保存中心、relay、受管安装数据，以及新部署由
初始化生成的 `center-config.json`（对外地址与加密/会话密钥）和一次性
setup token 文件；`center.env` 与 `center-certs/` 在宿主机上，不在该
volume 中。备份前先停止服务，并将数据归档与（旧 env 部署的）`center.env`、
证书分开安全保存；归档包含敏感数据。例如将 `BACKUP_DIR` 指向仓库外的受
保护目录：

```sh
docker compose down
umask 077
docker compose run -T --rm --no-deps --entrypoint tar center -C /data -czf - . > "$BACKUP_DIR/center-data.tar.gz"
docker compose up -d --no-build
```

升级前备份并记录原镜像 tag 及配置；拉取新的 GHCR tag 或重建本地镜像后，
用原 volume 重新启动——升级与回滚都不要删除或重建 volume（
`docker compose down` 不会删除 volume，`down -v` 会）。旧 env 部署迁移限
制：完整旧 env 继续生效，不要只删掉部分变量造成"有数据但配置不完整"的拒
绝启动；env 配置不会自动搬进 `center-config.json`，如需转为持久配置按实
际版本说明执行，不要自己改写 JSON。不要更换密钥或覆盖数据来"修复"启动失
败。替换证书（direct 模式）后重启容器以重新加载。停止、备份和恢复期间不
要并行修改同一数据卷。

## 验收边界

本说明是部署入口而不是运行结果。上线前需真实验证首次初始化（token 从
日志读取、setup 后 `/api/health` 变 ready）、登录、设备登记、Host
连接、proxy 模式下反代对 `/v1/link` 的 WebSocket 转发、两个 Bot 的配置
继承与覆盖、Billion Context 的安装和跨升级状态恢复、Hindsight、HTTP 和
Node MCP、Skill、更新/卸载与断线重连。构建和容器启动本身不能证明上述功
能正常。
