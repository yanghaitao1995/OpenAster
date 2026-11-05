# 许可证与第三方材料

OpenAster 原创源码使用 [Apache License 2.0](../LICENSE)，归属说明见 [NOTICE](../NOTICE)。依赖、运行时和构建工具保留各自许可证。

| 材料 | 用途 |
| --- | --- |
| [dependency-licenses.json](dependency-licenses.json) | 依赖名称、版本与许可证清单 |
| [sbom.cdx.json](sbom.cdx.json) | 机器可读的 CycloneDX 组件清单 |
| `package.json`、`pnpm-lock.yaml` | 直接依赖与锁定版本 |
| 安装包内的第三方声明 | 对应平台运行时的许可证与归属文本 |

修改依赖后重新生成并检查清单。Electron、Chromium、Node.js、Capacitor 及原生依赖需要的许可文本随相应产物保留，不能只用项目许可证代替。

模型服务的账户权限、API 条款和数据政策独立于项目许可证。协议兼容不代表获得第三方的品牌或内容授权。OpenAster 的名称与图标不表示与其他产品存在关联。
