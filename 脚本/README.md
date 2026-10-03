# 学习网站辅助工具

如果希望直接在 Edge 篡改猴插件中运行，请使用 [篡改猴版本安装说明](tampermonkey/README.md) 和 `tampermonkey/learning-helper.user.js`。该版本无需 Node.js，使用 Edge 已有登录状态，以网页面板代替终端。

使用 Node.js + Playwright，启动可见的 Chromium 窗口。首次手动登录后保存 `storageState.json`，读取页面上的课程、章节和进度，在终端选择一节课程并打开其页面，持续读取 HTML5 视频状态。

## 安装和运行

需要 Node.js 22 或更新版本（含 npm），以及桌面图形环境。在项目目录运行：

```powershell
npm install
npx playwright install chromium
```

先编辑 `config.js`，填写网站 URL 和实际选择器，再启动：

```powershell
npm start
```

1. 首次启动进入 `LOGIN_URL`。在可见浏览器中手动登录并处理验证码、登录验证。
2. 确认已登录成功后，在终端按 Enter。程序把登录状态保存到项目根目录的 `storageState.json`，随后进入 `COURSE_URL`。
3. 终端显示当前已加载条目的课程名称、章节名称、学习进度。已完成条目被过滤，未知进度保留并标为“进度待确认”。
4. 输入序号，程序在新标签页打开对应的课程链接。在浏览器中手动开始播放。
5. 默认每 2 秒输出视频标题、当前播放时间、总时长、是否播放结束。视频结束后提示：

   > 本节课程播放结束，请确认已经完成学习。

6. 在终端按 Enter 停止监控、关闭课程标签页并返回列表。列表页面可手动刷新，然后输入 `r` 重新读取。输入 `q` 或按 Ctrl+C 退出并关闭程序启动的浏览器。

后续运行自动载入已保存状态。如果登录过期，输入 `l` 重新手动登录，或运行：

```powershell
npm run login
```

手动登录成功的确认由你负责；工具无法在不了解网站的情况下准确判定认证是否完成。状态文件包含登录凭据，已经加入 `.gitignore`，请勿共享。保存 cookies、localStorage 和支持的 IndexedDB 数据；仅依赖 sessionStorage 或设备绑定的站点可能需要每次重新登录。

## 必须配置的地址和 CSS selector

下面都是示例，不能直接用于未知网站。用浏览器开发者工具检查实际 DOM，再修改 `config.js`。

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `LOGIN_URL` | `https://你的域名/login` | 登录页完整地址 |
| `COURSE_URL` | `https://你的域名/courses` | 登录后的课程/章节列表地址 |
| `COURSE_ITEM_SELECTOR` | `.course-item` | 一节可选择课程/章节对应的重复容器 |
| `COURSE_TITLE_SELECTOR` | `.course-title` | 容器内部的课程名称 |
| `PROGRESS_SELECTOR` | `.progress` | 容器内部显示学习进度的文本元素 |
| `CHAPTER_TITLE_SELECTOR` | `.chapter-title` | 容器内部的章节名称；没有可设为空字符串 |
| `COURSE_LINK_SELECTOR` | `a.course-link` | 容器内部通往课程学习页的 `<a href>`；必须精确匹配课程入口 |
| `COURSE_FRAME_SELECTOR` | `iframe#course-list` | 列表所在 iframe；通常留空 |
| `VIDEO_TITLE_SELECTOR` | `h1` | 视频所在文档中的标题元素，可按实际页面调整 |

名称、章节、进度、入口选择器都是相对于每个课程条目查找的。如果条目本身就是目标元素，可以填 `:scope`，例如条目本身是 `<a href>` 时将 `COURSE_LINK_SELECTOR` 设为 `:scope`。

默认配置对应以下结构：

```html
<div class="course-item">
  <span class="course-title">Node.js 入门</span>
  <span class="chapter-title">第一章：运行环境</span>
  <span class="progress">50%</span>
  <a class="course-link" href="/lesson/1">进入课程</a>
</div>
```

可以在浏览器开发者工具 Console 中只读检查匹配结果：

```javascript
document.querySelectorAll('.course-item').length
document.querySelector('.course-item')?.querySelector('.course-title')?.textContent
document.querySelector('.course-item')?.querySelector('a.course-link')?.getAttribute('href')
```

若页面每张卡片包含多节课，需将 `COURSE_ITEM_SELECTOR` 定位到每一节的行，并让课程名称、章节名称和进度在该行内可读取。父级课程名称不在章节行内、嵌套列表 iframe 或特殊 DOM 结构需要按实际页面调整 `src/courses.js`；通用示例不会猜测页面层级。

## 读取范围和行为

- 只扫描当前页面已加载的条目。分页、滚动加载、展开目录由你手动操作，再输入 `r` 重新读取。零匹配会提示检查选择器，不会报告“全部学完”。
- 识别 `0%`～`100%`、`2/3`、`2/3 节`，以及“未开始”“学习中”“未完成”“已完成”等明确状态。其他文本标为待确认。若网站只用进度条宽度或属性表示进度，需要调整读取逻辑；不会把未知进度当作 0%。
- 只导航到指定 `<a href>` 的 HTTP(S) 地址，不自动点击条目、按钮或用页面内部接口推算课程链接。课程入口仅有 JavaScript 按钮、依赖点击处理器或新标签页不兼容时，需要手动打开真实学习页面或按网站结构适配。
- 课程入口选择器应仅匹配学习内容页面，避免匹配完成、考试、测验、签到、提交等入口。
- 视频读取覆盖课程标签页主文档及其 iframe；轮询时也会发现新出现的 iframe/video。标题优先使用视频 `title`、`aria-label`，再读取配置的标题元素及文档标题。多个视频会分别显示。未加载元数据时总时长显示“未知”。
- 监听原生 `ended` 事件并读取 `video.ended`，同一文档内同一视频源结束提示一次。不将播放结束等同于网站判定学习完成，也不会根据进度自动选下一课。
- 不主动播放/暂停视频，不修改 `video.currentTime` 或 `playbackRate`，不触发伪造媒体事件。不自动点击完成课程、考试、测验、签到、提交，不调用内部接口伪造学习进度，不绕过验证码、反自动化检测或登录验证。
- 遇到网站验证时请手动处理；网站拒绝自动化浏览器时，工具不尝试隐藏自动化特征。
- Shadow DOM 内的视频、非 HTML5 播放器和站点私有学习状态不在本通用示例的读取范围内。网页自身可能照常记录你的实际学习行为。

## 验证

```powershell
npm test
```

该命令执行全部项目源码的基本语法检查，并用 Node.js 内置测试覆盖进度判定、课程链接过滤和时长格式化，不登录真实网站。

如果当前终端没有 npm，但已有 Node.js，可直接运行：

```powershell
node --check config.js
node --check src/login.js
node --check src/courses.js
node --check src/player.js
node --check src/index.js
node --test
```

如果提示 `npm` 无法识别，安装含 npm 的 Node.js 并重新打开终端；若提示 Chromium 可执行文件不存在，执行 `npx playwright install chromium`。

## 文件结构

```text
config.js             地址、CSS 选择器与读取间隔
src/login.js          手动登录、保存和复用登录状态
src/courses.js        读取课程、判定展示进度、提取学习页链接
src/player.js         只读 HTML5 视频状态与结束提示
src/index.js          headed Chromium 与终端交互
test/helper.test.js   本地逻辑测试
```

相关 API 参考：[Playwright 登录状态](https://playwright.dev/docs/auth)、[Chromium 启动配置](https://playwright.dev/docs/api/class-browsertype#browser-type-launch)。
