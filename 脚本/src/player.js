// 此函数在网页文档内运行。只读取媒体属性并监听事件，不控制播放。
function initializeVideoObserver() {
  const key = Symbol.for('learning-site-helper.video-observer');
  if (window[key]) return;
  const state = { ids: new WeakMap(), nextId: 1, endedEvents: [] };
  state.identify = video => {
    if (!state.ids.has(video)) state.ids.set(video, state.nextId++);
    return state.ids.get(video);
  };
  // capture 监听不冒泡的 ended，保留自动切换视频前发生的结束事件。
  document.addEventListener('ended', event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    state.endedEvents.push({
      id: state.identify(video),
      title: video.title || video.getAttribute('aria-label') || document.title,
      currentTime: video.currentTime,
      duration: video.duration,
      ended: video.ended,
      source: video.currentSrc,
    });
  }, true);
  window[key] = state;
}

export async function prepareVideoObserver(page) {
  await page.addInitScript(initializeVideoObserver);
}

export function formatTime(seconds) {
  if (seconds === Infinity) return '直播/无限时长';
  if (!Number.isFinite(seconds) || seconds < 0) return '未知（元数据未就绪）';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 3600).toString().padStart(2, '0')}:${Math.floor(total / 60 % 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

export function startVideoMonitor(page, config) {
  let stopped = false;
  let timer;
  let active;
  let previouslyFound = false;
  const notified = new WeakMap();

  const poll = async () => {
    if (stopped || page.isClosed()) return;
    let count = 0;
    for (const frame of page.frames()) {
      if (stopped) break;
      try {
        await frame.evaluate(initializeVideoObserver);
        const result = await frame.evaluate(titleSelector => {
          const state = window[Symbol.for('learning-site-helper.video-observer')];
          const title = titleSelector ? document.querySelector(titleSelector)?.textContent?.trim() : '';
          const videos = Array.from(document.querySelectorAll('video'), video => ({
            id: state.identify(video),
            title: video.title || video.getAttribute('aria-label') || title || document.title || '未命名视频',
            currentTime: video.currentTime,
            duration: video.duration,
            ended: video.ended,
            source: video.currentSrc,
          }));
          return { videos, endedEvents: state.endedEvents.splice(0), documentId: performance.timeOrigin };
        }, config.VIDEO_TITLE_SELECTOR);
        count += result.videos.length;
        let seen = notified.get(frame);
        if (!seen) { seen = new Set(); notified.set(frame, seen); }
        const notifyEnd = video => {
          const key = `${result.documentId}|${video.id}|${video.source}`;
          if (!video.ended || seen.has(key)) return;
          seen.add(key);
          console.log(`\n视频：${video.title}`);
          console.log('本节课程播放结束，请确认已经完成学习。');
        };
        for (const video of result.endedEvents) notifyEnd(video);
        for (const video of result.videos) {
          console.log(`[视频 ${video.id}] ${video.title} | 当前 ${formatTime(video.currentTime)} / 总时长 ${formatTime(video.duration)} | 是否播放结束：${video.ended ? '是' : '否'}`);
          notifyEnd(video);
        }
      } catch (error) {
        // 导航/iframe 替换时下一轮重试；无效 CSS 等错误明确报告。
        if (!page.isClosed() && !/detached|destroyed|closed|navigation/i.test(error.message)) {
          console.warn(`视频状态读取失败：${error.message}`);
        }
      }
    }
    if (!count && !previouslyFound && !stopped) {
      console.log('尚未发现 HTML5 video，等待页面加载。若需播放，请在浏览器中手动操作。');
    }
    previouslyFound = true;
    if (!stopped && !page.isClosed()) timer = setTimeout(run, config.POLL_INTERVAL_MS);
  };
  const run = () => { active = poll(); };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
