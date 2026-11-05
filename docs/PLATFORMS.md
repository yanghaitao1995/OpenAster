# 平台与安装包

应用版本为 **0.2.0 预览版**。发布文件集中在 [GitHub Releases](https://github.com/yanghaitao1995/OpenAster/releases)，每个文件按版本、操作系统与处理器架构命名。下载时同时核对该版本的说明与 SHA-256。

## 客户端与运行位置

| 客户端 | 界面与任务执行 | 构建环境 |
| --- | --- | --- |
| 网页 | 浏览器打开工作台，任务在启动服务的电脑上执行 | Node.js 24 |
| Windows | Electron 桌面界面与本机任务服务 | Windows、Electron Builder |
| macOS | 相同桌面界面与本机任务服务 | macOS；正式分发还需签名、公证 |
| Linux | 相同桌面界面与本机任务服务 | Linux、对应桌面运行依赖 |
| Android | 伴侣界面连接主机网关 | JDK 21、Android SDK、Gradle |
| iOS | 伴侣界面连接主机网关 | macOS、Xcode；真机分发需要签名 |

移动端的文件和命令操作发生在服务主机。它需要可信 HTTPS 网关，不把电脑上的工具进程迁移到手机。项目创建、选择与切换使用共用入口，实际可选范围由主机决定。

## 本地构建

按 [README](../README.md) 安装项目依赖后：

```sh
pnpm desktop:dist
pnpm mobile:android
```

第一条生成当前平台桌面包；第二条同步 Android 工程，之后在 `mobile/android` 使用 Gradle 构建。iOS 在 Mac 上运行 `pnpm mobile:ios`，再使用 Xcode 构建和签名。详细开发命令见[开发指南](DEVELOPMENT.md)。

网页、桌面与移动端共用 `public/`。`pnpm build` 在桌面和移动资源中保存相同的共享文件摘要；原生版本也从项目版本同步。生成工程与构建成功是不同步骤，安装运行仍需单独验证。

## 当前验证范围

当前维护环境是 Windows。Windows 与 Android 可在本机进行构建和运行检查；macOS、Linux 使用仓库的构建工作流验证，实际结果以对应运行记录为准。没有 Mac/iOS 真机验收或 Apple 分发身份时，不提供声称已完成真机签名验收的 IPA。

Android 调试包用于学习测试，不是应用商店正式发行包。桌面包的签名状态在 Release 中明确标记；不要通过关闭系统安全检查或忽略 HTTPS 证书错误来解决安装与连接问题。
