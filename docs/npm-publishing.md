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

## 后续使用可信发布

推荐使用 npm Trusted Publishing，将该包绑定到 `airalogy/airalogy-bd` 仓库中专门的 GitHub Actions 工作流。首次包创建完成后，由包管理员在 npm 包设置中配置组织、仓库和工作流文件名；开启前应准备好流程，并按照 npm 当前的配置有效期完成首次验证。

工作流应从指定版本标签检出并核对版本，在不授予发布凭据的任务中安装、测试和生成归档，再由独立发布任务取得 OIDC 临时身份并上传已验证的同一归档。使用受保护的发布环境控制正式发布；普通提交和推送不触发发布。CI 使用支持可信发布的 npm CLI（至少 11.5.1）与 Node.js（至少 22.14.0），无需保存长期 npm 发布 Token。

此配置需要 npm 包和 GitHub 权限配合，文档本身不会启用远程自动发布。首次人工发布与后续可信发布都不要求用户改用 npm 安装；使用者仍可通过 pnpm 固定版本安装。

参考：[npm 公开组织包](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
