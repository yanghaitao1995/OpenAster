# 开发指南

使用 Node.js 24 和根目录 `package.json` 指定的 pnpm。以下命令都在仓库根目录执行。

| 命令 | 用途 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装依赖 |
| `pnpm dev` | 监听服务代码并启动本地网页 |
| `pnpm check` | 检查 JavaScript 语法和 JSON |
| `pnpm test` | 运行 Node 测试 |
| `pnpm test:e2e` | 运行浏览器测试 |
| `pnpm build` | 生成桌面与移动端共用资源 |
| `pnpm desktop` | 启动 Electron 开发入口 |
| `pnpm desktop:pack` | 构建当前平台的桌面目录包 |
| `pnpm desktop:dist` | 构建当前平台安装包，不自动发布 |
| `pnpm mobile:prepare` | 生成移动端网页资源 |
| `pnpm mobile:android` | 生成并同步 Android 工程 |
| `pnpm mobile:ios` | 在 macOS 上生成并同步 iOS 工程 |
| `pnpm source:pack` | 按公开清单导出源码到新的 release 子目录 |

浏览器测试在 Windows 上使用已安装的 Microsoft Edge；macOS、Linux 使用 Chromium，首次可运行 `pnpm exec playwright install chromium`。原生构建工具见[平台说明](PLATFORMS.md)。

## 修改与验证

从 [ARCHITECTURE.md](../ARCHITECTURE.md) 找到负责该行为的模块，再缩小到一个可复现的问题。任务状态、审批、存储和模型协议的改动，需要检查成功、失败、取消及恢复路径。界面改动需要在浏览器中看实际排版与交互。

提交前运行 `pnpm check`、`pnpm test`、`pnpm build`。只对受影响的行为增加验证；不必为文字修改运行原生安装测试。测试默认使用合成数据与本机模拟模型，不需要贡献者提供付费账号。

## 版本与构建

根目录 `package.json` 是应用版本来源；移动包版本须与其一致。`mobile/android-version.json` 的整数构建号用于原生升级，发布时递增。iOS 同步脚本把相同的应用版本和构建号写入 Debug、Release 配置。

`pnpm build` 在 `dist/public/build-info.json` 和 `mobile/www/build-info.json` 写入共享资源摘要。版本相同、共享摘要相同，表示两端由同一组界面源码生成；这不能替代安装测试。

桌面打包使用 `dist/`。Android/iOS 工程与 `mobile/www/` 都是生成物，源码仓库只保存生成它们的配置、资源和脚本。

## 发布范围

`config/release-policy.json` 列出了公开源码、文档及资源。新增公开文档时同步更新该文件、`.gitignore` 和文档导航。导出器会拒绝链接、凭据文件和未审查的文件类型，且不覆盖旧导出目录。

发布前核对文件清单、差异、密钥扫描结果和截图，再用独立文件读取程序验证导出内容。在受组织管理的设备上，只使用获准的明文导出流程。

GitHub Actions 负责不同操作系统上的独立检查。安装包与签名状态以具体 Release 为准；工作流存在不代表某个版本已经构建成功。
