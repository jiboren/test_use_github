import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 在隔离环境加载真实脚本，拦截启动，只暴露待测逻辑；不会访问学习网站。
function harness() {
  let source = fs.readFileSync(new URL('../tampermonkey/chaoxing-helper-improved.user.js', import.meta.url), 'utf8');
  const marker = '  if (TOP) {\n    try {\n      const saved';
  assert.ok(source.includes(marker));
  source = source.replace(marker, `  globalThis.subject = {
    sanitize, isFinished, readyToAdvance, completionEvidence, choose, configure, later,
    getConfig: () => ({ ...cfg })
  }; return;\n${marker}`);
  const timers = [];
  const win = { addEventListener() {} };
  win.top = win;
  const context = vm.createContext({
    window: win, document: { querySelectorAll: () => [] },
    location: { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=1', pathname: '/mycourse/studentstudy' },
    sessionStorage: { setItem() {} }, URL,
    console: { info() {} }, setTimeout: fn => timers.push(fn),
  });
  vm.runInContext(source, context);
  return { api: context.subject, flush: () => timers.splice(0).forEach(fn => fn()) };
}

test('接近片尾不能代替视频真正结束', () => {
  const { api } = harness();
  assert.equal(api.isFinished({ ended: false, duration: 100, currentTime: 99.9 }), false);
  assert.equal(api.isFinished({ ended: true, duration: 100 }), true);
  assert.equal(api.isFinished({ ended: true, duration: Infinity }), false);
});

test('所有视频结束且没有待答题才能进入下一节', () => {
  const { api } = harness();
  assert.equal(api.readyToAdvance([]), false);
  assert.equal(api.readyToAdvance([{ videos: [{ ended: true }] }, { blocked: true, videos: [] }]), false);
  assert.equal(api.readyToAdvance([{ videos: [{ ended: true }, { ended: false }] }]), false);
  assert.equal(api.readyToAdvance([{ videos: [{ ended: true }] }]), true);
  assert.equal(api.readyToAdvance([{ completed: true, videos: [] }]), true);
});

test('普通得分文字不代表提交完成', () => {
  const { api } = harness();
  assert.equal(api.completionEvidence({ textContent: '章节测验 得分 满分100 提交' }), false);
  assert.equal(api.completionEvidence({ textContent: '未提交成功，请重试' }), false);
  assert.equal(api.completionEvidence({ textContent: '提交成功后不能修改' }), false);
  assert.equal(api.completionEvidence({ textContent: '提交成功' }), true);
  assert.equal(api.completionEvidence({ textContent: '本次成绩：60' }), true);
});

test('停止后取消已排队操作，重新开始不会复活旧点击', () => {
  const { api, flush } = harness();
  let clicks = 0;
  api.configure({ running: true });
  api.later(() => clicks++, 800);
  api.configure({ running: false });
  api.configure({ running: true });
  flush();
  assert.equal(clicks, 0);
});

test('相同配置心跳不会取消等待提交的操作', () => {
  const { api, flush } = harness();
  let clicks = 0;
  api.configure({ running: true });
  api.later(() => clicks++, 800);
  api.configure({ running: true, speed: 1 });
  flush();
  assert.equal(clicks, 1);
});

test('配置只接收已知字段、布尔值与支持的倍速', () => {
  const { api } = harness();
  const result = api.sanitize({ running: 'true', speed: 100, unknown: true, quiz: false });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { quiz: false });
});

function option(name, checked, type = 'radio') {
  return { name, checked, type, disabled: false, className: '', clicks: 0,
    getAttribute: () => null, click() { this.clicks++; this.checked = !this.checked; } };
}
function box(options, label) {
  return { textContent: label, querySelectorAll: s => s.startsWith('input[type="radio"]') ? options : [] };
}
test('选项按题目分组，已选答案不会被反向取消', () => {
  const { api } = harness();
  const options = [option('q1', true), option('q1', false), option('q2', false), option('q2', false)];
  assert.equal(api.choose(box(options, '单选题')).ok, true);
  assert.deepEqual(options.map(o => o.clicks), [0, 0, 1, 0]);
});
test('多选题遵循明确的最少选项要求，重复处理不取消答案', () => {
  const { api } = harness();
  const options = [option('q1', true, 'checkbox'), option('q1', false, 'checkbox'), option('q1', false, 'checkbox')];
  const question = box(options, '多选题 至少选择两项');
  assert.equal(api.choose(question).ok, true);
  assert.equal(api.choose(question).ok, true);
  assert.deepEqual(options.map(o => o.clicks), [0, 1, 0]);
});
test('未知题目结构不作出已答题判断', () => {
  const { api } = harness();
  assert.equal(api.choose(box([], '未知题型')).ok, false);
});
