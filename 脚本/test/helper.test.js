import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProgress, resolveCourseUrl } from '../src/courses.js';
import { formatTime } from '../src/player.js';

test('未完成与已完成中文状态不会混淆', () => {
  for (const value of ['未完成', '尚未完成', '未学完', '未开始', '学习中', 'Not completed']) {
    assert.equal(classifyProgress(value), 'incomplete', value);
  }
  for (const value of ['已完成', '已学完', 'Completed']) {
    assert.equal(classifyProgress(value), 'complete', value);
  }
});

test('百分比支持小数、0% 和全角符号，异常值不判定完成', () => {
  for (const value of ['0%', '进度 99.9%', '50％']) assert.equal(classifyProgress(value), 'incomplete');
  assert.equal(classifyProgress('100%'), 'complete');
  for (const value of ['101%', '-1%', '']) assert.equal(classifyProgress(value), 'unknown');
});

test('章节计数有效才判定，其他状态保留为待确认', () => {
  assert.equal(classifyProgress('2 / 3 节'), 'incomplete');
  assert.equal(classifyProgress('3/3'), 'complete');
  for (const value of ['0/0', '4/3', '请完成学习', '100', '考试通过', '已完成 2 节，未完成 1 节']) {
    assert.equal(classifyProgress(value), 'unknown', value);
  }
});

test('课程地址解析支持相对地址、SPA 路由，拒绝脚本和空链接', () => {
  const base = 'https://example.com/courses/';
  assert.equal(resolveCourseUrl('lesson/1', base), 'https://example.com/courses/lesson/1');
  assert.equal(resolveCourseUrl('#/lesson/1', base), 'https://example.com/courses/#/lesson/1');
  for (const value of ['', '#', null, 'javascript:void(0)', 'data:text/html,hello']) {
    assert.equal(resolveCourseUrl(value, base), null);
  }
});

test('视频元数据未加载或直播时不误报为零时长', () => {
  assert.equal(formatTime(3661.9), '01:01:01');
  assert.equal(formatTime(0), '00:00:00');
  assert.match(formatTime(NaN), /未知/);
  assert.match(formatTime(Infinity), /直播/);
});
