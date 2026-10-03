import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const source = fs.readFileSync(new URL('../tampermonkey/chaoxing-helper-improved.user.js', import.meta.url), 'utf8');
const marker = '  if (TOP) {\n    try {\n      const saved';
assert.ok(source.includes(marker));
const instrumented = source.replace(marker, `  window.__subject = {
  tick, configure, ensureVideo, applySpeed, speedState, clickSubmission,
  getState: () => ({ phase: quizState?.phase, status, cfg: { ...cfg }, completed: completedKey === pageKey,
    remoteCompleted: [...reports.values()].some(item => item.report.completed) })
}; return;\n${marker}`);
let browser;
before(async () => { browser = await playwright.chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

const question = `<div class="question-item" data-questionid="one"><h3 class="question-title">选一个答案</h3>
  <label><input type="radio" name="q1" value="A">甲</label><label><input type="radio" name="q1" value="B">乙</label></div>`;
async function fixture(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate(() => { window.__now = 100000; Date.now = () => window.__now; window.clickCount = 0; });
  await page.addScriptTag({ content: instrumented });
  await page.evaluate(() => __subject.configure({ running: true, next: false }));
  return page;
}
async function tick(page, advance = 1000) {
  await page.evaluate(ms => { __now += ms; __subject.tick(); }, advance);
}

test('Edge：视频弹题的兄弟 footer 自绘提交按钮可点击，且不会反复提交', async t => {
  const page = await fixture(`<div class="ans-videoquiz">${question}<footer><span id="submit">提 交</span></footer></div>`);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#submit').onclick = () => clickCount++; });
  await tick(page);
  assert.equal(await page.locator('input[value="A"]').isChecked(), true);
  await tick(page);
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
  assert.equal(await page.evaluate(() => __subject.getState().phase), 'submitted');
});

test('Edge：提交按钮迟到或暂时禁用，会等待启用后再提交', async t => {
  const page = await fixture(`<div class="ans-videoquiz">${question}<footer id="footer"></footer></div>`);
  t.after(() => page.close());
  await tick(page);
  await tick(page);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'submit'; button.textContent = '提交答案'; button.disabled = true;
    button.onclick = () => clickCount++; document.querySelector('#footer').append(button);
  });
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
  await page.locator('#submit').evaluate(el => { el.disabled = false; });
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
});

test('Edge：题目被确认弹窗替换，仍能继续确认提交', async t => {
  const page = await fixture(`<div class="ans-videoquiz">${question}<span id="submit">提交</span></div>`);
  t.after(() => page.close());
  await page.evaluate(() => {
    document.querySelector('#submit').onclick = () => {
      clickCount++;
      document.body.innerHTML = '<div role="dialog">是否提交本次作业？<span id="confirm">确 定</span></div>';
      document.querySelector('#confirm').onclick = () => { clickCount++; document.body.innerHTML = '提交成功'; };
    };
  });
  await tick(page);
  await tick(page);
  await tick(page);
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 2);
  assert.equal(await page.locator('body').innerText(), '提交成功');
});

test('Edge：章节测验的页面底部 input 提交按钮可点击', async t => {
  const page = await fixture(`<h1>章节测验 单选题</h1>${question}<input type="button" id="submit" value="提交作业">`);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#submit').onclick = () => clickCount++; });
  await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
});

test('Edge：停止后，不点击后来才出现的提交按钮', async t => {
  const page = await fixture(`<div class="ans-videoquiz">${question}<button id="submit" disabled>提交</button></div>`);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#submit').onclick = () => clickCount++; });
  await tick(page);
  await page.evaluate(() => { __subject.configure({ running: false }); document.querySelector('#submit').disabled = false; });
  await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
});

test('Edge：同步提交确认只在本次点击内接管，其他确认保留', async t => {
  const page = await fixture(`<button id="submit">提交</button>`);
  t.after(() => page.close());
  const result = await page.evaluate(() => {
    let nativeCalls = 0;
    const original = () => { nativeCalls++; return false; };
    window.confirm = original;
    const button = document.querySelector('#submit');
    let submitted, unrelated;
    button.onclick = () => { submitted = confirm('是否提交作业？'); unrelated = confirm('删除其他内容？'); };
    __subject.clickSubmission(button);
    return { submitted, unrelated, nativeCalls, restored: window.confirm === original };
  });
  assert.deepEqual(result, { submitted: true, unrelated: false, nativeCalls: 1, restored: true });
});

async function mockVideo(page, pauseOnRate = false, resetRate = false) {
  await page.evaluate(({ pauseOnRate, resetRate }) => {
    const v = document.querySelector('video');
    let paused = false, rate = 1;
    window.requestedRates = [];
    Object.defineProperties(v, {
      paused: { get: () => paused }, readyState: { get: () => 4 },
      playbackRate: { get: () => rate, set(value) { requestedRates.push(value); rate = resetRate ? 1 : value; if (pauseOnRate && value > 1) v.pause(); } },
    });
    v.pause = () => { if (!paused) { paused = true; v.dispatchEvent(new Event('pause')); } };
    v.play = () => { paused = false; if (pauseOnRate && rate > 1) v.pause(); return Promise.resolve(); };
    window.testVideo = v;
    __subject.configure({ speed: 2 });
  }, { pauseOnRate, resetRate });
}

test('Edge：优先通过网站倍速菜单设置速度', async t => {
  const page = await fixture('<div class="xtplayer"><video style="width:320px;height:180px"></video><ul class="speedList" style="display:none"><li rate="2">2x</li></ul></div>');
  t.after(() => page.close());
  await mockVideo(page);
  await page.evaluate(() => { document.querySelector('[rate="2"]').onclick = () => { clickCount++; testVideo.playbackRate = 2; }; __subject.ensureVideo(testVideo, false); });
  assert.deepEqual(await page.evaluate(() => ({ clicks: clickCount, rate: testVideo.playbackRate })), { clicks: 1, rate: 2 });
});

test('Edge：倍速触发持续暂停时回退 1 倍，恢复后不再反复尝试', async t => {
  const page = await fixture('<video style="width:320px;height:180px"></video>');
  t.after(() => page.close());
  await mockVideo(page, true);
  await page.evaluate(() => { __subject.ensureVideo(testVideo, false); __now += 1000; __subject.ensureVideo(testVideo, false); });
  for (let i = 0; i < 4; i++) await page.evaluate(() => { __now += 3000; __subject.ensureVideo(testVideo, false); });
  const result = await page.evaluate(() => ({ rate: testVideo.playbackRate, paused: testVideo.paused, blocked: __subject.speedState(testVideo).blocked, requests: requestedRates.filter(r => r > 1).length }));
  assert.deepEqual(result, { rate: 1, paused: false, blocked: true, requests: 1 });
});

test('Edge：网站重置速度时尝试次数有限，并显示原因', async t => {
  const page = await fixture('<video style="width:320px;height:180px"></video>');
  t.after(() => page.close());
  await mockVideo(page, false, true);
  for (let i = 0; i < 5; i++) await page.evaluate(() => { __now += 3000; __subject.ensureVideo(testVideo, false); });
  const result = await page.evaluate(() => ({ requests: requestedRates.filter(r => r > 1).length, issue: __subject.speedState(testVideo).issue }));
  assert.equal(result.requests, 3);
  assert.match(result.issue, /重置倍速/);
});

const screenshotModal = `<div id="screen-modal" class="unknown-modal-class" style="position:fixed;left:100px;top:120px;background:white;padding:30px;z-index:10000">
  <h3>提示</h3><p>确认提交?</p><div><a id="cancel" href="javascript:;">取消</a><a id="confirm" href="javascript:;">提交</a></div></div>`;

test('Edge：截图样式的未知 class 确认提交弹窗，点击弹窗内提交而非背景提交', async t => {
  const page = await fixture(`<h1>章节测验 单选题</h1>${question}<button id="submit">提交</button>`);
  t.after(() => page.close());
  await page.evaluate(html => {
    document.querySelector('#submit').onclick = () => {
      clickCount++;
      document.body.insertAdjacentHTML('beforeend', html);
      document.querySelector('#confirm').onclick = () => { clickCount++; document.querySelector('#screen-modal').remove(); };
    };
  }, screenshotModal);
  await tick(page); await tick(page); await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 2);
});

test('Edge：确认弹窗出现在外层页面，即使没有本地答题状态也能确认', async t => {
  const page = await fixture(screenshotModal);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#confirm').onclick = () => clickCount++; document.querySelector('#cancel').onclick = () => { throw new Error('不应点击取消'); }; });
  await tick(page); await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
});

test('Edge：提交等待已超时，随后出现的确认弹窗仍可恢复处理', async t => {
  const page = await fixture(`<div class="ans-videoquiz">${question}<button id="submit">提交</button></div>`);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#submit').onclick = () => clickCount++; });
  await tick(page); await tick(page); await tick(page, 16000);
  assert.equal(await page.evaluate(() => __subject.getState().phase), 'blocked');
  await page.evaluate(html => { document.body.insertAdjacentHTML('beforeend', html); document.querySelector('#confirm').onclick = () => clickCount++; }, screenshotModal);
  await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 2);
});

test('Edge：停止或关闭自动答题时，不自动确认提交', async t => {
  const page = await fixture(screenshotModal);
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#confirm').onclick = () => clickCount++; __subject.configure({ quiz: false }); });
  await tick(page);
  await page.evaluate(() => __subject.configure({ running: false, quiz: true }));
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
});

test('Edge：普通页面说明或无关删除弹窗不触发提交确认', async t => {
  const page = await fixture('<div><p>确认提交?</p><a id="inline-cancel">取消</a><a id="inline-submit">提交</a></div><div role="dialog"><p>是否删除记录？</p><button id="delete">确定</button></div>');
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelectorAll('a,button').forEach(el => { el.onclick = () => clickCount++; }); });
  await tick(page); await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
});

test('Edge：跨域答题 iframe 超时后，外层确认结果能传回并恢复等待', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  // 所有地址均被本地测试拦截，不连接学习通服务器。
  await page.route('https://*.chaoxing.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    route.request().url().includes('test-quiz') ? `<div class="ans-videoquiz">${question}<button id="submit">提交</button></div>` :
      '<iframe src="https://mooc-ans.chaoxing.com/test-quiz" style="width:600px;height:400px"></iframe>' }));
  await page.goto('https://mooc1.chaoxing.com/test-parent');
  const child = page.frames().find(frame => frame.url().includes('test-quiz'));
  assert.ok(child);
  for (const target of [page, child]) {
    await target.evaluate(() => { window.__now = 100000; Date.now = () => window.__now; window.clickCount = 0; });
    await target.addScriptTag({ content: instrumented });
  }
  await page.evaluate(html => {
    window.addEventListener('message', e => {
      if (e.data !== 'show-fixture-confirmation') return;
      document.body.insertAdjacentHTML('beforeend', html);
      document.querySelector('#confirm').onclick = () => { clickCount++; document.querySelector('#screen-modal').remove(); };
    });
    __subject.configure({ running: true, next: false });
  }, screenshotModal);
  await child.waitForFunction(() => __subject.getState().cfg.running);
  await child.evaluate(() => { document.querySelector('#submit').onclick = () => { clickCount++; parent.postMessage('show-fixture-confirmation', 'https://mooc1.chaoxing.com'); }; });
  await tick(child); await tick(child);
  assert.equal(await child.evaluate(() => clickCount), 1, JSON.stringify(await child.evaluate(() => __subject.getState())));
  await page.waitForSelector('#screen-modal', { timeout: 3000 });
  await tick(child, 16000);
  assert.equal(await child.evaluate(() => __subject.getState().phase), 'blocked');
  await tick(page);
  await child.waitForFunction(() => __subject.getState().phase === 'submitted');
  assert.equal(await page.evaluate(() => clickCount), 1);
  assert.equal(await child.evaluate(() => clickCount), 1);
  assert.match(await child.evaluate(() => __subject.getState().status), /已完成提交确认/);
});

const gradedResults = `<main id="graded-results">
  <div class="question-item"><h3>一、单选题</h3><p>1 识别诈骗最关键的因素是什么？</p><ul class="Zy_ulTop"><li>A 甲</li><li>B 乙</li></ul>
    <div class="unknown-result-row"><strong>我的答案：</strong><span>A</span><i>×</i><strong>0.0</strong><span>分</span></div></div>
  <div class="question-item"><h3>二、判断题</h3><p>2 判断下列说法。</p>
    <div class="unknown-result-row"><strong>我的答案：</strong><span>对</span><i>✓</i><strong>25.0</strong><span>分</span></div></div>
  </main>`;

test('Edge：截图中的逐题答案和得分页，无总成绩标题也能等待后点击下一节', async t => {
  const page = await fixture(gradedResults + '<span id="next">下 一 节</span>');
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#next').onclick = () => clickCount++; __subject.configure({ next: true }); });
  await tick(page);
  assert.equal(await page.evaluate(() => __subject.getState().completed), true);
  for (let i = 0; i < 4; i++) await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
  await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
  for (let i = 0; i < 20; i++) await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 1);
});

test('Edge：选择答案、提交、确认、显示逐题成绩、下一节和播放完整流程', async t => {
  const page = await fixture(`<h1>章节测验 单选题</h1>${question}<button id="submit">提交</button>`);
  t.after(() => page.close());
  await page.evaluate(({ modal, graded }) => {
    window.flow = [];
    document.querySelector('#submit').onclick = () => {
      flow.push('提交'); document.body.insertAdjacentHTML('beforeend', modal);
      document.querySelector('#confirm').onclick = () => {
        flow.push('确认'); document.body.innerHTML = graded + '<a id="next">下一节</a>';
        document.querySelector('#next').onclick = () => {
          flow.push('下一节'); document.body.innerHTML = '<video style="width:300px;height:180px"></video>';
          const video = document.querySelector('video'); let paused = true;
          Object.defineProperties(video, { paused: { get: () => paused }, readyState: { get: () => 4 } });
          video.play = () => { paused = false; flow.push('播放'); return Promise.resolve(); };
        };
      };
    };
    __subject.configure({ next: true });
  }, { modal: screenshotModal, graded: gradedResults });
  for (let i = 0; i < 12; i++) await tick(page);
  assert.deepEqual(await page.evaluate(() => flow), ['提交', '确认', '下一节', '播放']);
  assert.equal(await page.evaluate(() => __subject.getState().completed), false);
});

test('Edge：满分提示、仍可编辑或只有部分题目出分，不触发下一节', async t => {
  for (const html of [
    '<div class="question-item"><p>题目</p><div><b>我的答案：</b>A 满分25.0分</div></div>',
    gradedResults + '<div class="question-item"><label><input type="radio" name="new">还需要作答的题目</label></div>',
    gradedResults + '<div class="question-item"><h3>待答题</h3><ul class="Zy_ulTop"><li>A</li><li>B</li></ul></div>',
  ]) {
    const page = await fixture(html + '<button id="next">下一节</button>');
    t.after(() => page.close());
    await page.evaluate(() => { document.querySelector('#next').onclick = () => clickCount++; __subject.configure({ next: true }); });
    for (let i = 0; i < 8; i++) await tick(page);
    assert.equal(await page.evaluate(() => __subject.getState().completed), false);
    assert.equal(await page.evaluate(() => clickCount), 0);
  }
});

test('Edge：已出分页在关闭自动下一节或停止后不会跳转', async t => {
  const page = await fixture(gradedResults + '<button id="next">下一节</button>');
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('#next').onclick = () => clickCount++; });
  for (let i = 0; i < 7; i++) await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
  await page.evaluate(() => __subject.configure({ next: true }));
  await tick(page); await tick(page);
  await page.evaluate(() => __subject.configure({ running: false }));
  for (let i = 0; i < 7; i++) await tick(page);
  assert.equal(await page.evaluate(() => clickCount), 0);
});

test('Edge：结果页换成新测验后清除完成状态并重新答题', async t => {
  const page = await fixture(gradedResults);
  t.after(() => page.close());
  await tick(page);
  assert.equal(await page.evaluate(() => __subject.getState().completed), true);
  await page.evaluate(html => { document.body.innerHTML = html; }, question);
  await tick(page);
  assert.equal(await page.evaluate(() => __subject.getState().completed), false);
  assert.equal(await page.locator('input[value="A"]').isChecked(), true);
});

test('Edge：结果在跨域 iframe、下一节在外层页面时也能自动换课', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://*.chaoxing.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    route.request().url().includes('test-result') ? '<div class="question-item">尚在加载的题目</div>' :
      '<iframe src="https://mooc-ans.chaoxing.com/test-result" style="width:600px;height:400px"></iframe><span id="next">下一节</span>' }));
  await page.goto('https://mooc1.chaoxing.com/test-parent');
  const child = page.frames().find(frame => frame.url().includes('test-result'));
  for (const target of [page, child]) {
    await target.evaluate(() => { window.__now = 100000; Date.now = () => window.__now; window.clickCount = 0; });
    await target.addScriptTag({ content: instrumented });
  }
  await page.evaluate(() => { document.querySelector('#next').onclick = () => clickCount++; __subject.configure({ running: true, next: true }); });
  await child.waitForFunction(() => __subject.getState().cfg.running);
  await tick(child);
  assert.equal(await child.evaluate(() => __subject.getState().phase), 'blocked');
  await child.evaluate(html => { document.body.innerHTML = html; }, gradedResults);
  await tick(child);
  await page.waitForFunction(() => __subject.getState().remoteCompleted);
  for (let i = 0; i < 8; i++) { await tick(child); await tick(page); }
  assert.equal(await page.evaluate(() => clickCount), 1);
});

test('Edge：截图中的 0/0 懒加载视频先点中央播放按钮，再启动视频', async t => {
  const page = await fixture('<div class="video-js"><video style="width:320px;height:180px"></video><button class="vjs-big-play-button" aria-label="播放视频">▶</button></div>');
  t.after(() => page.close());
  await page.evaluate(() => {
    const v = document.querySelector('video'); let ready = 0, paused = true;
    window.flow = [];
    Object.defineProperties(v, { readyState: { get: () => ready }, paused: { get: () => paused } });
    v.play = () => { if (!ready) throw new Error('需要先初始化播放器'); paused = false; flow.push('播放'); return Promise.resolve(); };
    document.querySelector('button').onclick = () => { ready = 4; flow.push('启动播放器'); document.querySelector('button').remove(); };
  });
  await tick(page);
  assert.deepEqual(await page.evaluate(() => flow), ['启动播放器', '播放']);
});

test('Edge：未加载视频不能被误判为反复重置倍速', async t => {
  const page = await fixture('<video style="width:320px;height:180px"></video>');
  t.after(() => page.close());
  await page.evaluate(() => {
    const v = document.querySelector('video'); window.rateRequests = 0; window.playRequests = 0;
    Object.defineProperties(v, { playbackRate: { get: () => 1, set() { rateRequests++; } } });
    v.play = () => { playRequests++; return new Promise(() => {}); };
    __subject.configure({ speed: 1.25 });
  });
  for (let i = 0; i < 12; i++) await tick(page, 2000);
  assert.equal(await page.evaluate(() => rateRequests), 0);
  assert.equal(await page.evaluate(() => playRequests), 1);
  assert.doesNotMatch(await page.evaluate(() => __subject.getState().status), /重置倍速/);
});

test('Edge：视频被隐藏或点击后才创建时，仍可初始化播放器', async t => {
  for (const existing of [true, false]) {
    const page = await fixture(`<div class="video-js" style="width:320px;height:180px">${existing ? '<video style="display:none"></video>' : ''}<button class="vjs-big-play-button">▶</button></div>`);
    t.after(() => page.close());
    await page.evaluate(() => {
      document.querySelector('button').onclick = () => {
        clickCount++;
        let v = document.querySelector('video');
        if (!v) { v = document.createElement('video'); document.querySelector('.video-js').append(v); }
        v.style.cssText = 'width:320px;height:180px';
        let paused = true;
        Object.defineProperties(v, { readyState: { get: () => 4 }, paused: { get: () => paused } });
        v.play = () => { paused = false; return Promise.resolve(); };
        document.querySelector('button').remove();
      };
    });
    await tick(page); await tick(page);
    assert.equal(await page.evaluate(() => clickCount), 1);
    assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  }
});

test('Edge：停止、关闭自动播放或正在答题时，不点击中央播放按钮', async t => {
  for (const mode of ['stop', 'resume-off', 'quiz']) {
    const page = await fixture(`<div class="video-js"><video></video><button class="vjs-big-play-button">▶</button></div>${mode === 'quiz' ? '<div class="question-item">待处理的填空题<textarea></textarea></div>' : ''}`);
    t.after(() => page.close());
    await page.evaluate(mode => {
      document.querySelector('button').onclick = () => clickCount++;
      document.querySelector('video').play = () => { clickCount++; return Promise.resolve(); };
      if (mode === 'stop') __subject.configure({ running: false });
      if (mode === 'resume-off') __subject.configure({ resume: false });
    }, mode);
    await tick(page); await tick(page);
    assert.equal(await page.evaluate(() => clickCount), 0);
  }
});

test('Edge：浏览器要求真实手势时给出提示，不无限重试', async t => {
  const page = await fixture('<video style="width:320px;height:180px"></video>');
  t.after(() => page.close());
  await page.evaluate(() => { document.querySelector('video').play = () => { clickCount++; return Promise.reject(new DOMException('Gesture required', 'NotAllowedError')); }; });
  for (let i = 0; i < 8; i++) await tick(page, 3000);
  assert.equal(await page.evaluate(() => clickCount), 1);
  assert.match(await page.evaluate(() => __subject.getState().status), /手动播放/);
});

test('Edge：等待播放完成期间点击停止，延迟完成也不会重新播放', async t => {
  const page = await fixture('<video style="width:320px;height:180px"></video>');
  t.after(() => page.close());
  await page.evaluate(() => {
    const v = document.querySelector('video'); let paused = true;
    Object.defineProperty(v, 'paused', { get: () => paused });
    v.play = () => new Promise(resolve => { window.finishPlaying = () => { paused = false; resolve(); }; });
    v.pause = () => { paused = true; };
  });
  await tick(page);
  await page.evaluate(() => { __subject.configure({ running: false }); finishPlaying(); });
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
});

function realMediaFixture() {
  // 本地生成 3 秒静音 PCM，用实际媒体解码/加载验证 play()，不请求外部视频。
  const size = 8000 * 3;
  const wav = Buffer.alloc(44 + size, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(size, 40);
  return 'data:audio/wav;base64,' + wav.toString('base64');
}
test('Edge：真实媒体验证答题后换课、点击启动、加载时长并持续播放', async t => {
  const page = await fixture(`<h1>章节测验 单选题</h1>${question}<button id="submit">提交</button>`);
  t.after(() => page.close());
  await page.evaluate(({ modal, graded, media }) => {
    window.flow = [];
    document.querySelector('#submit').onclick = () => {
      flow.push('提交'); document.body.insertAdjacentHTML('beforeend', modal);
      document.querySelector('#confirm').onclick = () => {
        flow.push('确认'); document.body.innerHTML = graded + '<a id="next">下一节</a>';
        document.querySelector('#next').onclick = () => {
          flow.push('下一节'); document.body.innerHTML = '<div class="video-js"><video preload="none" style="width:300px;height:180px"></video><button class="vjs-big-play-button">▶</button></div>';
          const video = document.querySelector('video');
          video.addEventListener('playing', () => flow.push('播放'), { once: true });
          document.querySelector('button').onclick = () => { flow.push('启动播放器'); video.src = media; document.querySelector('button').remove(); };
        };
      };
    };
    __subject.configure({ next: true, speed: 1.25 });
  }, { modal: screenshotModal, graded: gradedResults, media: realMediaFixture() });
  for (let i = 0; i < 11; i++) await tick(page);
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.duration > 0 && v.currentTime > 0.05; }, null, { timeout: 5000 });
  await tick(page);
  assert.deepEqual(await page.evaluate(() => flow), ['提交', '确认', '下一节', '启动播放器', '播放']);
  assert.equal(await page.locator('video').evaluate(v => v.playbackRate), 1.25);
});
