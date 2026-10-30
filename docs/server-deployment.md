# Airalogy BD 团队部署

每家公司部署一套实例并使用一个独立工作区。业务资料保存在可备份的 Markdown/YAML 和附件文件中，账号保存在工作区 `.bd-auth/accounts.sqlite3`。运行时不要开多个应用副本，也不要把数据卷放在 NFS/OSS 挂载盘上；业务保存依赖本机文件锁及原子替换，账号使用 SQLite。适合小团队日常进展维护，暂不提供多租户、企业 SSO 或多机高可用。

## 成员使用

- 维护人员初始化第一名管理员，管理员在“管理中心 → 成员与权限”发放 48 小时一次性邀请链接。邀请链接由管理员自行转交，不开放注册。管理员邀请时可以不填邮箱，由成员激活时补充。
- 成员打开链接，设置唯一用户名、至少 12 个字符的密码，并将密钥加入支持 TOTP 的验证器。此后使用用户名或邮箱、密码和 6 位动态验证码登录。登录分为密码和动态码两步；尚未完成验证器绑定或动态码验证的会话不能访问业务资料。设置中断后可从登录页面继续绑定。服务器和手机应开启时间同步。
- 会话最长 12 小时；退出、停用账号、调整授权或重置登录会立即使相应旧会话失效。账号邮箱保留为联系方式和可用的登录标识；邮箱归属验证默认关闭，可按[账号说明](accounts-and-branding.md)配置 SMTP 后开启。管理员应把邀请链接私下交给正确的人。
- 管理员：全部资料、邀请和权限、共享人员/公司动态、事项创建、全局历史和备份。
- 编辑成员：修改已授权事项、添加每日进展、维护关联附件。跨事项附件必须拥有全部关联事项权限。可在新增或编辑沟通进展时新建人员，人员必须参与该进展并补全事项关系。已有人员档案的修改、合并、删除，以及新对接方或范围外人员关联，仍由管理员处理。
- 事项沟通进展中的新人员先保留在表单中，可继续修改；人员档案、事项关系、进展及附件一起验证、一次保存。取消或保存失败不新增人员档案，未选中的临时人员不会保存。同名人员优先从有权查看的档案中选择；遇到不可见的同名档案只提示联系管理员核对，不返回其资料。管理员在公司动态或其他档案表单中新建人员时仍独立保存，页面会明确说明。业务人员档案不会创建登录账号。
- 只读成员：浏览、下载和导出已授权资料。导出基于同一份过滤后数据。
- “全部事项”包括未来新增事项；限定授权的成员不见公司级动态或共享对接方正文。已授权正文中的信息不会逐句脱敏，管理员应在分配事项时检查内容。
- 两人同时修改同一条资料，后保存者会看到冲突提示，草稿保留；服务端拒绝覆盖。进展保留原有日期、参与人及整理正文，录入账号单独写入版本和操作记录。账号不自动成为会议参与人。

认证使用固定版本的 [Better Auth](https://better-auth.com/docs/installation) 及其[双因素认证插件](https://better-auth.com/docs/plugins/2fa)，负责密码哈希/验证、签名 Cookie、会话、TOTP 和限速。工作台只维护邀请、成员角色和事项授权；每次读取及写入仍在数据服务内检查授权。组件公开注册已关闭，只有校验邀请后才能调用服务端账号创建能力，组件的管理、冒充、修改邮箱、关闭双因素及备用码接口均不对外开放。会话缓存关闭，动态码验证前不会授予业务访问。首次服务器启动由组件创建所需账号表。

`BETTER_AUTH_SECRET` 用于签名 Cookie 及加密验证器密钥。生成一次并存入公司密码管理器，服务器重启、迁移和备份恢复使用同一个值；不要提交到 Git 或写入业务资料。它不会包含在工作台备份内，须单独保管；丢失时须使用账号恢复重新绑定验证器。组件使用数据库持久化 IP 限速及账号级双因素失败锁定，Nginx 另有限速。代理必须覆盖客户端传来的 `X-Real-IP`，应用端口只允许该代理访问。

## 阿里云 ECS 部署

可以和现有服务共用 ECS，但使用独立容器、数据卷和反向代理站点。先确认空闲内存、CPU、磁盘和备份容量；镜像构建建议在 CI 或开发机完成，避免构建影响生产站点。示例限制为 1 CPU / 1.5 GiB，需按实际负载调整。只有宿主机的 `127.0.0.1:3100` 暴露应用；使用现有 Nginx 接入 HTTPS，不抢占现有站点的 80/443 端口。

### 推荐：使用预构建镜像

需要 Docker Engine、Compose v2、Python 3.10+ 和 iproute2。选择附带 `airalogy-bd-X.Y.Z-deploy.tar.gz` 的 GitHub Release。1.3.5 起可在同次 **Release packages** 工作流的 `deployment-assets` 任务成功、且 `deployment-ready.json` 已上传后部署，无需等待 npm 分发；核对其中版本、提交和文件摘要。`publication.json` 代表全部渠道已完成。较早版本仍须等待整个工作流成功。npm 上存在某个版本不代表容器镜像可用。

下载并解压部署包到独立目录，无需下载源码或在服务器构建。部署包包含 `compose.yaml`、`.env.example`、`image.json`、`bdctl`、`network_preflight.py` 和使用说明。镜像名为 `ghcr.io/airalogy/airalogy-bd:X.Y.Z`，支持 Linux amd64 / arm64；生成的配置进一步锁定该版本的镜像摘要，Docker 自动选择匹配的架构。核对 Release 的 `DEPLOY-SHA256SUMS`（较早版本为 `SHA256SUMS`）。以下步骤适用于包含网段检查工具的新部署包；旧包需先升级运维入口，不修改已发布产物。在解压目录执行：

```sh
cp .env.example .env
chmod 600 .env
# 生成认证密钥，将输出填入 .env 的 BETTER_AUTH_SECRET，并独立妥善保管。
openssl rand -hex 32
# 编辑 .env，设置 BD_PUBLIC_URL、BETTER_AUTH_SECRET 和经核对的网络配置。
./bdctl preflight
./bdctl pull
./bdctl run --rm bd init --id company-id --name 公司名称
./bdctl run --rm bd account-init --email admin@example.com --name 管理员姓名
./bdctl up -d
```

安装过程不需要 Node.js、pnpm 或 uv，运行依赖已在镜像内。公开 GHCR 镜像支持匿名拉取。连接 GHCR 受限时，可由维护人员将同一镜像同步到公司镜像仓库并核对摘要，再设置 `BD_IMAGE`；不要改用不明来源的镜像。

### 使用仓库中的配置或从源码构建

仓库中的 `deploy/compose.yaml` 同样只拉取镜像。复制 `deploy/.env.example` 为 `deploy/.env`，填写已发布的 `BD_IMAGE` 版本或摘要及必要配置；使用下列命令使 Compose 同时读取镜像选择和运行环境：

```sh
./deploy/bdctl pull
./deploy/bdctl run --rm bd init --id company-id --name 公司名称
./deploy/bdctl run --rm bd account-init --email admin@example.com --name 管理员姓名
./deploy/bdctl up -d
```

需要修改源码时，将 `deploy/.env` 的 `BD_IMAGE` 明确设为 `airalogy-bd:local`，增加源码构建配置：

```sh
BD_COMPOSE_OVERRIDE=deploy/compose.build.yaml ./deploy/bdctl build
BD_COMPOSE_OVERRIDE=deploy/compose.build.yaml ./deploy/bdctl up -d
```

官方 npm 下载不稳定时，可仅在源码构建命令后添加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`。它只影响构建依赖下载，仍按锁文件校验完整性。

下文的仓库命令均显式指定 `deploy/.env` 和 Compose 文件。使用下载的部署包时，在解压目录改为 `./bdctl` 即可。

复制终端的一次性链接，由管理员本人打开设置登录。不要把该链接贴入公共日志或工单。初始化已存在管理员时会拒绝重复创建；丢失验证器或管理员账号无法登录时，由持有服务器权限的维护人员执行：

```sh
./deploy/bdctl run --rm bd account-recover --email admin@example.com
```

恢复命令立即注销该账号旧会话、密码和验证器，发出新的单次邀请。不会改变原有角色或事项授权。邀请过期也可重新签发。

部署前将 `bd.example.com` 指向 ECS，并为它配置有效 TLS 证书。将 `deploy/nginx.conf.example` 合入现有 Nginx，替换证书路径，先执行 `nginx -t` 再重载。配置保留请求 Host 并按 IP 限制账号接口请求；应用还会校验 Host、Origin、会话和 CSRF。ECS 安全组不应向公网开放 3000/3100 或数据库端口；SSH 只允许维护来源。域名及中国大陆部署的备案要求由公司运维按实际主体办理。

镜像以 UID/GID 10001 的非 root 用户运行、只读系统目录，只有工作区、备份和 Python 缓存卷可写。固定版本 Node/uv、锁定 JavaScript/Python 依赖；上线应保存测试过的镜像摘要，按摘要回滚。`/api/health` 只返回存活状态，不暴露业务资料。检查容器健康状态、磁盘容量和“备份”页面状态；当前版本不自动发送告警，生产监控应对容器退出、磁盘不足及长期无成功备份报警。

## 导入现有本地工作区

在原工作区创建完整 ZIP 备份，停止该工作区的写入，再把备份交给服务器维护人员。通过下节恢复到空的新目录/卷，并切换服务；不要把真实资料加入本代码仓库或镜像构建上下文。不要同时在本地和服务器上维护两个正式副本。原工作区可保留为只读恢复来源。

如不用 Docker，可安装 Node.js 22.13+、pnpm 11、uv、Python 3.10+、Git，在引擎目录安装依赖。工作区中设置 `BD_MODE=server`、`BD_PUBLIC_URL=https://你的域名` 及 `BETTER_AUTH_SECRET` 后，执行本仓库 `bin/bd.mjs account-init`、`build`、`start --hostname 127.0.0.1 --port 3100`，由 systemd 等进程管理器托管并接入 HTTPS 代理。`BD_RUNTIME_DIRECTORY` 可指定预构建运行目录，`BD_CACHE_DIR` 可指定依赖缓存。服务器模式拒绝开发服务器和缺失 HTTPS 地址；未设置服务器模式时仍仅允许本机绑定。

### 部署前网络门槛

生产启动、重启、初始化和维护容器使用 `./deploy/bdctl`，它在 `up/run/create/start/restart/build` 前运行只读网络检查；`./deploy/bdctl preflight` 可单独检查。失败不会执行后续容器命令，不会自行删除网络、改路由或移除数据卷。直接调用 Docker 可以绕过此入口，因此服务器运维和发布步骤都应统一使用它。

示例网段只是候选，不能视为普遍安全。新实例配置 `BD_DOCKER_SUBNET`；已有实例先查看实际网络，保留已验证安全的网段。配置与现有网络不一致时会中止，需要安排单独的网络迁移，不能把重新部署当成自动迁移。

- ECS 使用 `NETWORK_PREFLIGHT_CLOUD=aliyun`，通过 IMDS 安全模式读取 VPC 主网段，失败即阻止部署，不读取云账号凭据。VPC 对等连接、VPN、办公网等额外网段填写 `NETWORK_PREFLIGHT_PROTECTED_CIDRS`（逗号分隔）。
- 非 ECS 主机使用 `NETWORK_PREFLIGHT_CLOUD=none`，明确填写受保护网段；确认没有额外网段才写字面值 `none`。空值不视为已检查。
- 检查还覆盖所有 IPv4 路由表、网卡、现有 Docker 网络及外部依赖 DNS。`NETWORK_PREFLIGHT_ENDPOINTS` 可列出该主机其他应用依赖的数据库等地址；不会打印完整连接串或密码。现有同名网络必须确属本部署且网段完全相符，才允许复用。
- `./deploy/bdctl preflight --config-only` 只供离线/CI 检查结构，不证明目标主机安全；常规部署入口仍强制运行现场检查。构建可以在独立 CI 完成，但现场检查不能移到开发机代替。

检查器与 Platform 的 `deploy/single-lab/scripts/network_preflight.py` 同源分发；更新时同步整个脚本并运行部署回归测试。仅有网络配置修复不需要提升 BD 产品版本；保留私有配置备份、部署记录和两个服务的恢复验证。实际服务器网段、凭据与故障日志不要提交到本仓库。


## 私有 OSS 自动备份

本地副本是 ECS 的独立备份卷；OSS 副本位于阿里云对象存储，服务器磁盘损坏时仍可恢复。建议两者同时启用，再定期下载一份到自己的加密电脑/磁盘。

1. 创建专用私有 Bucket，开启阻止公共访问；不要为备份前缀配置公开策略、静态网站或公共下载域名。
2. 创建专用 RAM 身份，仅允许目标 Bucket 的 `oss:GetBucketAcl`，以及 `bd-backups/*` 前缀的 `oss:PutObject`、`oss:GetObject`（含 HEAD）。不需要删除、列举全 Bucket 或修改 ACL 的管理权限。通过 ECS 环境配置专用 AccessKey，或配置会被外部系统及时轮换的临时 STS 凭据；应用本身不负责 STS 续期，不要使用主账号密钥。
3. 填写部署环境文件 `.env` 的地域、Bucket、HTTPS Endpoint、前缀和 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`。同地域 ECS 可用对应 `-internal` Endpoint。凭据只存在部署环境，页面、业务资料和备份均不保存它们。限制环境文件及 Docker 管理权限。
4. 设置 `BD_OSS_BACKUP=1`，重新创建容器。若曾在页面保存过设置，页面设置优先于环境默认值；需在“备份”页面开启“同步到私有 OSS”。立即备份一次，确认页面同时出现本地位置和 OSS 对象位置。
5. OSS 对象使用唯一名称、私有 ACL、AES256 服务端加密和 Content-MD5 校验。上传后再次核对大小与 SHA-256 元数据，确认后才标记整次备份成功。备份含密码哈希和已加密的验证器密钥，必须按敏感资料管理。
6. OSS 生命周期由管理员在 Bucket 中配置，例如仅对 `bd-backups/` 保留 90 天。程序没有删除 OSS 对象的权限。是否启用版本控制/保留策略由公司运维决定。

最小 RAM 策略示例（替换 Bucket 和前缀）：

```json
{
  "Version": "1",
  "Statement": [
    {"Effect":"Allow","Action":["oss:GetBucketAcl"],"Resource":["acs:oss:*:*:YOUR-BUCKET"]},
    {"Effect":"Allow","Action":["oss:PutObject","oss:GetObject"],"Resource":["acs:oss:*:*:YOUR-BUCKET/bd-backups/*"]}
  ]
}
```

开启自动备份后，每分钟检查，资料或账号权限/操作记录变化后按每小时或每日间隔创建备份。上传期间释放业务写锁，可以继续保存进展。上传失败保留已验证的本地 ZIP，显示失败，5 分钟后允许重试；失败不会冒充成功，也不会触发过期副本清理。没有新变化时重试复用已验证的本地 ZIP，避免反复留下相同副本；每次远端尝试仍使用唯一对象名。下一次成功备份覆盖最新资料。仅在成功完成配置的全部目标后，按保留期清理本工作区生成的本地旧 ZIP；最新副本始终保留。失败登录计数和会话清理不单独触发备份。

## 备份恢复与版本更新

完整备份包含内容、附件全部版本、历史、账号、授权及审计；不含登录会话、动态码登录挑战、限速状态、待使用邀请、远程接入设置/授权/凭据/草稿/保存请求收据、未归档的暂存上传、认证加密密钥、OSS 凭据、部署环境、备份配置和 `.bd-ai/` 中的 AI 配置、密钥、用量与临时对话。单个备份支持最多 2 GiB 解压内容 / 10 万条目，超出时会报错，需调整归档方案。

从 OSS 控制台下载 ZIP（维护人员身份）或选择本地 ZIP。保持原工作区不动，先恢复到尚不存在的新目录，例如在维护用容器中：

```sh
./deploy/bdctl preflight
./deploy/bdctl stop bd
./deploy/bdctl run --rm bd restore-backup --archive /backups/备份文件.zip --destination /workspace/restored
```

此时数据在 `/workspace/restored/content`，账号在 `/workspace/restored/.bd-auth`。将部署服务的 `command` 设置为 `["start", "--content", "/workspace/restored/content", "--hostname", "0.0.0.0", "--port", "3000"]` 后启动；账号恢复等维护命令也传同一 `--content`。应用会重新校验全部文件及关联、重建显示数据；恢复原 `BETTER_AUTH_SECRET` 后，已绑定成员重新登录，未完成激活的成员可重新签发邀请。重新配置并验证备份。确认事项、附件下载、权限和历史完整后，才处理恢复前的工作区目录。勿执行 `docker compose down -v`，它会删除持久卷。

从 1.0.0 更新到后续版本前，创建并检查完整备份、记录现用镜像摘要；用新镜像运行测试和恢复演练，再替换单实例。代码回滚使用旧镜像，数据回滚从备份恢复到新目录；不要让旧版本直接写入不兼容的新账号或内容格式。定期实际恢复一次，以确认备份可用。

操作审计记录账号变更和业务修改的“开始/完成/失败”。进程中断时可能只有“开始”，需结合版本历史检查；它是内部可追溯记录，不是防服务器管理员篡改的合规审计系统。服务器维护人员持有文件系统权限，可使用数据服务 CLI 管理内容；网页客户端不能通过请求参数伪造这项权限。

## 本地验证

`pnpm test` 执行内容校验、静态检查、生产构建和全部自动测试，含真实 HTTP 权限/并发测试及账号、OSS 故障和恢复测试。容器演练使用虚构公司和临时数据卷：

```sh
docker build -t airalogy-bd:test .
node tests/docker-smoke.mjs
```

该演练验证非 root / 只读系统、邀请激活、账号登录、空工作区、备份、重启持久化和恢复后的会话失效，结束时仅清理它创建的临时容器及卷。OSS 测试使用模拟传输；实际 Bucket、RAM 权限、网络和生命周期须在部署后用一次真实备份及恢复验证。

### 依赖安全

依赖版本由锁文件固定，发布前应扫描完整依赖树并检查实际分发产物。认证、权限和恢复测试不代替独立安全审计。



## 可选 AI 助手

部署后仍默认关闭，由管理员在“管理中心 → AI 设置”选择 OpenAI 或百炼北京地域服务并配置密钥。无需新增容器或数据库服务；运行状态在工作区卷的 `.bd-ai/`，设置及临时对话以 `BETTER_AUTH_SECRET` 派生密钥加密。AI 运行状态（含用量）不进入业务 ZIP / OSS 备份，恢复后须重新配置；独立保存模型密钥。首次启用前用非敏感样例验证账户、模型和网络。具体权限、限额与确认流程见 [AI 助手说明](ai-assistant.md)。
