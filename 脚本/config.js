export default {
  // 必填：替换为实际网站地址。
  LOGIN_URL: '',
  COURSE_URL: '',

  // 必改：每个匹配项应代表一节可打开的课程/章节。
  COURSE_ITEM_SELECTOR: '.course-item',
  // 以下选择器均相对于 COURSE_ITEM_SELECTOR 对应的元素。
  COURSE_TITLE_SELECTOR: '.course-title',
  PROGRESS_SELECTOR: '.progress',
  CHAPTER_TITLE_SELECTOR: '.chapter-title', // 没有章节名称时填 ''。
  COURSE_LINK_SELECTOR: 'a.course-link', // 仅指向学习页面的 <a href>；行本身是链接则填 ':scope'。

  // 可选：课程列表位于 iframe 时，填写其 CSS selector；否则留空。
  COURSE_FRAME_SELECTOR: '',
  // 优先读取 video 的 title、aria-label，再使用此标题选择器和 document.title。
  VIDEO_TITLE_SELECTOR: 'h1',
  TIMEOUT_MS: 30000,
  POLL_INTERVAL_MS: 2000,
};
