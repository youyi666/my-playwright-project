/**
 * ================================================================================
 * 拼多多平台 登录辅助脚本
 * * 运行方式: node pdd_login.js
 * * 作用:
 * - 启动一个非无头模式的浏览器，并加载/创建用户数据目录。
 * - 您需要在这个浏览器中手动访问 pinduoduo.com 并完成登录操作。
 * - 登录成功后，关闭浏览器即可。登录状态会保存在 'pdd-auth-profile' 目录中，
 * 供主监控脚本使用。
 * ================================================================================
 */
const playwright = require('playwright-extra');
const { chromium } = require('playwright-core'); // 使用core避免重复下载
const stealth = require('puppeteer-extra-plugin-stealth')();

// 将stealth插件添加到chromium
playwright.chromium.use(stealth);

const USER_DATA_DIR = 'pdd-auth-profile';

(async () => {
    console.log("--- 启动浏览器用于手动登录 ---");
    console.log(`用户数据将保存在: ./${USER_DATA_DIR}`);

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, // 必须为 false 以便您能看到界面并操作
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN'
    });

    const page = await context.newPage();
    console.log("浏览器已启动。请在此浏览器中完成以下步骤:");
    console.log("1. 访问 m.pinduoduo.com 或 mobile.pinduoduo.com");
    console.log("2. 手动完成扫码或账号密码登录。");
    console.log("3. 登录成功后，您可以关闭此浏览器窗口。");
    console.log("4. 关闭浏览器后，此脚本将自动结束。");

    await page.goto('https://mobile.pinduoduo.com/');

    // 监听浏览器关闭事件
    context.on('close', () => {
        console.log("浏览器已关闭。登录信息已保存。现在您可以运行主脚本了。");
        process.exit(0);
    });

    // 防止脚本自动退出
    await new Promise(() => {});
})();