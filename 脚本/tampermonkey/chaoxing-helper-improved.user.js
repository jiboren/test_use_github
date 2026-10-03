// ==UserScript==
// @name         学习通播放与答题助手（改进版）
// @namespace    local.chaoxing.helper
// @version      3.4.0
// @description  自动播放、倍速、暂停恢复、视频结束后下一节、免题库选择题作答；带停止开关和状态提示。
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/ananas/modules/*
// @match        *://*.chaoxing.com/mooc-ans/*
// @match        *://mooc2-ans.chaoxing.com/*
// @match        *://mooc-ans.chaoxing.com/*
// @match        *://*.chaoxing.com/studyvideoframe/*
// @match        *://*.chaoxing.com/knowledge/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  // 根据参考脚本重写。未登录实际课程验证；页面改版时优先调整本区选择器。
  const SEL = {
    quiz: '.ans-videoquiz, .videoquiz, #videoquiz, .video-quiz, .ans-question, .question-item, .questionItem, .TiMu, .singleQuesId',
    customOption: '[role="radio"], [role="checkbox"], .answerBg li, .Zy_ulTop li, .option-item, .answer-option',
    result: '.ans-videoquiz, .videoquiz, #videoquiz, .video-quiz, [role="dialog"], .layui-layer, .popDiv, .popBottom, .popbox, .confirmDialog, .ui-dialog',
    catalog: '#coursetree li, .posCatalog_select li, .catalog_body li, .catalog_ul li, .catalogue_list li, .chapterList li',
    buttons: 'button, a, [role="button"], input[type="submit"], input[type="button"], .submitBtn, .btnSubmit',
    player: '.xtplayer, .video-js, .xgplayer, .prism-player, .player, [data-player]',
    start: '.vjs-big-play-button, .xgplayer-start, xg-start, .prism-big-play-btn, [class*="bigPlay"], [class*="big-play"], [class*="playButton"], [class*="play-btn"], [class*="playIcon"]',
  };
  const CHANNEL = 'cx-helper-v3';
  const STORAGE = 'cx-helper-v3-config';
  const TOP = window === window.top;
  const DEFAULTS = { running: false, speed: 1, mute: true, resume: true, antiPause: true, next: true, quiz: true };
  let cfg = { ...DEFAULTS };
  let epoch = 0;
  let status = '待开始';
  let panel;
  let ticking = false;
  let quizState = null;
  let lastConfirmation = null;
  const confirmationEvents = new Set();
  let pageKey = '';
  let completedKey = '';
  let lastNextAt = 0;
  let nextPending = null;
  let nextAttemptKey = '';
  let suppressEndUntil = 0;
  const reports = new Map();
  const managed = new Set();
  const speedStates = new WeakMap();
  const playbackStates = new WeakMap();
  const startupStates = new WeakMap();
  const childIds = new WeakMap();
  let childCounter = 0;
  const ownId = 'self';

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function text(el) { return clean(el?.textContent || el?.value); }
  function all(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }
  function visible(el) {
    if (!el || !el.isConnected || el.closest('#__cxV3Panel')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function available(el) { return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }
  function exactButton(root, labels) {
    return all(SEL.buttons, root).find(el => available(el) && labels.includes(text(el)));
  }
  function actionLabel(el) { return text(el).replace(/\s/g, '').replace(/[！!。]+$/, ''); }
  function actionAvailable(el) {
    return available(el) && !el.closest('[disabled], [aria-disabled="true"], .disabled, .is-disabled') && getComputedStyle(el).pointerEvents !== 'none';
  }
  function findAction(root, labels) {
    const candidates = all(SEL.buttons + ', span, div', root).filter(el => labels.includes(actionLabel(el)) && actionAvailable(el));
    // 优先真实按钮。自绘 span/div 只接受精确文本，不匹配整块题干。
    return candidates.find(el => el.matches('button, a, input, [role="button"], [onclick]')) ||
      candidates.find(el => !Array.from(el.children).some(child => labels.includes(actionLabel(child)))) || null;
  }
  function submitScopes(boxes, quizPage) {
    const scopes = [];
    const add = el => { if (el && !scopes.includes(el)) scopes.push(el); };
    boxes.forEach(add);
    // 提交按钮常在题目的兄弟 footer 或外层弹窗中，不能只搜索题目内部。
    for (const box of boxes) {
      let parent = box.parentElement;
      for (let depth = 0; parent && parent !== document.body && parent !== document.documentElement && depth < 7; depth++, parent = parent.parentElement) add(parent);
    }
    if (quizPage) add(document);
    return scopes;
  }
  function findSubmitAction(boxes, quizPage) {
    const scopes = submitScopes(boxes, quizPage);
    const submitLabels = ['提交', '提交答案', '提交作业', '提交测验', '提交本次测验', '交卷', '提交试卷'];
    for (const scope of scopes) { const button = findAction(scope, submitLabels); if (button) return button; }
    for (const scope of scopes.filter(el => el !== document)) {
      const button = findAction(scope, ['确定', '确认', '下一题']);
      if (button) return button;
    }
    // 单独视频 frame 的提交按钮也可能直接位于 body；此时只认唯一明确的提交动作。
    if (boxes.length) {
      const candidates = all(SEL.buttons + ', span, div').filter(el => submitLabels.includes(actionLabel(el)) && actionAvailable(el));
      const leaves = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      if (leaves.length === 1) return leaves[0];
    }
    return null;
  }
  function clickSubmission(button) {
    // 只处理当前 click 同步触发的“提交”确认；不长期覆盖 confirm。
    const original = window.confirm;
    const scoped = message => /提交|交卷/.test(clean(message)) ? true : original.call(window, message);
    try { window.confirm = scoped; button.click(); }
    finally { if (window.confirm === scoped) window.confirm = original; }
  }
  function say(message) {
    if (status !== message) console.info('[学习通助手]', message);
    status = message;
  }
  function sanitize(input) {
    const out = {};
    for (const k of ['running', 'mute', 'resume', 'antiPause', 'next', 'quiz']) {
      if (typeof input?.[k] === 'boolean') out[k] = input[k];
    }
    if ([1, 1.1, 1.25, 1.5, 2].includes(input?.speed)) out.speed = input.speed;
    return out;
  }
  // 单次有界操作。停止、切页或修改配置都会使尚未执行的点击失效。
  function later(fn, ms) {
    const token = epoch;
    setTimeout(() => { if (cfg.running && epoch === token) fn(); }, ms);
  }
  function send(target, payload, origin = '*') {
    try { target.postMessage({ channel: CHANNEL, ...payload }, origin); } catch { /* frame 已卸载 */ }
  }
  function children() { return all('iframe, frame').map(f => f.contentWindow).filter(Boolean); }
  function pushConfig() { children().forEach(w => send(w, { type: 'config', cfg })); }
  function emit(report) {
    if (TOP) reports.set(ownId, { report, at: Date.now() });
    else send(window.parent, { type: 'report', route: ownId, report });
  }
  function persist() {
    if (!TOP) return;
    try { sessionStorage.setItem(STORAGE, JSON.stringify({ ...cfg, course: courseKey() })); } catch { /* 存储不可用 */ }
  }
  function courseKey() {
    const url = new URL(location.href);
    return url.searchParams.get('courseid') || url.searchParams.get('courseId') || location.pathname;
  }
  function configure(patch) {
    const update = sanitize(patch);
    if (Object.keys(update).every(key => cfg[key] === update[key])) return;
    const wasRunning = cfg.running;
    cfg = { ...cfg, ...update };
    epoch++;
    if (quizState?.phase === 'selected' || quizState?.phase === 'waiting-submit') quizState = null;
    if (wasRunning && !cfg.running) {
      for (const v of managed) { try { v.pause(); } catch { /* 已卸载 */ } }
      nextPending = null;
      say('已停止；尚未执行的自动点击已取消');
    }
    if (!wasRunning && cfg.running) {
      // 重新开始允许再次识别上次卡住的题目。
      quizState = null;
      lastConfirmation = null;
      nextAttemptKey = '';
      for (const v of managed) { playbackStates.delete(v); startupStates.delete(playerRoot(v)); }
      say('已开始');
    }
    persist();
    pushConfig();
    render();
  }
  window.addEventListener('message', e => {
    const data = e.data;
    if (!data || data.channel !== CHANNEL || !/^https?:\/\/([\w-]+\.)*chaoxing\.com(?::\d+)?$/.test(e.origin)) return;
    if (!TOP && e.source === window.parent && data.type === 'config') { configure(data.cfg); return; }
    if (data.type === 'confirmed' && ((!TOP && e.source === window.parent) || children().includes(e.source))) {
      relayConfirmation(data.id, e.source);
      return;
    }
    // 只接收直接子 frame 的消息，嵌套 frame 逐层转发。
    if (!children().includes(e.source)) return;
    if (data.type === 'hello') { send(e.source, { type: 'config', cfg }, e.origin); return; }
    if (data.type !== 'report' || !data.report || typeof data.route !== 'string') return;
    if (!childIds.has(e.source)) childIds.set(e.source, String(++childCounter));
    const route = childIds.get(e.source) + '/' + data.route;
    if (TOP) reports.set(route, { report: data.report, at: Date.now() });
    else send(window.parent, { type: 'report', route, report: data.report });
  });
  function relayConfirmation(id, from = null) {
    if (!cfg.running || !cfg.quiz || typeof id !== 'string' || id.length > 100 || confirmationEvents.has(id)) return;
    confirmationEvents.add(id);
    if (confirmationEvents.size > 50) confirmationEvents.delete(confirmationEvents.values().next().value);
    // 答题 iframe 可以从外层页面收到确认结果，恢复超时后的等待状态。
    if (quizState?.submittedAt && !quizState.confirmed && Date.now() - quizState.submittedAt < 120000 &&
        ['submitted', 'blocked'].includes(quizState.phase)) {
      quizState.phase = 'submitted';
      quizState.confirmed = true;
      quizState.at = Date.now();
      say('已完成提交确认，等待结果');
    }
    children().filter(child => child !== from).forEach(child => send(child, { type: 'confirmed', id }));
    if (!TOP && window.parent !== from) send(window.parent, { type: 'confirmed', id });
  }

  // 不改写浏览器原型。仅在运行期间拦截文档失焦/可见性事件。
  for (const name of ['visibilitychange', 'webkitvisibilitychange', 'blur']) {
    window.addEventListener(name, event => {
      if (cfg.running && cfg.antiPause && (event.target === window || event.target === document)) event.stopImmediatePropagation();
    }, true);
  }

  function playerRoot(v) {
    const root = v.closest(SEL.player);
    return (root === v ? v.parentElement : root) || v.parentElement || document.body;
  }
  function localVideos() {
    return all('video').filter(v => visible(v) || (playerRoot(v) !== document.body && visible(playerRoot(v))));
  }
  function findStartControl(root, v = null) {
    const known = all(SEL.start, root).find(actionAvailable);
    if (known) return known;
    const labelled = all('button, [role="button"], [aria-label], [title]', root).find(el => actionAvailable(el) &&
      /^(?:播放|开始播放|播放视频|play|play video|start playback)$/i.test(clean(el.getAttribute('aria-label') || el.getAttribute('title') || text(el))));
    if (labelled) return labelled;
    if (v) {
      // 无文本的中心播放图标只在当前播放器内查找，不扫描全页的普通按钮。
      const rect = v.getBoundingClientRect();
      const hit = rect.width && rect.height ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      const button = hit?.closest('button, [role="button"], [onclick]');
      const label = button ? clean(button.getAttribute('aria-label') || button.getAttribute('title') || text(button)) : '';
      if (root !== document.body && button && button !== v && root.contains(button) && actionAvailable(button) &&
          (!label || /^(?:播放|开始播放|播放视频|play|play video|start playback)$/i.test(label))) return button;
    }
    return null;
  }
  function clickStartup(root, v = null) {
    let state = startupStates.get(root);
    if (!state) { state = { at: 0, attempts: 0, source: '' }; startupStates.set(root, state); }
    const source = v ? v.currentSrc || v.getAttribute('src') || '' : '';
    if (source !== state.source) Object.assign(state, { at: 0, attempts: 0, source });
    const button = findStartControl(root, v);
    if (!button || state.attempts >= 3 || Date.now() - state.at < 3000) return false;
    state.at = Date.now(); state.attempts++;
    button.click();
    all('video', root).forEach(video => managed.add(video));
    return true;
  }
  function startEmptyPlayers(blocked) {
    if (!cfg.running || !cfg.resume || blocked) return;
    const roots = all(SEL.player).filter(root => root.tagName !== 'VIDEO' && visible(root) && !root.querySelector('video'));
    for (const root of roots.filter(root => !roots.some(other => other !== root && root.contains(other)))) {
      if (clickStartup(root)) say('已点击播放器的开始按钮，等待视频加载');
    }
  }
  function playbackState(v) {
    const source = v.currentSrc || v.getAttribute('src') || '';
    let state = playbackStates.get(v);
    if (!state || state.source !== source) {
      state = { source, started: false, pending: false, attempts: 0, lastAttempt: 0, issue: '', message: '', blocked: false };
      playbackStates.set(v, state);
    }
    return state;
  }
  function attemptPlayback(v, state) {
    if (state.pending || state.attempts >= 5 || Date.now() - state.lastAttempt < 3000) return;
    const token = epoch;
    state.pending = true;
    state.lastAttempt = Date.now(); state.attempts++;
    state.message = v.readyState < 2 ? '正在启动视频，等待时长和画面加载' : '正在恢复播放';
    const failure = error => {
      state.pending = false;
      if (playbackStates.get(v) !== state || !cfg.running || token !== epoch) return;
      if (error?.name === 'NotAllowedError') {
        state.attempts = 5;
        state.needsGesture = true;
        state.issue = '浏览器需要一次手动播放：请点视频中央播放按钮';
      } else if (error?.name === 'NotSupportedError') {
        state.issue = '视频源尚未就绪或格式不可用，正在等待播放器加载';
      } else if (error?.name !== 'AbortError') state.issue = '启动视频失败：' + (error?.message || error);
      state.message = state.issue || '加载过程被中断，稍后重试';
    };
    try {
      // play() 本身可以触发资源加载，不能以 readyState >= 2 作为调用前提。
      Promise.resolve(v.play()).then(() => {
        state.pending = false;
        if (!cfg.running || !cfg.resume || state.blocked) { try { v.pause(); } catch { /* 已卸载 */ } return; }
        if (playbackStates.get(v) !== state || token !== epoch) return;
        if (!v.paused) { state.started = true; state.issue = ''; state.attempts = 0; state.message = '视频已开始播放'; }
      }).catch(failure);
    } catch (error) { failure(error); }
  }
  function isFinished(v) { return v.ended === true && Number.isFinite(v.duration) && v.duration > 0; }
  function lessonKey() {
    const active = all(SEL.catalog).find(el => /(?:^|\s)(?:active|current|on|selected)(?:\s|$)/.test(el.className));
    return location.href + '|' + (active ? (active.id || '') + text(active) : '');
  }
  function speedState(v) {
    let state = speedStates.get(v);
    if (state) return state;
    state = { requested: 0, source: '', trialAt: 0, pauses: 0, resets: 0, attempts: 0, blocked: false, issue: '', lastApply: 0, measured: null };
    speedStates.set(v, state);
    v.addEventListener('pause', () => {
      if (!cfg.running || !state.trialAt || state.blocked || state.requested <= 1 || v.ended || Date.now() - state.trialAt > 6000) return;
      if (questionBoxes().length || resultDialog()) return;
      state.pauses++;
      state.lastPause = Date.now();
      if (state.pauses >= 2) fallbackSpeed(v, state, '切换倍速后视频反复暂停');
    });
    return state;
  }
  function fallbackSpeed(v, state, reason) {
    state.blocked = true;
    state.trialAt = 0;
    state.issue = reason + '，已回退 1 倍；此视频暂不再尝试该倍速';
    try { setPlayerRate(v, 1); v.defaultPlaybackRate = 1; v.playbackRate = 1; } catch { /* 页面可能限制设置 */ }
    say(state.issue);
  }
  function setPlayerRate(v, rate) {
    const root = v.closest('.xtplayer, .video-js, .xgplayer, .player, [data-player]') || document;
    const menuOption = all('.speedList [rate], .speedList [data-rate], .vjs-playback-rate .vjs-menu-item, [data-playback-rate]', root).find(el => {
      const value = el.getAttribute('rate') || el.getAttribute('data-rate') || el.getAttribute('data-playback-rate') || text(el).match(/\d+(?:\.\d+)?/)?.[0];
      return Number(value) === rate && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    });
    if (menuOption) { menuOption.click(); return '网站倍速选项'; }
    // 兼容参考脚本中的播放器结构；结构不存在时使用标准媒体属性。
    const xt = v.closest('.xtplayer') || (all('video').length === 1 ? document.querySelector('.xtplayer') : null);
    if (xt?.__vue__?.player?.options?.speed && 'value' in xt.__vue__.player.options.speed) {
      xt.__vue__.player.options.speed.value = rate;
      return '网站播放器设置';
    }
    const holder = v.closest('.video-js');
    if (holder?.id && typeof window.videojs?.getPlayer === 'function') {
      const player = window.videojs.getPlayer(holder.id);
      if (typeof player?.playbackRate === 'function') { player.playbackRate(rate); return '播放器倍速接口'; }
    }
    v.defaultPlaybackRate = rate;
    v.playbackRate = rate;
    return '视频倍速属性';
  }
  function applySpeed(v) {
    const state = speedState(v);
    const now = Date.now();
    const source = v.currentSrc || v.src || '';
    if (state.requested !== cfg.speed || state.source !== source) {
      Object.assign(state, { requested: cfg.speed, source, trialAt: 0, pauses: 0, resets: 0, attempts: 0, blocked: false, issue: '', lastApply: 0, sample: null, measured: null });
    }
    // 没有开始加载/播放时不试倍速，也不累计“网站重置倍速”的失败次数。
    if (v.readyState < 2 || (v.paused && !state.trialAt)) return state;
    if (state.sample && !v.paused && !state.sample.paused && now - state.sample.at >= 2000) {
      const elapsed = (now - state.sample.at) / 1000;
      const progress = v.currentTime - state.sample.time;
      state.measured = progress >= 0 && progress <= elapsed * 4 + 2 ? progress / elapsed : null;
      state.sample = null;
    }
    if (!state.sample || v.paused || state.sample.paused) state.sample = { at: now, time: v.currentTime, paused: v.paused };
    if (state.blocked) return state;
    if (state.trialAt && state.pauses && v.paused && now - state.lastPause > 1200) {
      fallbackSpeed(v, state, '切换倍速后视频持续暂停');
      return state;
    }
    if (Math.abs(v.playbackRate - cfg.speed) < 0.02) {
      if (state.trialAt && now - state.trialAt > 6000 && !v.paused) state.trialAt = 0;
      return state;
    }
    if (now - state.lastApply < 2500) return state;
    if (state.attempts >= 3) { fallbackSpeed(v, state, '页面反复重置倍速或播放器未接受设置'); return state; }
    if (!state.trialAt && cfg.speed > 1) state.trialAt = now;
    state.lastApply = now;
    state.attempts++;
    try { state.method = setPlayerRate(v, cfg.speed); }
    catch (error) { state.issue = '设置倍速失败：' + error.message; }
    return state;
  }
  function ensureVideo(v, blocked) {
    const state = playbackState(v);
    state.blocked = blocked;
    if (!cfg.running || blocked) return;
    managed.add(v);
    try {
      v.muted = cfg.mute;
      if (!v.paused && v.readyState >= 2) { state.started = true; state.issue = ''; state.attempts = 0; }
      if (v.ended) { state.message = '视频已结束'; return; }
      if (v.error) { state.message = '视频加载失败（错误 ' + v.error.code + '），请检查网络或手动重试播放器'; return; }
      if (state.started) applySpeed(v);
      if (v.paused && cfg.resume) {
        if (!state.started && !state.needsGesture && clickStartup(playerRoot(v), v)) state.message = '已点击中央播放按钮，等待视频加载';
        if (v.paused) attemptPlayback(v, state);
      }
      if (!v.paused && v.readyState >= 2) {
        state.started = true;
        state.message = '视频播放中';
      } else if (state.pending && Date.now() - state.lastAttempt > 15000) {
        state.message = '播放器仍在加载；若中央仍有播放按钮，请手动点击一次';
      } else if (state.issue) state.message = state.issue;
      else if (!cfg.resume && v.paused) state.message = '自动播放/恢复已关闭';
      else if (state.attempts >= 5 && !state.pending) state.message = '自动启动已尝试 5 次，请手动点击中央播放按钮或检查网络';
      else if (!state.message) state.message = '等待播放器加载';
      if (state.message) say(state.message);
    } catch (error) { say('播放器暂不可控制：' + error.message); }
  }

  function questionBoxes() {
    // 只在明确的题目容器内定位，避免把导航栏或普通列表当成答案。
    const boxes = all(SEL.quiz).filter(visible);
    return boxes.filter(box => !boxes.some(other => other !== box && box.contains(other)));
  }
  function answerOptions(box) {
    const native = all('input[type="radio"], input[type="checkbox"]', box).filter(el => !el.disabled);
    if (native.length) return native;
    return all(SEL.customOption, box).filter(available);
  }
  function signature(box) {
    const heading = box.querySelector('.Zy_TItle, .mark_name, .question-title, .stem');
    const copy = box.cloneNode(true);
    for (const el of all(SEL.buttons + ', .answer-result, .error-tip, .tips', copy)) el.remove();
    return clean(box.getAttribute('data-questionid') || box.getAttribute('data-id') || box.id) + '|' +
      (heading ? text(heading) : text(copy)) + '|' + answerOptions(box).map(el => el.value || text(el)).join('|');
  }
  function selected(el) {
    return el.checked === true || el.getAttribute('aria-checked') === 'true' ||
      /(?:^|\s)(?:checked|selected|active|check_answer)(?:\s|$)/.test(el.className || '');
  }
  function choose(box) {
    if (all('textarea, input[type="text"], [contenteditable="true"]', box).some(visible)) {
      return { ok: false, reason: '发现填空或简答题，需要手动填写' };
    }
    const options = answerOptions(box);
    if (!options.length) return { ok: false, reason: '未识别到此题的选项，需要适配页面' };
    // 每个原生 name 分组单独选择；自绘选项由题目容器分组。
    const groups = new Map();
    for (const option of options) {
      const key = option.name || '__question';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(option);
    }
    for (const group of groups.values()) {
      const multi = group.some(el => el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') || /多选/.test(text(box));
      const minMatch = text(box).match(/至少(?:选择|选中|选)?\s*([一二两三四五六七八九十\d]+)\s*(?:个|项)/);
      const chinese = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      const min = multi && minMatch ? (chinese[minMatch[1]] || Number(minMatch[1])) : 1;
      if (!Number.isInteger(min) || min > group.length) return { ok: false, reason: '无法满足此题的选择数量要求' };
      let count = group.filter(selected).length;
      for (const option of group) {
        if (count >= min) break;
        if (!selected(option)) { option.click(); count++; }
      }
    }
    return { ok: true };
  }
  function quizSnapshot(boxes) { return boxes.map(signature).join('\n'); }
  function completionEvidence(root) {
    // “得分”标题本身不是提交成功证据。
    const raw = String(root?.innerText || root?.textContent || '');
    return raw.split(/\n/).some(line => /^(?:(?:作业|测验)?提交成功[！!。]?|作业已提交|测验已提交|已完成本次(?:测验|测试)|本次成绩\s*[:：]\s*\d+(?:\.\d+)?\s*分?)$/.test(clean(line)));
  }
  function gradedResultEvidence(boxes) {
    // 结果页可能没有“提交成功/本次成绩”，只有“我的答案”及逐题的 0.0/25.0 分。
    // 必须在同一个结果条内找到答案与实得分，并排除仍可作答/提交的页面。
    const editableSelector = 'input[type="radio"], input[type="checkbox"], textarea, input[type="text"], select, [role="radio"], [role="checkbox"], [contenteditable="true"]';
    const scopes = boxes.length ? boxes : [document.body];
    if (scopes.some(root => all(editableSelector, root).some(el => !el.closest('#__cxV3Panel') &&
      !el.disabled && !el.readOnly && el.getAttribute('aria-disabled') !== 'true' &&
      (visible(el) || (/^(radio|checkbox)$/.test(el.type || '') && visible(el.closest('label') || el.parentElement)))))) return 0;
    if (findAction(document, ['提交', '提交答案', '提交作业', '提交测验', '提交本次测验', '交卷', '提交试卷'])) return 0;
    const isAnswer = el => /^(?:我的答案|您的答案|学生答案)\s*[:：]/.test(text(el));
    const labels = all('strong, b, span, p, div, td, section').filter(el => visible(el) && isAnswer(el));
    const leaves = labels.filter(el => !labels.some(other => other !== el && el.contains(other)));
    const rows = new Set();
    for (const label of leaves) {
      for (let row = label, depth = 0; row && row !== document.body && row !== document.documentElement && depth < 5; row = row.parentElement, depth++) {
        const value = text(row);
        if (value.length > 400 || !isAnswer(row) || (value.match(/(?:我的答案|您的答案|学生答案)\s*[:：]/g) || []).length !== 1) continue;
        const earned = value.replace(/(?:满分|总分|每题|本题|本小题|每小题|共)\s*[:：]?\s*\d+(?:\.\d+)?\s*分?/g, '');
        if (/\d+(?:\.\d+)?\s*分(?:$|[\s，。；、✓✔×✗])/u.test(earned)) { rows.add(row); break; }
      }
    }
    // 一部分题目已出分、另一部分仍在显示时，不把整页视为完成。
    return boxes.length && rows.size < boxes.length ? 0 : rows.size;
  }
  function resultDialog() {
    return all(SEL.result).filter(visible).find(el => /回答正确|回答错误|答对了|答错了|提交成功/.test(text(el)));
  }
  function findSubmissionConfirm() {
    const promptText = el => text(el).replace(/\s/g, '');
    const isPrompt = el => promptText(el).length <= 180 &&
      /是否.{0,12}(?:提交|交卷)|(?:确定|确认)(?:要)?(?:提交|交卷)|(?:提交|交卷)[吗么？?]|(?:提交|交卷)后.{0,12}(?:修改|撤回)/.test(promptText(el));
    const seeds = all('p, span, div, h2, h3, h4, td, section').filter(el => visible(el) && isPrompt(el) &&
      !el.closest(SEL.buttons) && !el.closest('.question-item, .questionItem, .TiMu, .singleQuesId, .question-title, .answerBg, .Zy_ulTop'));
    const leaves = seeds.filter(el => !seeds.some(other => other !== el && el.contains(other)));
    const candidates = [];
    const affirmative = ['确定', '确认', '确定提交', '确认提交', '提交', '交卷', '确定交卷'];
    for (const seed of leaves) {
      for (let root = seed, depth = 0; root && root !== document.body && root !== document.documentElement && depth < 8; root = root.parentElement, depth++) {
        if (text(root).length > 1500 || !visible(root)) continue;
        const button = findAction(root, affirmative);
        if (!button) continue;
        const knownDialog = root.matches(SEL.result) || root.getAttribute('aria-modal') === 'true';
        const cancel = findAction(root, ['取消', '返回', '否', '不提交']);
        // 未知样式名：用“确认提交？”正文、取消和提交按钮，以及浮层位置联合识别。
        let floating = false;
        for (let el = root; el && el !== document.body; el = el.parentElement) {
          if (['fixed', 'absolute'].includes(getComputedStyle(el).position)) { floating = true; break; }
        }
        if (knownDialog || (cancel && floating)) { candidates.push({ root, button }); break; }
      }
    }
    // 只在包含确认正文的最小弹窗里点击，避免点到背景页面的“提交”。
    const inner = candidates.filter(candidate => !candidates.some(other => other.root !== candidate.root && candidate.root.contains(other.root)));
    if (inner.length) return inner[0];
    return null;
  }
  function handleSubmissionConfirmation() {
    if (lastConfirmation && (!lastConfirmation.root.isConnected || !visible(lastConfirmation.root))) lastConfirmation = null;
    const found = findSubmissionConfirm();
    if (!found && !lastConfirmation) return false;
    if (!cfg.running || !cfg.quiz) { say('检测到确认提交弹窗，等待手动确认'); return true; }
    if (lastConfirmation && (!found || (lastConfirmation.root === found.root && lastConfirmation.button === found.button))) {
      if (Date.now() - lastConfirmation.at > 15000) say('已点击确认提交，但弹窗仍未关闭；请检查页面提示');
      return true;
    }
    if (!found) return false;
    lastConfirmation = { ...found, at: Date.now() };
    try {
      clickSubmission(found.button);
      relayConfirmation(Date.now() + '-' + Math.random().toString(36).slice(2));
      say('已点击“确认提交”弹窗中的提交按钮，等待结果');
    } catch (error) { say('确认提交按钮执行失败：' + error.message); }
    return true;
  }
  function progressSubmission(state, boxes, quizPage) {
    if (!cfg.running || !cfg.quiz) return;
    if (state.phase === 'waiting-submit') {
      if (Date.now() < state.submitAfter) return;
      const button = findSubmitAction(boxes, quizPage);
      if (!button) {
        if (Date.now() > state.deadline) { state.phase = 'blocked'; say('等待 15 秒仍未找到可用提交按钮；请发提交区域截图或诊断'); }
        else say('答案已选，等待提交按钮出现或启用…');
        return;
      }
      state.phase = 'submitted';
      state.at = Date.now();
      state.submittedAt = state.at;
      try { clickSubmission(button); say('已点击“' + actionLabel(button) + '”，等待结果或确认'); }
      catch (error) { state.phase = 'blocked'; say('提交按钮执行失败：' + error.message); }
      return;
    }
    if (state.phase !== 'submitted') return;
    if (Date.now() - state.at > 15000) {
      state.phase = 'blocked';
      say('已点提交但 15 秒内未确认结果；可能有未填题目或页面校验，请检查提示');
    }
  }
  function handleQuiz() {
    completedKey = '';
    // 无论是否在本 frame 作答、是否已经等待超时，优先处理可见的提交确认。
    if (handleSubmissionConfirmation()) return true;
    const boxes = questionBoxes();
    const gradedCount = gradedResultEvidence(boxes);
    if (gradedCount) {
      completedKey = pageKey;
      quizState = { phase: 'complete', gradedCount };
      say('测验已出分（识别到 ' + gradedCount + ' 道题的结果）' + (cfg.next ? '，准备下一节' : '；自动下一节已关闭'));
      return false;
    }
    const dialog = resultDialog();
    const bodyText = clean(document.body?.innerText);
    const quizPage = /章节测验|章节测试|章节作业|随堂练习|学习检测/.test(bodyText) &&
      /单选题|多选题|判断题|填空题|简答题|提交答案|提交作业|本次成绩|提交成功|作业已提交|测验已提交/.test(bodyText);
    if (quizPage && completionEvidence(document.body)) {
      completedKey = pageKey;
      quizState = { phase: 'complete' };
      say('检测到测验提交成功');
      return false;
    }
    if (!boxes.length && !dialog && !quizPage) { quizState = null; return false; }
    if (!cfg.quiz) { say('检测到题目；自动答题关闭，等待手动作答'); return true; }
    if (dialog) {
      const close = findAction(dialog, ['继续学习', '继续观看', '继续', '关闭', '我知道了', '知道了']);
      if (close) {
        if (!quizState) quizState = { phase: 'result', at: Date.now() };
        if (!quizState.closed) { quizState.closed = true; close.click(); say('已处理答题结果，等待页面更新'); }
      } else say('已显示答题结果，请手动处理未识别的继续按钮');
      return true;
    }
    if (!boxes.length) {
      if (quizState?.phase === 'submitted') progressSubmission(quizState, boxes, quizPage);
      else say('识别到测验页，但题目结构未知；等待手动处理');
      return true;
    }
    const snapshot = quizSnapshot(boxes);
    if (quizState && quizState.snapshot !== snapshot && quizState.phase !== 'selecting') quizState = null;
    if (!quizState) {
      quizState = { phase: 'selecting', snapshot, at: Date.now() };
      for (const box of boxes) {
        const result = choose(box);
        if (!result.ok) { quizState.phase = 'blocked'; say(result.reason); return true; }
      }
      quizState.snapshot = quizSnapshot(boxes);
      quizState.phase = 'waiting-submit';
      quizState.submitAfter = Date.now() + 800;
      quizState.deadline = Date.now() + 15000;
      say('已选择 ' + boxes.length + ' 道题的选项，准备提交');
    } else progressSubmission(quizState, boxes, quizPage);
    return true;
  }

  function navigateNext() {
    if (!cfg.running || !cfg.next || Date.now() - lastNextAt < 10000) return;
    const key = advanceKey();
    if (nextAttemptKey === key) return;
    const pendingDialog = all(SEL.result).filter(visible).find(el => /任务点未完成|是否去完成/.test(text(el)));
    if (pendingDialog) { say('网站提示任务点未完成，请检查课程记录'); nextPending = null; return; }
    // 仅点击明确的“下一节/任务点”，不把普通“下一页/继续”当成换课。
    let button = findAction(document, ['下一节', '下一章', '下一个任务点', '下一任务点']);
    if (!button) {
      const items = all(SEL.catalog).filter(visible);
      const index = items.findIndex(el => /(?:^|\s)(?:active|current|on|selected)(?:\s|$)/.test(el.className));
      if (index >= 0 && index + 1 < items.length) button = items[index + 1].querySelector('a, [role="button"]');
    }
    if (!button || !actionAvailable(button)) {
      say('未找到可用的下一节入口；可能已到最后一节或需要适配目录');
      nextPending = null;
      return;
    }
    nextAttemptKey = key;
    lastNextAt = Date.now();
    suppressEndUntil = Date.now() + 12000;
    reports.clear();
    nextPending = null;
    button.click();
    say('已点击下一节，等待新课程加载');
  }
  function readyToAdvance(items) {
    if (!items.length || items.some(r => r.blocked)) return false;
    const videos = items.flatMap(r => r.videos || []);
    return videos.length > 0 ? videos.every(v => v.ended === true) : items.some(r => r.completed === true);
  }
  function advanceKey() {
    const current = [...reports.values()].filter(v => Date.now() - v.at < 4500).map(v => v.report);
    return lessonKey() + '|' + current.flatMap(r => (r.videos || []).map(v => v.source || '')).sort().join('|');
  }
  function coordinate() {
    if (!TOP) return;
    const now = Date.now();
    for (const [key, value] of reports) if (now - value.at > 4500) reports.delete(key);
    if (!cfg.running || !cfg.next || now < suppressEndUntil) { nextPending = null; return; }
    const current = [...reports.values()].map(v => v.report);
    if (!readyToAdvance(current)) { nextPending = null; return; }
    const key = advanceKey();
    if (!nextPending || nextPending.key !== key) nextPending = { key, at: now };
    const remaining = Math.ceil((5000 - (now - nextPending.at)) / 1000);
    if (remaining <= 0) navigateNext();
    else say((current.some(r => r.completed) ? '测验已完成' : '视频已结束') + '，' + remaining + ' 秒后进入下一节');
  }
  function tick() {
    if (ticking || !document.body) return;
    ticking = true;
    try {
      const key = lessonKey();
      if (key !== pageKey) { pageKey = key; quizState = null; lastConfirmation = null; completedKey = ''; epoch++; }
      for (const v of managed) if (!v.isConnected) managed.delete(v);
      let blocked = false;
      if (cfg.running) {
        if (/无法记录任务|无法记录.{0,6}时间|任务点时间.{0,8}异常/.test(document.body.innerText || '')) {
          blocked = true;
          say('网站提示记录异常；请检查任务点，必要时选择 1 倍速');
        } else blocked = handleQuiz();
      }
      startEmptyPlayers(blocked);
      const videos = localVideos();
      for (const v of videos) ensureVideo(v, blocked);
      emit({ blocked, completed: completedKey === pageKey, status,
        quiz: quizDiagnostic(),
        videos: videos.map(v => ({ ended: isFinished(v), source: v.currentSrc || v.src || '', time: Math.floor(v.currentTime), duration: Math.floor(v.duration || 0), rate: v.playbackRate,
          requested: cfg.speed, paused: v.paused, readyState: v.readyState, playMessage: playbackStates.get(v)?.message || '',
          measured: speedStates.get(v)?.measured, speedIssue: speedStates.get(v)?.issue || '' })) });
      coordinate();
      render();
    } catch (error) { say('处理异常：' + error.message); emit({ blocked: true, status, videos: [] }); }
    finally { ticking = false; }
  }
  function render() {
    if (!panel) return;
    const find = id => panel.querySelector('#' + id);
    find('cx-toggle').textContent = cfg.running ? '停止' : '开始';
    find('cx-rate').value = String(cfg.speed);
    for (const key of ['mute', 'resume', 'antiPause', 'next', 'quiz']) find('cx-' + key).checked = cfg[key];
    const recent = [...reports.values()].filter(v => Date.now() - v.at < 4500).map(v => v.report);
    const video = recent.flatMap(r => r.videos || [])[0];
    const issue = recent.find(r => r.blocked);
    find('cx-status').textContent = cfg.running ? (issue?.status || (!video?.ended && video?.playMessage) || status) : '已停止';
    find('cx-video').textContent = video ? `目标 ${cfg.speed} 倍 / 实际 ${video.rate} 倍 · ${video.paused ? '暂停' : '播放中'} · ` + (video.duration > 0 ? `${video.time}/${video.duration} 秒` : '时长待加载') : '尚未检测到可见视频';
    find('cx-speed-status').textContent = video?.speedIssue || '';
  }
  function mount() {
    if (!TOP || document.getElementById('__cxV3Panel')) return;
    panel = document.createElement('section');
    panel.id = '__cxV3Panel';
    panel.style.cssText = 'position:fixed;right:16px;top:90px;z-index:2147483647;width:260px;padding:14px;background:white;color:#162336;border:1px solid #afbdd1;border-radius:12px;box-shadow:0 4px 22px #0002;font:14px/1.7 system-ui';
    panel.innerHTML = `<strong>学习通助手 · 3.4</strong>
      <div style="margin:8px 0"><button id="cx-toggle" type="button">开始</button>
      <select id="cx-rate" aria-label="倍速"><option value="1">1 倍</option><option value="1.1">1.1 倍</option><option value="1.25">1.25 倍</option><option value="1.5">1.5 倍</option><option value="2">2 倍</option></select></div>
      <label><input id="cx-mute" type="checkbox">静音</label>
      <label><input id="cx-resume" type="checkbox">自动播放/恢复</label><br>
      <label><input id="cx-antiPause" type="checkbox">防切屏暂停</label><br>
      <label><input id="cx-next" type="checkbox">自动下一节</label>
      <label><input id="cx-quiz" type="checkbox">自动答题</label>
      <div id="cx-video" style="color:#526478;margin-top:8px"></div>
      <div id="cx-speed-status" style="color:#a85212;overflow-wrap:anywhere"></div>
      <div id="cx-status" role="status" style="overflow-wrap:anywhere"></div>
      <div style="font-size:12px;color:#65758a;margin-top:8px">首次请点击开始；不会自动跳过未识别题目。倍速是否计入进度需实测。</div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('#cx-toggle').onclick = () => configure({ running: !cfg.running });
    panel.querySelector('#cx-rate').onchange = e => configure({ speed: Number(e.target.value) });
    for (const key of ['mute', 'resume', 'antiPause', 'next', 'quiz']) panel.querySelector('#cx-' + key).onchange = e => configure({ [key]: e.target.checked });
    render();
  }
  if (TOP) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE) || 'null');
      if (saved?.course === courseKey()) cfg = { ...cfg, ...sanitize(saved) };
    } catch { /* 使用默认配置 */ }
  } else send(window.parent, { type: 'hello' });
  document.addEventListener('load', e => { if (e.target?.tagName === 'IFRAME') pushConfig(); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  setInterval(tick, 1000);
  // 新载入/晚注入的 frame 主动索取配置，避免子页面擅自开始。
  if (!TOP) setInterval(() => send(window.parent, { type: 'hello' }), 5000);
  function quizDiagnostic() {
    return { count: questionBoxes().length, phase: quizState?.phase || 'idle', gradedCount: quizState?.gradedCount || 0,
      completed: completedKey === pageKey, nextAvailable: !!findAction(document, ['下一节', '下一章', '下一个任务点', '下一任务点']),
      actions: all(SEL.buttons + ', span, div').filter(el => visible(el) && /^(?:提交|提交答案|提交作业|交卷|确定|确认|确定提交|确认提交)$/.test(actionLabel(el)))
        .filter(el => !Array.from(el.children).some(child => actionLabel(child) === actionLabel(el)))
        .slice(0, 10).map(el => ({ tag: el.tagName, id: el.id, class: String(el.className), text: actionLabel(el), enabled: actionAvailable(el) })) };
  }
  window.CXHelperV3 = {
    start: () => configure({ running: true }), stop: () => configure({ running: false }),
    diagnostic: () => ({ version: '3.4.0', top: TOP, path: location.pathname, cfg: { ...cfg }, status,
      videos: localVideos().map(v => ({ rate: v.playbackRate, paused: v.paused, readyState: v.readyState, playMessage: playbackStates.get(v)?.message || '',
        playAttempts: playbackStates.get(v)?.attempts || 0, speedIssue: speedStates.get(v)?.issue || '' })), quiz: quizDiagnostic(),
      children: [...reports.values()].filter(item => Date.now() - item.at < 4500).map(({ report }) => ({ status: report.status, quiz: report.quiz,
        videos: (report.videos || []).map(({ rate, requested, paused, readyState, playMessage, speedIssue }) => ({ rate, requested, paused, readyState, playMessage, speedIssue })) })),
      frames: all('iframe').map(f => { try { return new URL(f.src, location.href).origin; } catch { return 'unknown'; } }) }),
  };
})();
