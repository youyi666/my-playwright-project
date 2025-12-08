// su.viomi.com.cn.setup-auth.js
// 这是一个用于保存登录状态的脚本，等待用户手动确认。

const playwright = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline'); // 引入 readline 模块用于读取终端输入

// 创建一个用于读取终端输入的接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function saveAuth() {
  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('请在浏览器中手动登录 https://su.viomi.com.cn/ 并输入验证码。');
  console.log('当您成功登录并看到主页后，请回到终端并按下回车键（Enter）来结束并保存登录状态。');

  try {
    await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=851', { waitUntil: 'load', timeout: 60000 });
  } catch (err) {
    console.error(`\n错误：无法导航到登录页面。`);
    console.error(`请检查您的网络连接、防火墙或代理设置。`);
    console.error(`原始错误信息: ${err.message}`);
    await browser.close();
    return;
  }
  
  // 暂停，等待用户手动确认
  await new Promise(resolve => {
    rl.question('\n>> 请在浏览器中完成登录，完成后回到此处按下回车键继续...', () => {
      rl.close();
      resolve();
    });
  });

  // 保存登录状态到指定文件
  const authFile = path.join(__dirname, 'su.viomi.com.cn.auth.json');
  await context.storageState({ path: authFile });
  
  console.log(`\n登录状态已成功保存到 ${authFile} 文件中。`);

  await browser.close();
}

saveAuth();