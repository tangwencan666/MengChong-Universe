# P8.2 第二阶段修改边界

本轮起点为 `043cccb`，保留起点已有的后端、前端、P6/P7/P8/P8.1 未提交成果。没有将这些成果顺带纳入本轮提交，没有恢复、删除或重写历史证据。

## 性能与资源生命周期

| 文件 | 目的 |
| --- | --- |
| desktop/src/manager.cjs | 同宠物聊天仍复用；只释放隐藏超过60秒且无输入/表单/弹窗/导出/请求的宠物列表主窗口；恢复时重建；复核账号epoch、页面路径及加载状态；单轮共用owner证明但逐宠验证不变 |
| desktop/renderer/pet.css | 待机轻动有界，随后静止；保留四状态、运动与减少动画偏好 |
| desktop/src/ui-assets.cjs、gateway.cjs | 按当前生成清单加载前端资源并校验路径/大小/哈希，避免把历次构建bundle全部缓存进宿主 |
| desktop/scripts/copy-ui.cjs | 原子写入当前资源清单，保留磁盘上的旧文件 |
| desktop/test/manager.test.cjs、ui-assets.test.cjs | 释放/恢复、草稿保护、等待中的导航与身份变化、50轮复用及过期sender拒绝、资源清单边界 |

## 安装器与本地诊断准备

| 文件 | 目的 |
| --- | --- |
| desktop/src/app-profile.cjs、main.cjs | 打包程序使用安装目录之外的用户配置位置；统一AppUserModelID；可选固定字段诊断及可靠关闭网关 |
| desktop/src/launch-env.cjs、test/launch-env.test.cjs | 安装程序直接启动时也按名字移除模型环境变量，不读取密钥值、不改永久环境 |
| desktop/src/diagnostics.cjs、test/diagnostics.test.cjs | 默认关闭、纯本地、白名单事件与有界旋转；不启用内存转储或上传 |
| desktop/electron-builder.config.cjs、release-policy.json | per-user NSIS、保留用户数据、禁止发布和自动更新、保留未来签名验证要求 |
| desktop/scripts/package-installer.cjs、package-portable.cjs、inspect-installer.cjs | 过滤模型/签名/发布凭据后构建本地未签名包，严格内容白名单与产物核查，不安装或发布 |
| desktop/scripts/build-icon.cjs、assets/app.ico、assets/ASSET_NOTICE.md | 由项目原有原创几何图形生成7个尺寸图标，记录来源 |
| desktop/package.json、package-lock.json | 固定本地构建开发依赖electron-builder 26.18.0及测试/构建入口；开发依赖不进入运行包 |
| desktop/test/release-preparation.test.cjs | 图标、构建凭据过滤、安装器和发布策略回归 |

## 实测工具与文档

`desktop/test/p82-stability.cjs` 使用实际Electron、现有React/FastAPI与新SQLite、本地Mock运行30–60分钟。它保存进程角色、窗口、sender、生命周期、前后源码哈希及清理结果；测试中的showInactive设置明确记录，不替代正式窗口焦点验收。

`desktop/test/p82-e2e.cjs` 增加显式项目内打包程序入口及诊断检查，仍执行Win32身份验证和物理鼠标测试。运行的是解包后的实际程序，不执行NSIS安装/卸载。

`desktop/test/window-close.cjs` 与对应离线回归只修正测试驱动对异步closed的等待；关闭被否决时失败，不强制销毁窗口，也不修改产品聊天逻辑。

新增文档：性能测试口径、发行/更新/诊断设计、免费额度后端评估、本修改清单，以及最终阶段验证报告。没有新增支付、免费额度迁移或无关业务模块。

测试日志、SQLite、截图、性能逐样本结果、未签名安装器及构建工具均为本地产物，不纳入源码提交或上传。阶段完成时再核对所有起点源文件及905份历史P8.1/P8.2文件的哈希。
