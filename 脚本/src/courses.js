// 仅从页面展示的文本判定。无法确认的进度保留为 unknown。
export function classifyProgress(raw) {
  const text = String(raw ?? '').trim();
  const percent = text.match(/(-?\d+(?:\.\d+)?)\s*[%％]/u);
  if (percent) {
    const value = Number(percent[1]);
    if (value < 0 || value > 100) return 'unknown';
    return value === 100 ? 'complete' : 'incomplete';
  }
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)(?:\s*(?:节|章|课时))?$/u);
  if (fraction) {
    const [, done, total] = fraction.map(Number);
    if (total <= 0 || done > total) return 'unknown';
    return done === total ? 'complete' : 'incomplete';
  }
  if (/^(?:未完成|未学完|未学习|未开始|学习中|进行中|尚未完成|not\s+(?:completed?|started)|incomplete|in\s+progress)$/iu.test(text)) {
    return 'incomplete';
  }
  if (/^(?:已完成|已学完|学习完成|已学习完毕|完成|completed?)$/iu.test(text)) return 'complete';
  return 'unknown';
}

export function resolveCourseUrl(href, base) {
  if (!href?.trim() || href.trim() === '#') return null;
  try {
    const url = new URL(href, base);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export async function readCourses(page, config) {
  const root = config.COURSE_FRAME_SELECTOR
    ? page.frameLocator(config.COURSE_FRAME_SELECTOR)
    : page;
  const items = root.locator(config.COURSE_ITEM_SELECTOR);
  await items.first().waitFor({ state: 'attached', timeout: config.TIMEOUT_MS });
  const rows = await items.evaluateAll((elements, selectors) => {
    const find = (element, selector) => !selector ? null
      : selector === ':scope' ? element : element.querySelector(selector);
    const text = (element, selector) => find(element, selector)?.textContent?.trim() || '';
    return elements.map((element, index) => {
      const link = find(element, selectors.COURSE_LINK_SELECTOR);
      return {
        position: index + 1,
        title: text(element, selectors.COURSE_TITLE_SELECTOR) || '（课程名称未匹配）',
        chapter: text(element, selectors.CHAPTER_TITLE_SELECTOR) || '（无章节名称或未匹配）',
        progress: text(element, selectors.PROGRESS_SELECTOR),
        href: link?.tagName === 'A' ? link.getAttribute('href') : null,
        base: element.ownerDocument.baseURI,
      };
    });
  }, config);
  return rows.map(({ href, base, ...row }) => ({
    ...row,
    status: classifyProgress(row.progress),
    url: resolveCourseUrl(href, base),
  }));
}

export function printCourses(courses) {
  const candidates = courses.filter(course => course.status !== 'complete');
  console.log(`当前已加载 ${courses.length} 节；已完成 ${courses.length - candidates.length} 节。`);
  console.table(candidates.map((course, index) => ({
    序号: index + 1,
    课程名称: course.title,
    章节名称: course.chapter,
    当前学习进度: course.progress || '未读取到',
    状态: course.status === 'incomplete' ? '未完成' : '进度待确认',
    入口: course.url ? '可打开' : '链接未匹配，请检查配置',
  })));
  return candidates;
}
