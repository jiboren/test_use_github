import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const STORAGE_PATH = fileURLToPath(new URL('../storageState.json', import.meta.url));

export async function createContext(browser, forceLogin = false) {
  const reuse = !forceLogin && existsSync(STORAGE_PATH);
  try {
    const context = await browser.newContext(reuse ? { storageState: STORAGE_PATH } : {});
    return { context, needsLogin: !reuse };
  } catch (error) {
    if (!reuse) throw error;
    console.warn(`无法读取登录状态，将重新手动登录：${error.message}`);
    return { context: await browser.newContext(), needsLogin: true };
  }
}

export async function saveLoginState(context) {
  // 先写临时文件，避免中途退出破坏已有状态；包含支持的 IndexedDB 登录数据。
  await context.storageState({ path: `${STORAGE_PATH}.tmp`, indexedDB: true });
  await rename(`${STORAGE_PATH}.tmp`, STORAGE_PATH);
  console.log(`登录状态已保存：${STORAGE_PATH}`);
}

export async function manualLogin(page, config, ask) {
  await page.goto(config.LOGIN_URL, { waitUntil: 'domcontentloaded' });
  console.log('请在可见浏览器中手动完成登录、验证码及登录验证。程序不会代填或绕过验证。');
  const answer = await ask('确认登录成功后按 Enter 保存；输入 q 退出：');
  if (answer.trim().toLowerCase() === 'q') return false;
  await saveLoginState(page.context());
  return true;
}
