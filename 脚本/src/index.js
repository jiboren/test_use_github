import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import config from '../config.js';
import { createContext, manualLogin } from './login.js';
import { readCourses, printCourses } from './courses.js';
import { prepareVideoObserver, startVideoMonitor } from './player.js';

function validateConfig() {
  for (const name of ['LOGIN_URL', 'COURSE_URL']) {
    let url;
    try { url = new URL(config[name]); } catch { throw new Error(`请先在 config.js 填写有效的 ${name}。`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} 必须为 HTTP(S) 地址。`);
  }
  for (const name of ['COURSE_ITEM_SELECTOR', 'COURSE_TITLE_SELECTOR', 'PROGRESS_SELECTOR', 'COURSE_LINK_SELECTOR']) {
    if (typeof config[name] !== 'string' || !config[name].trim()) throw new Error(`config.js 中的 ${name} 不能为空。`);
  }
  for (const name of ['TIMEOUT_MS', 'POLL_INTERVAL_MS']) {
    if (!Number.isFinite(config[name]) || config[name] < 250) throw new Error(`${name} 必须为至少 250 的毫秒数。`);
  }
}

async function main() {
  validateConfig();
  const { chromium } = await import('playwright');
  const rl = createInterface({ input: stdin, output: stdout });
  const abort = new AbortController();
  const ask = prompt => rl.question(prompt, { signal: abort.signal });
  let browser;
  let stopMonitor;
  const cancel = () => { abort.abort(); rl.close(); };
  rl.on('SIGINT', cancel);
  rl.on('close', () => abort.abort());
  process.once('SIGINT', cancel);

  try {
    browser = await chromium.launch({ headless: false });
    browser.on('disconnected', cancel);
    const { context, needsLogin } = await createContext(browser, process.argv.includes('--login'));
    context.setDefaultTimeout(config.TIMEOUT_MS);
    context.setDefaultNavigationTimeout(config.TIMEOUT_MS);
    const page = await context.newPage();
    page.on('close', cancel);
    if (needsLogin && !await manualLogin(page, config, ask)) return;
    await page.goto(config.COURSE_URL, { waitUntil: 'domcontentloaded' });
    console.log('已打开课程列表。只扫描当前加载的条目；分页、展开章节及验证请手动完成。');

    while (!abort.signal.aborted) {
      let candidates = [];
      try {
        candidates = printCourses(await readCourses(page, config));
      } catch (error) {
        if (abort.signal.aborted) break;
        console.warn(`无法读取课程：${error.message}`);
        console.log('请检查选择器、当前页或登录状态。手动处理后输入 r；需要重新登录输入 l。');
      }
      if (abort.signal.aborted) break;
      const answer = (await ask('输入序号打开课程；r 重新读取当前列表；l 手动登录；q 退出：')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 'r') continue;
      if (answer === 'l') {
        if (!await manualLogin(page, config, ask)) break;
        await page.goto(config.COURSE_URL, { waitUntil: 'domcontentloaded' });
        continue;
      }
      const selected = /^\d+$/.test(answer) ? candidates[Number(answer) - 1] : null;
      if (!selected) { console.log('请输入列表中的有效序号。'); continue; }
      if (!selected.url) { console.log('没有可打开的 HTTP(S) 课程链接，请修改 COURSE_LINK_SELECTOR。'); continue; }

      const coursePage = await context.newPage();
      try {
        await prepareVideoObserver(coursePage);
        await coursePage.goto(selected.url, { waitUntil: 'domcontentloaded' });
        await coursePage.bringToFront();
        console.log(`已打开：${selected.title} / ${selected.chapter}。请自行开始播放。`);
        stopMonitor = startVideoMonitor(coursePage, config);
        await ask('按 Enter 停止监控并返回列表（此课程标签页会关闭）：');
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn(`打开或监控课程失败：${error.message}`);
      } finally {
        if (stopMonitor) await stopMonitor();
        stopMonitor = undefined;
        if (!coursePage.isClosed()) await coursePage.close();
      }
      if (!page.isClosed()) await page.bringToFront();
      console.log('可手动刷新列表以获取网站更新后的进度。');
    }
  } finally {
    if (stopMonitor) await stopMonitor();
    if (browser?.isConnected()) await browser.close();
    process.removeListener('SIGINT', cancel);
    rl.close();
  }
}

main().catch(error => {
  if (error.name === 'AbortError') return;
  console.error(`程序停止：${error.message}`);
  process.exitCode = 1;
});
