# Edge 篡改猴版本

这个版本直接在 Edge 的篡改猴（Tampermonkey）中运行，不需要 Node.js、npm、Playwright 或单独启动 Chromium。原来的 Node.js 文件不能直接粘贴到篡改猴。

## 安装

1. 在 Edge 中打开篡改猴，选择“添加新脚本 / 创建新脚本”。
2. 删除编辑器中的模板，完整粘贴 `learning-helper.user.js` 内容。
3. 将头部 `@match https://example.invalid/*` 改成真实学习网站域名，例如 `@match https://learn.example.com/*`。登录页、课程页在不同域名时，为需要显示面板的域名分别添加一行 `@match`。保留末尾 `/*`，使课程路由也能匹配。
4. 编辑脚本顶部的 `CONFIG`：填写 `LOGIN_URL`、`COURSE_URL` 和实际 CSS selector。
5. 按 Ctrl+S 保存并启用脚本，刷新学习网站页面。右下角应出现“学习辅助工具”面板。

如果脚本不运行，检查篡改猴启用状态、脚本的 `@match` 是否匹配当前 URL，以及扩展对该网站的访问权限。新版本浏览器可能还要求开启用户脚本执行权限，按篡改猴当前提示操作；参考 [Tampermonkey 官方 FAQ](https://www.tampermonkey.net/faq.php)。脚本元数据规则见 [官方文档](https://www.tampermonkey.net/documentation.php)。

## 配置

本脚本是独立文件，不读取项目根目录的 `config.js`。修改篡改猴编辑器内的 `CONFIG`：

| 配置 | 用途 |
| --- | --- |
| `LOGIN_URL` | 登录页完整地址 |
| `COURSE_URL` | 课程/章节列表完整地址 |
| `COURSE_ITEM_SELECTOR` | 每一节课程/章节的容器，例如 `.course-item` |
| `COURSE_TITLE_SELECTOR` | 容器内课程名，例如 `.course-title` |
| `PROGRESS_SELECTOR` | 容器内进度文本，例如 `.progress` |
| `CHAPTER_TITLE_SELECTOR` | 容器内章节名，例如 `.chapter-title`；没有则填 `''` |
| `COURSE_LINK_SELECTOR` | 容器内通往学习页的 `<a href>`，例如 `a.course-link`；容器本身是链接时填 `:scope` |
| `COURSE_FRAME_SELECTOR` | 列表在同源 iframe 时填写，否则留空 |
| `VIDEO_TITLE_SELECTOR` | 视频所在文档内的标题，例如 `h1` |

标题、进度、章节和链接选择器均相对于每一个课程容器。只为真正的学习内容入口配置链接选择器；不要匹配完成、考试、测验、签到、提交入口。

## 使用

1. 在 Edge 中手动登录网站。登录、验证码和验证流程都由你操作，登录状态由当前 Edge 浏览器及网站管理。
2. 手动进入课程列表，或点击面板中的“打开课程列表”。
3. 点击“读取课程”，在下拉框中选择课程。面板显示课程名、章节名、进度；F12 开发者工具 Console 同时显示课程表格。
4. 点击“打开所选课程”，在当前标签页导航到对应链接，然后自己点击网页播放器开始学习。
5. 面板持续显示 HTML5 视频标题、当前时间、总时长和结束状态。原生视频结束后，面板与浏览器控制台提示：“本节课程播放结束，请确认已经完成学习。”

“收起”只折叠面板，不停止监控。关闭标签页或禁用脚本后刷新页面可停止。网站处于后台时，浏览器可能降低轮询频率。

## 与 Node.js 版本的差异和范围

- 不创建或导入 `storageState.json`，也不读取、导出登录 cookie；使用 Edge 已有登录会话。
- 操作入口和视频状态显示在网页面板；课程列表和结束提示也输出到浏览器 Console，没有系统终端。
- 不自动进入课程列表：由你点击面板按钮前往，避免每次页面加载都跳离当前课程。
- 只读取已加载课程；翻页、展开目录、滚动加载由你手动操作，再点击“读取课程”。零匹配不会被报告为全部完成。进度支持百分比、章节分数和明确状态文本；无法识别时标为待确认。
- 只支持标准 HTTP(S) 课程链接。仅有 JavaScript 按钮的课程入口需要手动打开或按真实 DOM 适配。
- 读取主文档和可访问的同源 iframe 视频；浏览器同源策略限制跨域 iframe 的访问，不绕过该限制。跨域播放器、Shadow DOM 播放器及非 HTML5 播放器需要另外适配。
- 原生 `ended` 事件和 `video.ended` 都可触发提示，同一个视频元素的相同视频源只提示一次。提示保留最近一次结束的视频标题，不代表当前新视频也已结束。
- 不点击网站完成、考试、测验、签到或提交按钮，不自动播放、暂停、跳转视频时间或修改倍速，不发送网站内部请求伪造学习进度，不绕过验证码、反自动化检测或登录验证。

尚未针对真实学习网站验证，示例选择器需要按实际页面修改。可用 `node --check tampermonkey/learning-helper.user.js` 做基础语法检查；运行本脚本本身不需要 Node.js。
