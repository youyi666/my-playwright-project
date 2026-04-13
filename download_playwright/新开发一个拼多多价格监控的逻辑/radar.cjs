const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');

(async () => {
    console.log(`🚀 --- 赛博雷达 1.1 (稳定监听版) 启动 ---`);
    
    // 这里的路径与你的主脚本保持一致，确保读取同一个登录状态
    const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized']
    });
    const page = context.pages()[0] || await context.newPage();

    // ======================= [全局网络监听模块] =======================
    page.on('response', async (response) => {
        const url = response.url();
        const request = response.request();
        
        if (url.includes('mms.pinduoduo.com') && (request.resourceType() === 'fetch' || request.resourceType() === 'xhr')) {
            try {
                const contentType = response.headers()['content-type'] || '';
                if (response.status() === 200 && contentType.includes('application/json')) {
                    const jsonBody = await response.json();
                    console.log(`\n📡 [雷达捕获 API]: ${url.split('?')[0]}`); 
                    const dataSnippet = JSON.stringify(jsonBody).substring(0, 200);
                    console.log(`📦 [数据快照]: ${dataSnippet}...`);
                    console.log(`--------------------------------------------------`);
                }
            } catch (e) {}
        }
    });
    // ========================================================================

    console.log('🔗 正在连接拼多多后台...');
    await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { waitUntil: 'domcontentloaded' });

    // ======================= [核心修复：恢复登录拦截机制] =======================
    if (page.url().includes('login')) {
        console.log(' -> 🔑 检测到未登录或状态过期，请手动扫码或输入密码...');
        // 给予长达 5 分钟的等待时间
        await page.waitForURL(url => !url.href.includes('login'), { timeout: 300000 });
        console.log(' -> ✅ 登录成功！准备进入雷达监听模式。');
    }
    // ========================================================================

    console.log('\n👀 雷达已成功挂载，正在全天候监听网络请求！');
    console.log('👉 【你的任务】：在浏览器里输入商品ID，点击一次【查询】按钮。');
    console.log('👉 【观察终端】：找到控制台吐出来的那个带有你商品ID的 API 链接！');
    console.log('⚠️ (调试完毕后，可在控制台按 Ctrl+C 退出程序)\n');

    // ======================= [核心修复：死循环保活机制] =======================
    // 创建一个永远处于 pending 状态的 Promise，把进程死死卡在这里，让你有充足的时间去页面上操作
    await new Promise(() => {});
    // ========================================================================
})();