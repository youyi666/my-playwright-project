/**
 * @file jd-setup-auth.js - 修复了选择器失效的问题，并优化了用户提示。
 * @description
 * This is the final, robust version of the login script.
 * It ensures the login state is valid across subdomains before saving.
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

const authFilePath = path.join(__dirname, 'jd-auth.json');
const loginUrl = 'https://passport.jd.com/new/login.aspx';
const mainUrl = 'https://www.jd.com/';

(async () => {
    // 1. 清理旧的认证文件
    if (fs.existsSync(authFilePath)) {
        fs.rmSync(authFilePath);
        console.log('✅ 已删除旧的认证文件。');
    }

    // 2. 启动一个 "stealth" 浏览器
    const browser = await chromium.launch({ 
        headless: false,
        args: ['--start-maximized']
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // --- 修改开始 [位置 1/2] ---
    // 3. 导航到登录页面并提供用户操作说明
    //    我们将 page.goto 移到这里，先让浏览器跳转，再提示用户操作，逻辑更清晰。
    await page.goto(loginUrl);
    console.log('\n🚀 浏览器已自动跳转至京东登录页面。');
    console.log('   请在打开的浏览器窗口中手动完成登录操作 (推荐使用扫码)。');
    console.log('\n');
    console.log('   ✅✅✅【关键步骤】✅✅✅');
    console.log('   登录成功并能正常浏览页面后,');
    console.log('   请切回此终端窗口, 然后按 ENTER 键继续...');
    // --- 修改结束 [位置 1/2] ---

    // 4. 等待用户按下 Enter 键
    process.stdin.once('data', async () => {
        try {
            console.log('\n收到指令！正在保存登录状态...');
            
            // 5. 强制浏览器跳转到主域名以更新/同步 cookies
            console.log('提示: 正在跳转到主页以确保 Cookies 完全有效...');
            await page.goto(mainUrl, { waitUntil: 'networkidle' });

            // --- 修改开始 [位置 2/2] ---
            // 等待主页上的某个通用元素出现，以确认登录成功。
            // 旧的选择器 '#navitems-jd-2018 span.nickname' 已因网站更新而失效。
            // 新的选择器 'a.nickname' 更稳定，能准确指向用户的昵称链接。
            await page.locator('a.nickname').first().waitFor({ timeout: 15000 });
            console.log('提示: 在主域名上确认登录成功。');
            // --- 修改结束 [位置 2/2] ---

            // 6. 保存认证状态到文件
            await context.storageState({ path: authFilePath });
            console.log('🎉 成功！登录状态已保存至 `jd-auth.json`。');
        } catch (error) {
            console.error('❌ 保存状态时出错！原因可能是：登录超时、页面结构已改变或网络问题。');
            console.error('详细错误:', error.message);
        } finally {
            // 7. 关闭浏览器并退出进程
            await browser.close();
            console.log('浏览器已自动关闭。');
            process.exit(0);
        }
    });

    // 原来的 page.goto(loginUrl) 已被移动到前面，此处不再需要。
})();