# 内置浏览器与学习办公资料

本次实现以网页操作和资料整理为基础，覆盖开发预览、课程资料收集、论文来源整理、办公简报和会议准备。浏览器入口、资料库入口均在聊天标题栏，内容显示在右侧详情栏。

## 简短调研与选择

[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 提供主进程管理的网页视图，适合复用现有 Chromium，不需要额外下载浏览器。按照 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 开启上下文隔离和网页进程沙箱、关闭 Node 集成、验证内部接口来源，远程网页不加载应用 preload。

[Zotero 来源采集](https://www.zotero.org/support/adding_items_to_zotero)、[笔记](https://www.zotero.org/support/notes)和[引用导出](https://www.zotero.org/support/creating_bibliographies)说明了来源元数据、附属笔记与引用输出之间的关系。本期采用这个基础结构，提供任务内资料库、摘录、标签、Markdown/BibTeX 导出；网页 HTML 表格另可导出 CSV。并未接入 Zotero 账户或声称具备完整文献管理能力。

## 已实现流程

1. 打开浏览器并访问网页，手动完成必要的登录；开发服务器、校园或公司内网会要求确认具体来源。
2. 保存网页来源与正文，或先选中网页文字再摘录；在资料库修正元数据、补笔记、加标签。
3. 选择来源导出资料包或引用；也可将办公简报、课程学习或会议准备草稿放入输入框，补充要求后发送。
4. 网页表格预览后导出 CSV；模型也可使用同一浏览器和资料库工具完成用户授权的任务。

## 行为与边界

- 浏览器工具按任务隔离，并对实际网址检查权限。元素引用随导航失效；节点含义改变时拒绝旧操作。工具不读取密码值，不提供任意 JavaScript 执行入口。
- 切换或删除对话会取消该次任务激活中的界面操作；迟到的网页请求不会在已删除对话中创建标签，旧资料导出不会在新对话弹出保存框。
- 网页处于独立会话，不共享外部浏览器数据。文件上传下载及网页硬件权限目前被阻止。浏览器登录数据会保留在任务对应的本地 partition 中。
- 网络目的地会对导航、重定向和子资源进行检查；这是应用层目的地检查，不是系统网络沙箱或完整 DNS 地址固定机制。
- 快照和表格抽取覆盖主文档 DOM，尚未提供跨框架操作、OCR 或完整 PDF 解析。抽取有长度、表格数量和行列上限；截断会标注。
- 来源元数据不是经过数据库核验的学术记录。引用导出只包含已保存字段，未知作者或日期留空。
- 资料库按对话持久化并串行写入，损坏数据不会自动覆盖。界面导出需要选择文件位置；模型导出走文件权限和修改冲突检查。删除对话会清理对应资料库。
- 截图保存为会话产物；目录已声明支持视觉的模型同时获得图片输入。纯文本或未声明能力的模型获得保存路径并使用 DOM 快照，不向其发送图片，以免服务返回不支持图像错误。

## 验证

关键回归测试覆盖资料库隔离与并发、局部更新、损坏库保护、引用与 CSV 转义、网页目的地策略、DOM 引用失效、审批队列、截图消息配对和界面隐藏生命周期。

真实网页检查覆盖输入与点击、来源和表格抽取、内网授权、导航引用失效、操作取消，以及网页显示或隐藏时的有效截图和临时截图窗口清理。截图检查使用与应用相同的默认 Chromium GPU 配置；未将禁用硬件加速的环境计为已验证。

真实 Electron 本机网页检查位于 `tools/smoke/browser.ts`。从仓库根目录将其打包后运行：

```powershell
& ./packages/app-desktop/node_modules/.bin/esbuild.cmd tools/smoke/browser.ts --bundle --platform=node --format=cjs --external:electron --outfile=packages/app-desktop/dist/browser-smoke.cjs
& ./packages/app-desktop/node_modules/.bin/electron.cmd ./packages/app-desktop/dist/browser-smoke.cjs
```

脚本使用隐藏窗口与独立临时浏览器目录，只连接本机测试页面；测试结果包含该临时目录位置，其中保存 `attached.png` 和 `detached.png` 供视觉核对，不读取已有登录数据。
