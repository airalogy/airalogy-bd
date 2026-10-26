# npm 包发布

产品包名为 `@airalogy/airalogy-bd`，发布到 `https://registry.npmjs.org/`。发布者须拥有 npm `airalogy` 组织中该包的写入权限；GitHub 组织与 npm 组织分别管理。本文件描述流程，不表示某个版本已经发布。

## 首次发布

1. 完成版本号、更新记录、测试及公开文件检查，将待发布源码提交并在该提交创建 `vX.Y.Z` 标签。安装包版本和标签必须一致。
2. 在干净的该版本检出目录执行 `pnpm install --frozen-lockfile`、`pnpm test`。
3. 执行 `pnpm test:package --output-dir /path/to/release-artifacts`。此步骤打包，检查实际归档内容，在全新工作区通过 pnpm 安装该包，验证初始化、启动器、Logo、已有资料保留及生产构建，并生成 `.tgz` 和 SHA-256 校验文件。它不会发布包，也不会打开用户浏览器。
4. 由发布者完成 `npm login --registry=https://registry.npmjs.org/`，启用账号双因素验证，并检查 `npm whoami`。凭据不进入仓库或发布记录。
5. 对经过验证的同一个 `.tgz` 执行 `npm publish /path/to/release-artifacts/airalogy-airalogy-bd-X.Y.Z.tgz --access public --registry=https://registry.npmjs.org/`，按 npm 提示完成双因素验证，不重新从不同工作目录打包发布。
6. 用 `npm view @airalogy/airalogy-bd@X.Y.Z version dist.integrity --registry=https://registry.npmjs.org/` 核对版本，再从公开仓库安装到另一个空工作区验证。完成后将 GitHub Release 的版本、提交和安装方式一并记录。

npm 接收发布后会扫描安装包，通常需等待数分钟才可按包名安装。先确认公开注册表可查询到该版本，再执行安装验证；等待期间不重复发布同一版本。首次 pnpm 安装需按 README 明确许可 `sharp` 与 `unrs-resolver` 的构建脚本。

公开安装包只包含通用程序、模板、文档和许可证。产品包移除 `private: true`，独立业务工作区仍设置 `private: true`。工作区、数据库、密钥、业务附件和备份不应进入 npm 包。

版本发布后不可覆盖；修复发布为新版本。应用版本发布、更新本地依赖、服务器部署分别执行。尚未验证的安装包不能仅因源码测试通过就视为可发布。

## GitHub 可信发布

仓库提供 [Release packages 工作流](../.github/workflows/publish.yml)。正式发布 GitHub Release 时自动检查并发布 npm 和同版本容器镜像；普通提交、推送、仅创建标签、草稿 Release 和手动检查均不会发布 npm。预发布版本不允许发布到 `latest`。

### 一次性配置

1. 在 GitHub 仓库创建名为 `npm` 的 Environment，Deployment branches and tags 选择 Selected branches and tags，只添加类型为 Tag、名称为 `v*.*.*` 的规则，不允许分支进入此环境。
2. 在 npm 包的 Settings → Trusted publishing 添加 GitHub Actions：组织 `airalogy`、仓库 `airalogy-bd`、工作流文件名 `publish.yml`、环境 `npm`。允许直接 Publish；本工作流只执行正式发布，不使用 staged publish 或独立的 dist-tag 管理。更改信任配置仍需管理员完成 npm 双因素验证。
3. 也可使用 npm 11.15.0 以上的官方命令完成绑定：

   ```sh
   npm trust github @airalogy/airalogy-bd --repo airalogy/airalogy-bd --file publish.yml --env npm --allow-publish
   ```

4. 新建信任关系必须在两天内完成首次成功发布。仅保存配置、执行 `--dry-run` 或通过测试不会验证这项关系；超时需删除过期关系并重新创建。因此应在下一正式版本准备就绪时完成绑定。

工作流使用 GitHub 托管的 Ubuntu runner、固定版本的 Node.js/npm/pnpm/uv，以及固定提交的 Actions。无需配置 `NPM_TOKEN` 或其他长期发布密钥，现有 npm 账号双因素验证继续保留。此文档与工作流文件不能代替上述远程设置；可用 `npm trust list @airalogy/airalogy-bd` 和 GitHub Environment 设置检查实际状态。

### 日常发版

1. 修改版本号与更新记录，完成审阅后将源码提交、推送到 `main`。
2. 如需提前检查，在 GitHub Actions → Release packages → Run workflow 中选择 `main`。手动运行检查安装包及两种架构的镜像，不取得 npm 或 GHCR 发布权限。
3. 为已准备好的提交创建 `vX.Y.Z` 标签，在 GitHub 正式发布对应的 Release。标签必须匹配 `package.json` 的 `x.y.z`，指向 `main` 历史中的提交；发布后不移动标签或覆盖版本。
4. 工作流先执行完整测试，再打包并在独立工作区验证安装、初始化、启动器、Logo、资料保留和生产构建。测试任务只有源码读取权限，不具有 OIDC 发布权限。
5. 两个原生架构 runner 分别构建并实际测试 Linux amd64 / arm64 镜像，按架构复用 GitHub Actions 构建缓存，覆盖邀请、登录、备份、重启和恢复。两者通过后才开始发布 npm。
6. 独立发布任务进入 `npm` 环境，下载本次测试的同一份归档并核对 SHA-256、包名、版本及来源。该任务不检出业务程序、不安装程序依赖、不运行安装包脚本；通过 OIDC 临时身份向 npm 发布，并等待公开注册表中的 SHA-512 完整性校验通过。

GitHub Release 创建成功不表示 npm 已成功发布，须等待整个 **Release packages** 工作流完成；镜像发布、匿名拉取验证和 Release 附件均为独立步骤。npm 扫描或网络验证超时后，先检查注册表是否已存在该版本；不能盲目重发。工作流会拒绝覆盖已有版本。验证归档保存在该次 Actions 的 Artifacts 中，保留 14 天，测试镜像归档保留 7 天。失败时优先选择 GitHub 的 **Re-run failed jobs**，复用同一批已验证归档；不要移动标签或重新构建后覆盖已发布版本。服务器部署和业务工作区依赖更新仍需另外执行。

仓库管理员及有权修改工作流、创建版本标签和 Release 的维护者能影响发布，应只向受信任人员授予相关权限。需要多人审批时，可在 `npm` 环境增加 Required reviewers，不必改回长期 npm 密钥。

## 容器与 Release 附件

镜像发布到 `ghcr.io/airalogy/airalogy-bd:X.Y.Z`，与 npm 和 GitHub Release 的版本一致。只提供固定版本及用于合并的 `X.Y.Z-amd64` / `X.Y.Z-arm64` 标签，不自动更新 `latest`。镜像记录源码提交号及版本，并由已测试的两份归档合并成一个多架构版本，发布任务不会重新构建镜像。

GHCR 使用该次 GitHub Actions 的 `GITHUB_TOKEN`，不需要保存个人访问令牌。构建和容器测试没有镜像写权限；只有镜像发布任务取得 `packages: write`，Release 附件任务单独取得 `contents: write`。正式发布任务共用现有的 `npm` 环境及版本标签限制，不修改 npm 的信任绑定。

**首次 GHCR 发布后**，包管理员需要在 GitHub Packages 的 `airalogy-bd` 设置中将 Visibility 设为 **Public**。GHCR 新包默认私有，不能根据源码仓库公开就假定镜像也已公开。工作流在全新任务中清空 Docker 登录配置，分别验证两种架构可匿名拉取；如果首次发布停在此处，设置公开后重跑失败任务。组织须允许该仓库创建和发布容器包。

镜像验证完成后，Release 自动附上 npm 的同一 `.tgz` 及其校验文件、锁定镜像摘要的 `airalogy-bd-X.Y.Z-deploy.tar.gz`、`image.json` 与 `SHA256SUMS`。部署包不含账号、密钥或业务资料。普通提交和手动检查不创建这些正式发布附件，也不部署服务器。

不同注册表不能提供跨平台的原子发布：若 npm 已成功而镜像步骤失败，该 Release 尚未完整交付。按失败步骤重试，不更换已发布包。相同镜像摘要或 Release 附件可以安全重试；检测到同版本下不同内容时会拒绝覆盖。镜像归档过期后需人工检查发布状态，不能用新构建直接替换已有版本。

参考：[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[npm 公开组织包](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm trust 命令](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
