# Linux 中心部署

中心为单个 Node 22 Debian 容器：管理 HTTPS（8443）和既有 relay TLS
（8790）是同一进程的独立监听器。Compose 只部署中心；Hindsight 后端及
数据库使用已有外部服务。HTTP MCP 登记现有端点，Node/npm MCP 在对应目标
的受管目录安装；不自动编排 Python、uv 或 Docker MCP。

## 构建前提

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
的 node_modules 复制到其他平台。桌面应用仅运行客户端 broker，不启动 Host，
因此不打包 npm，也无需 `npmPath`。Android 由 App 启动桥准备并传入原有
版本化 npm 资产路径，不新增第二份资产。独立 Node Host 可使用其安装的
`host-core` npm 11.6.2 依赖，并通过 `serve --npm-path` 显式传入
`npm-cli.js` 绝对路径；未提供时 Host 尝试查找安装的 npm，找不到不影响
启动，但需要 npm 的安装会报告 `NPM_UNAVAILABLE`。

## 配置和启动

将受信任的 PEM 证书链及私钥分别放到 `center-certs/cert.pem` 和
`center-certs/key.pem`。两监听器使用同一证书；容器以镜像内 `node` 用户
读取挂载目录和文件，需授予该用户读取权限，且不要使私钥对其他用户可读。
证书的域名必须匹配对外地址。保护该目录，不要提交到版本库或复制到镜像。

以下示例在安全的交互式 shell 中执行，将域名替换为真实地址，勿启用
`set -x`；不要把口令、密钥写到 shell 历史或日志。文件必须妥善保护，
拥有 Docker 管理权限者也可读取容器环境变量。生成并保存独立加密密钥与
会话密钥；重启或升级必须保留加密密钥，否则无法解密已保存的凭证。

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
反向代理场景需确保两个 TLS 服务和 WebSocket 路径都正确转发，项目不提供
代理。映射其他主机端口时同步修改这些外部 URL。Compose 固定容器内数据、
端口、Web 和证书路径；可在安全的 `center.env` 中另外设置
`CENTER_NPM_PATH` 为容器内 npm-cli.js 的绝对路径，默认使用中心安装的
固定 npm。不要更换密钥或覆盖数据来“修复”启动失败。

### 首次登记 Host 设备

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

## Billion Context 受管部署

BC 为独立 Host 原生插件 `@e-launcher/billion-context` 1.0.0（能力 ID `e-launcher.billion-context`），不是中心服务或 Host 内置组件。使用 [插件 README](../plugins/billion-context/README.md) 的打包和上传流程：在中心选择 `plugin`、本地制品、目标 `host`；安装实例默认启用，Bot 绑定默认关闭，逐 Bot 显式启用后检查 operation 与每台设备的实际部署回执。中心生成未随标准 npm 制品携带的依赖锁文件；Host managed installer 用该锁文件安装依赖，中心和 Host 均需可访问依赖源及可用 npm。

升级现有部署时，先在中心上传/安装插件实例并保持 Bot 绑定关闭；停止旧 Host 并保留数据后，在中心启用目标 Bot 绑定，使离线计划生成或排队；更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度，再检查设备回执。不要在旧 Host 运行时下发启用 BC：旧 Host 内置工具与插件原名冲突，旧管理器会拒绝注册；忽略 `prepareContext` 不代表可同时加载插件。新 Host 不再内嵌 BC，未绑定/未启用时不压缩，但仍做最终预算检查。保留原数据目录和历史，不能以重置状态处理兼容问题。版本更新、回滚及实际 API 请求体见插件 README；回滚插件与回滚 Host 不是同一操作，升级前备份并确认兼容性。

## 维护和升级

`center-data` Docker volume 保存中心、relay 和受管安装数据；
`center.env` 与 `center-certs/` 在宿主机上，不在该 volume 中。备份前先
停止服务，并将数据归档、加密密钥和证书分开安全保存；归档包含敏感数据。
例如将 `BACKUP_DIR` 指向仓库外的受保护目录：

```sh
docker compose down
umask 077
docker compose run -T --rm --no-deps --entrypoint tar center -C /data -czf - . > "$BACKUP_DIR/center-data.tar.gz"
docker compose up -d --no-build
```

升级前备份并记录原镜像版本及配置；拉取/合并新源码与匹配锁文件后重建
镜像，使用原 volume、原加密密钥和证书重新启动。数据迁移及回滚应按实际
版本说明执行，不假定旧程序能读取升级后的数据库。替换证书后重启容器以
重新加载。停止、备份和恢复期间不要并行修改同一数据卷。

## 验收边界

本说明是部署入口而不是运行结果。上线前需真实验证登录、设备登记、Host
连接、两个 Bot 的配置继承与覆盖、Billion Context 的安装和跨升级状态恢复、Hindsight、HTTP 和 Node MCP、Skill、
更新/卸载与断线重连。构建和容器启动本身不能证明上述功能正常。
