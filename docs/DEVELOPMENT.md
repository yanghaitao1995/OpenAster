# 开发指南

从[贡献指南](../CONTRIBUTING.md)了解项目范围，使用 Node.js 24 和项目指定的 pnpm 版本。以下命令以项目根目录为工作目录。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装依赖 |
| `pnpm dev` | 监听服务代码变化并运行本地服务 |
| `pnpm check` | 执行项目静态检查 |
| `pnpm test` | 运行核心、服务、桌面与移动模块测试 |
| `pnpm test:e2e` | 运行 Playwright 浏览器测试 |
| `pnpm build` | 生成本地应用分发目录 |
| `pnpm desktop` | 运行 Electron 桌面开发入口 |
| `pnpm desktop:pack` | 生成本机平台的桌面目录包 |
| `pnpm desktop:dist` | 构建桌面分发包，脚本配置为不发布 |
| `pnpm mobile:prepare` | 准备移动端 Web 资源 |
| `pnpm mobile:android` | 准备 Android 原生项目 |
| `pnpm mobile:ios` | 准备 iOS 原生项目 |

浏览器测试需要相应的 Playwright 浏览器。按测试配置准备浏览器，例如 `pnpm exec playwright install chromium`；这会下载测试运行时。原生构建还需要各自平台的工具链，见[平台现状](PLATFORMS.md)。

## 验证与报告

先运行与改动直接相关的检查。修改协议、权限、存储或任务状态时，验证失败、拒绝、取消与恢复路径；修改界面时检查实际浏览器呈现，而不仅是 DOM 字符串。

提交前通常运行 `pnpm check`、`pnpm test` 和 `pnpm build`，根据改动补充浏览器或平台测试。记录实际命令和环境；未验证的平台保持未验证状态。不要将历史测试数量作为当前版本的保证。

测试优先使用本机模拟服务与合成数据。真实模型验证应单独授权并控制请求规模，不应成为其他贡献者运行测试的前提。

## 仓库边界

`core/`、`server/`、`public/`、`desktop/`、`mobile/`、`skills/`、`scripts/` 和测试源属于项目实现。目录责任见[架构概览](../ARCHITECTURE.md)。

依赖、工具链、应用数据、生成的 Android/iOS 工程、构建产物和临时诊断不属于源码贡献。公开文档采用明确的文件清单；新增公开文档时，同时检查 `.gitignore` 中的文档例外和文档导航，避免误加入本机证据。

GitHub 工作流配置存在并不表示它们已在你的仓库运行。启用远程构建、添加签名凭据或发布制品前，应由仓库维护者检查权限、来源和平台条件。

受组织管理的设备应遵循其代码、数据和加密规则。应用能读取文件，不代表该文件已获准以明文导出；发布前使用组织认可的审查与导出流程。
