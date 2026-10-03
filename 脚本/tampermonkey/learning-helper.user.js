// ==UserScript==
// @name         学习网站辅助工具（手动学习）
// @namespace    learning-site-helper
// @version      1.0.0
// @description  读取课程和视频状态，手动选择课程，不代学、不提交
// @match        https://example.invalid/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // 将上面的 @match 改成实际学习网站域名，例如 https://learn.example.com/*。
  // 此配置独立于 Node.js 版本的 config.js；直接在篡改猴编辑器里修改。
  const CONFIG = {
    LOGIN_URL: '',
    COURSE_URL: '',
    COURSE_ITEM_SELECTOR: '.course-item',
    COURSE_TITLE_SELECTOR: '.course-title',
    PROGRESS_SELECTOR: '.progress',
    CHAPTER_TITLE_SELECTOR: '.chapter-title',
    COURSE_LINK_SELECTOR: 'a.course-link',
    COURSE_FRAME_SELECTOR: '', // 仅支持同源 iframe，普通页面留空。
    VIDEO_TITLE_SELECTOR: 'h1',
    POLL_INTERVAL_MS: 2000,
  };

  if (document.getElementById('learning-helper-panel')) return;

  const host = document.createElement('div');
  host.id = 'learning-helper-panel';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:calc(100vw - 32px);';
  const shadow = host.attachShadow({ mode: 'open' });
  // 只有固定界面使用 innerHTML；网站标题、链接、状态均通过 textContent/value 写入。
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      section { width:380px;max-width:calc(100vw - 32px);background:#fff;color:#172033;
        border:1px solid #b9c6d8;border-radius:12px;box-shadow:0 6px 28px #0003;
        font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif; }
      header { display:flex;align-items:center;justify-content:space-between;padding:10px 14px; }
      #body { padding:0 14px 14px;max-height:65vh;overflow:auto; }
      p { margin:6px 0; }
      button,select { font:inherit; }
      button { cursor:pointer;border:1px solid #9aabc3;border-radius:6px;padding:4px 9px;background:#f3f6fb;color:#172033; }
      button:hover { background:#e6edf8; }
      button:disabled { cursor:default;opacity:.5; }
      .actions { display:flex;flex-wrap:wrap;gap:6px;margin:8px 0; }
      select { width:100%;padding:5px; }
      pre { white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#f3f6fb;padding:8px;border-radius:6px; }
      #ended { color:#166534;background:#f0fdf4;white-space:pre-wrap; }
      #status { color:#475569;overflow-wrap:anywhere; }
      [hidden] { display:none !important; }
    </style>
    <section aria-label="学习辅助工具">
      <header><strong>学习辅助工具</strong><button id="toggle" type="button" aria-expanded="true">收起</button></header>
      <div id="body">
        <p>请手动登录和播放。进度仅供查看。</p>
        <div class="actions">
          <button id="login" type="button">打开登录页</button>
          <button id="list" type="button">打开课程列表</button>
          <button id="scan" type="button">读取课程</button>
        </div>
        <p id="status" role="status">在课程列表加载完成后点击“读取课程”。</p>
        <label for="courses">未完成 / 进度待确认的课程</label>
        <select id="courses"><option value="">请先读取课程</option></select>
        <pre id="detail">尚未选择课程</pre>
        <button id="open" type="button" disabled>打开所选课程</button>
        <p><strong>视频状态</strong></p>
        <pre id="videos">等待 HTML5 video…</pre>
        <p id="ended" role="status" hidden></p>
      </div>
    </section>`;
  document.documentElement.append(host);
  const ui = id => shadow.getElementById(id);
  let candidates = [];

  function classifyProgress(raw) {
    const text = String(raw ?? '').trim();
    const percent = text.match(/(-?\d+(?:\.\d+)?)\s*[%％]/u);
    if (percent) {
      const value = Number(percent[1]);
      return value < 0 || value > 100 ? 'unknown' : value === 100 ? 'complete' : 'incomplete';
    }
    const fraction = text.match(/^(\d+)\s*\/\s*(\d+)(?:\s*(?:节|章|课时))?$/u);
    if (fraction) {
      const done = Number(fraction[1]);
      const total = Number(fraction[2]);
      return total <= 0 || done > total ? 'unknown' : done === total ? 'complete' : 'incomplete';
    }
    if (/^(?:未完成|未学完|未学习|未开始|学习中|进行中|尚未完成|not\s+(?:completed?|started)|incomplete|in\s+progress)$/iu.test(text)) return 'incomplete';
    if (/^(?:已完成|已学完|学习完成|已学习完毕|完成|completed?)$/iu.test(text)) return 'complete';
    return 'unknown';
  }

  function resolveUrl(raw, base = document.baseURI) {
    if (!raw?.trim() || raw.trim() === '#') return null;
    try {
      const url = new URL(raw, base);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function navigate(raw) {
    const url = resolveUrl(raw);
    if (!url) { ui('status').textContent = '请先填写有效的 HTTP(S) 页面地址或课程链接。'; return; }
    // 仅在用户点击工具按钮后导航，不点击网页上的任何操作按钮。
    window.location.assign(url);
  }

  function selectedCourse() {
    const value = ui('courses').value;
    return value === '' ? null : candidates[Number(value)];
  }

  function showSelection() {
    const item = selectedCourse();
    ui('open').disabled = !item?.url;
    ui('detail').textContent = item
      ? `课程：${item.title}\n章节：${item.chapter}\n进度：${item.progress || '未读取到'}\n状态：${item.status === 'incomplete' ? '未完成' : '进度待确认'}${item.url ? '' : '\n链接未匹配，请检查 COURSE_LINK_SELECTOR。'}`
      : '尚未选择课程';
  }

  function scanCourses() {
    candidates = [];
    ui('courses').replaceChildren();
    showSelection();
    try {
      let root = document;
      if (CONFIG.COURSE_FRAME_SELECTOR) {
        root = document.querySelector(CONFIG.COURSE_FRAME_SELECTOR)?.contentDocument;
        if (!root) throw new Error('课程 iframe 未加载、未匹配或不同源；无法读取。');
      }
      const find = (element, selector) => !selector ? null : selector === ':scope' ? element : element.querySelector(selector);
      const read = (element, selector) => find(element, selector)?.textContent?.trim() || '';
      const rows = Array.from(root.querySelectorAll(CONFIG.COURSE_ITEM_SELECTOR), element => {
        const progress = read(element, CONFIG.PROGRESS_SELECTOR);
        const link = find(element, CONFIG.COURSE_LINK_SELECTOR);
        return {
          title: read(element, CONFIG.COURSE_TITLE_SELECTOR) || '（课程名称未匹配）',
          chapter: read(element, CONFIG.CHAPTER_TITLE_SELECTOR) || '（无章节名称或未匹配）',
          progress,
          status: classifyProgress(progress),
          url: link?.tagName === 'A' ? resolveUrl(link.getAttribute('href'), element.ownerDocument.baseURI) : null,
        };
      });
      candidates = rows.filter(row => row.status !== 'complete');
      candidates.forEach((row, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `${index + 1}. ${row.title} / ${row.chapter} / ${row.progress || '进度待确认'}`;
        ui('courses').append(option);
      });
      if (!candidates.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = rows.length ? '当前已加载条目均显示已完成' : '未匹配到课程';
        ui('courses').append(option);
      }
      const incomplete = candidates.filter(row => row.status === 'incomplete').length;
      ui('status').textContent = rows.length
        ? `已读取 ${rows.length} 节：未完成 ${incomplete}，进度待确认 ${candidates.length - incomplete}，已完成 ${rows.length - candidates.length}。`
        : '未匹配到课程。请检查选择器，或手动展开目录、翻页后重新读取。';
      console.table(candidates.map((row, index) => ({
        序号: index + 1, 课程名称: row.title, 章节名称: row.chapter,
        当前学习进度: row.progress || '未读取到', 状态: row.status === 'incomplete' ? '未完成' : '进度待确认',
      })));
      showSelection();
    } catch (error) {
      ui('status').textContent = `读取失败：${error.message}`;
    }
  }

  ui('login').addEventListener('click', () => navigate(CONFIG.LOGIN_URL));
  ui('list').addEventListener('click', () => navigate(CONFIG.COURSE_URL));
  ui('scan').addEventListener('click', scanCourses);
  ui('courses').addEventListener('change', showSelection);
  ui('open').addEventListener('click', () => { const item = selectedCourse(); if (item?.url) navigate(item.url); });
  ui('toggle').addEventListener('click', () => {
    ui('body').hidden = !ui('body').hidden;
    ui('toggle').textContent = ui('body').hidden ? '展开' : '收起';
    ui('toggle').setAttribute('aria-expanded', String(!ui('body').hidden));
  });

  const videoIds = new WeakMap();
  const endedSources = new WeakMap();
  const observedDocuments = new WeakSet();
  let nextVideoId = 1;
  function titleFor(video) {
    const doc = video.ownerDocument;
    let heading = '';
    try { heading = CONFIG.VIDEO_TITLE_SELECTOR ? doc.querySelector(CONFIG.VIDEO_TITLE_SELECTOR)?.textContent?.trim() : ''; }
    catch { heading = '（VIDEO_TITLE_SELECTOR 无效）'; }
    return video.title || video.getAttribute('aria-label') || heading || doc.title || '未命名视频';
  }

  function notifyEnded(video) {
    let sources = endedSources.get(video);
    if (!sources) { sources = new Set(); endedSources.set(video, sources); }
    if (sources.has(video.currentSrc)) return;
    sources.add(video.currentSrc);
    ui('ended').hidden = false;
    ui('ended').textContent = `视频：${titleFor(video)}\n本节课程播放结束，请确认已经完成学习。`;
    console.log(`[学习辅助] ${titleFor(video)}：本节课程播放结束，请确认已经完成学习。`);
  }

  function formatTime(seconds) {
    if (seconds === Infinity) return '直播/无限时长';
    if (!Number.isFinite(seconds) || seconds < 0) return '未知（元数据未就绪）';
    const total = Math.floor(seconds);
    return [Math.floor(total / 3600), Math.floor(total / 60 % 60), total % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  }

  function updateVideos() {
    const lines = [];
    let inaccessibleFrames = 0;
    const visited = new Set();
    function visit(doc) {
      if (visited.has(doc)) return;
      visited.add(doc);
      if (!observedDocuments.has(doc)) {
        // ended 不冒泡，使用捕获监听。只读取媒体状态，不触发播放行为。
        doc.addEventListener('ended', event => {
          if (event.isTrusted && event.target?.tagName === 'VIDEO') notifyEnded(event.target);
        }, true);
        observedDocuments.add(doc);
      }
      for (const video of doc.querySelectorAll('video')) {
        if (!videoIds.has(video)) videoIds.set(video, nextVideoId++);
        lines.push(`[视频 ${videoIds.get(video)}] ${titleFor(video)}\n当前 ${formatTime(video.currentTime)} / 总时长 ${formatTime(video.duration)}\n是否播放结束：${video.ended ? '是' : '否'}`);
        if (video.ended) notifyEnded(video);
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        let child;
        try { child = frame.contentDocument; } catch { /* 遵守同源限制。 */ }
        if (child) visit(child);
        else inaccessibleFrames++;
      }
    }
    visit(document);
    if (!lines.length) lines.push('尚未发现 HTML5 video。请手动打开课程并开始播放。');
    if (inaccessibleFrames) lines.push(`有 ${inaccessibleFrames} 个 iframe 不同源或尚未加载，无法读取其中的视频。`);
    ui('videos').textContent = lines.join('\n\n');
  }

  updateVideos();
  setInterval(updateVideos, Math.max(500, Number(CONFIG.POLL_INTERVAL_MS) || 2000));
})();
