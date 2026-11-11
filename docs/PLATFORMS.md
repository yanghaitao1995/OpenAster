# 平台与安装包

当前源码版本为 **0.2.4 预览版**，[0.2.4 Release](https://github.com/yanghaitao1995/OpenAster/releases/tag/v0.2.4) 已公开五个安装文件。文件、系统与架构见下表，签名、SHA-256 和逐项验收结果见 Release 正文及[教程第 11.1 节](TUTORIAL.md#111-下载入口与各平台文件)。未列出的平台或架构尚未提供；源码或工作流存在，不等于已经完成安装验收。

## 使用前说明

OpenAster 是采用 Vibe Coding 开发的学习与探索项目。软件依据 [Apache License 2.0 第 7、8 条原文](../LICENSE)以“现状”提供，在适用法律允许的范围内不提供明示或默示保证，不承诺无错误、绝对安全或适合特定用途。法律不允许排除或限制的责任不因此排除或限制。本说明用于帮助理解使用边界，不修改许可证，也不增加非商业使用等限制。

- **核验结果与费用**：AI 生成的答案、代码和搜索摘要可能错误或不完整，执行、传播或据此决策前应自行核对来源和结果。模型与搜索服务遵循各自的账号、配额和计费规则；开源软件免费不等于第三方调用免费。
- **确认发送的资料**：使用外部模型时，对话、已发送图片、选定或由工具读取的文件内容以及工具结果可能发送给该模型服务。搜索词会发送给所选搜索服务，读取网址会向目标网站发起请求。只提供有权使用的资料，并核对相关服务的隐私与数据处理说明；不要在消息、搜索词、网址或公开反馈中放入密钥和私人信息。
- **保留可恢复的数据**：先在练习项目中使用，重要操作或更新前分别备份会话数据与工作区文件。应用备份的内容范围见[备份与恢复](BACKUP.md)，不能视为整台电脑的副本。授权命令使用主机当前账户权限，可能修改文件、启动程序或联网；工作目录和审批规则不是操作系统沙箱。停止、撤销或打断不会回滚已经发生的修改与请求。

## 各平台安装与使用条件

以下是各类客户端的使用条件，不是已经发布的安装包清单；仍须以对应 Release 的附件为准。

| 平台或交付形态 | 使用前条件 | 当前预览版的边界 |
| --- | --- | --- |
| 网页 | 本机启动 Node.js 服务，浏览器访问 `http://127.0.0.1:4317` | 默认仅回环监听，不是公开托管网站。跨设备访问需自己配置可信 TLS 证书、认证与允许的来源；不能把本机 HTTP 地址当作远程网关。 |
| Windows 桌面包 | 核对包的处理器架构、支持的 Windows 版本及校验值 | 当前预览包未作发布者代码签名。系统出现来源或签名警告时先核对，不要求关闭防护或绕过警告安装。 |
| macOS 桌面包 | 核对 Intel / Apple Silicon 架构与支持的 macOS 版本 | 当前构建使用 ad hoc 临时签名并保留强化运行时；这不是 Apple Developer ID 签名，也未公证，不表示经过 Apple 的分发审核。实际签名状态以包说明为准，不通过关闭 Gatekeeper 或移除安全标记来代替核验。 |
| Linux 桌面包 | 核对发行版、处理器架构、包格式和所需桌面运行库 | 某一种架构或发行版的构建结果不能代表全部 Linux 环境。缺少依赖时按可信发行版与对应包说明处理，不直接执行来源不明的安装脚本。 |
| Android APK | 使用与包说明兼容的设备，并准备可信 HTTPS 主机网关 | 当前调试 APK 用于学习测试，不是应用商店正式发行包；调试签名不代表商店审核。文件和命令在网关主机执行，不能忽略证书错误来连接。 |
| iOS 模拟器 `.app` | 在 Mac 的 Xcode 模拟器中使用匹配的运行环境 | 即使提供此类构建，也只是模拟器应用，不能安装到 iPhone；将它压缩或改名为 `.ipa` 不会变成真机安装包。 |
| iPhone / iPad 真机 | 需要有效的 Apple 签名、匹配的描述文件及适用分发渠道 | 当前没有 Apple Developer 分发身份，不提供可直接安装的 IPA 或 TestFlight 邀请。可在 Safari 中通过自己配置的受信任 HTTPS 网关使用网页版，不降低 TLS 与认证要求。 |

下载后先核对**版本、系统要求、架构和 SHA-256**，再检查 Release 中该包的签名与安装说明。哈希一致用于核对文件完整性，不能替代来源与签名核验；出现安全或证书警告时，先停止并确认原因。

以下五个文件已在 [0.2.4 Release](https://github.com/yanghaitao1995/OpenAster/releases/tag/v0.2.4) 发布。该页面正文集中记录字节数、SHA-256、签名和逐项验证结果。

| 文件 | 系统与架构 |
| --- | --- |
| `OpenAster-0.2.4-win-x64.exe` | Windows，x64 |
| `OpenAster-0.2.4-mac-arm64.dmg` | macOS，Apple Silicon arm64 |
| `OpenAster-0.2.4-linux-x86_64.AppImage` | Linux，x86_64 |
| `OpenAster-0.2.4-linux-amd64.deb` | Debian / Ubuntu 类发行版，amd64 |
| `OpenAster-0.2.4-android-vc14-debug.apk` | Android，Java / WebView 客户端 |

GitHub 自动提供的 Source code（ZIP / tar.gz）是源码，不是安装程序；运行方法见 [README](../README.md#在电脑上运行网页版)。

Android 调试包更新前，先核对 Release 记录的签名证书摘要与已安装应用是否相同。不同签名不能直接覆盖安装。先备份会话与主机项目；若系统提示签名不一致，保留原应用和数据，确认迁移方法，不直接卸载来消除提示。调试包不是应用商店正式版。

后续若提供 iOS 真机分发，需要准备 Apple Developer 分发资格、有效签名和相应配置，再通过适用渠道交付。Apple 的 [TestFlight 说明](https://developer.apple.com/testflight/)与 [App Store Connect 描述文件说明](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)列出了相关流程；这些资料不表示本项目已经完成该流程或获得上架许可。

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

桌面安装包在 GitHub 托管运行器上的验收已通过：Windows Server 2025 x64、macOS 26 arm64，以及 Ubuntu 22.04 x64 的 DEB 和 AppImage。检查覆盖安装或原包入口启动、系统凭据、备份恢复及四次真实重启（五个进程）。[桌面记录 42563014183](https://github.com/yanghaitao1995/OpenAster/actions/runs/42563014183) 对应实际构建提交 `787c524a2f13e7d8919941e0f6f1307e068b04d5`。

Android 0.2.4 / versionCode 14 在 API 36 x86_64 非 root 模拟器上完成 14 步验收，覆盖包内容、版本、签名、安装、离线页面、HTTP 网关拒绝、设置与许可证导航及冷启动。[移动端记录 42566033509](https://github.com/yanghaitao1995/OpenAster/actions/runs/42566033509) 对应发布标签 `v0.2.4` 的源码提交 `f206d5fd4d45274046a738ca591c2cbce4c4a20c`。

这是两个构建来源。发布提交的 424 项受控文件中，422 项与桌面构建提交一致；只有 `.github/workflows/mobile.yml` 和 `scripts/verify-published-android.mjs` 有 Android 验收相关变化。桌面运行代码、构建规则和锁文件未变；四个桌面包的 117 项 ASAR 内容与 27 项共享网页资源另行核验。完整比较与资源摘要见[教程第 11.1 节](TUTORIAL.md#111-下载入口与各平台文件)。该比较针对上述两个冻结提交，默认分支后续的文档修订不改变这些安装文件。

桌面验收使用本地模拟任务，备份与切换前受控暂停新的页面请求，系统文件选择器返回值由夹具注入，草稿通过 webContents/DOM 操作；不代表自然空闲、系统选择器人工操作、真实键盘、首次下载信任或升级路径验收。Android 检查不包含真机、签名升级、真实 HTTPS 网关连接或真实模型任务。上述验收未调用付费模型，也不保证所有系统版本、设备与任意任务均通过。

本轮 iOS 构建在官方依赖下载阶段遇到 HTTP 504，未取得通过的模拟器构建；当前也没有 Apple Developer 分发身份，不提供真机 IPA 或 TestFlight 邀请。iPhone / iPad 可通过受信任 HTTPS 网关在 Safari 使用网页版。

Android 调试包用于学习测试，不是应用商店正式发行包。桌面包的签名状态在 Release 中明确标记；不要通过关闭系统安全检查或忽略 HTTPS 证书错误来解决安装与连接问题。
