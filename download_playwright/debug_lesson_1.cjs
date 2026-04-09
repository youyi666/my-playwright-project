const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');

// 指向你现有的拼多多登录缓存文件夹
const PROFILE_DIR = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0';

async function runDebug() {
    console.log('-> 🚀 启动调试沙盒...');
    let context = null;
    let page = null;

    try {
        // 核心调试技巧 1：headless: false (必须看到界面) 
        // 核心调试技巧 2：slowMo: 500 (让机器人的每次点击和输入都强制延迟 0.5 秒，方便肉眼观察)
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: false,
            slowMo: 500, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
            viewport: null
        });

        page = context.pages()[0] || await context.newPage();
        
        console.log(`-> 🌐 正在访问拼多多订单列表页...`);
        await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`-> ⏸️ 脚本已在此处强行暂停！请查看弹出的 Playwright Inspector 窗口。`);
        
        // 核心调试技巧 3：终极断点。代码运行到这里会完全停住。
        await page.pause(); 
        
        // 当你在 Inspector 中点击 Resume (继续) 后，才会执行下面的代码
        console.log(`-> ▶️ 调试结束，准备关闭浏览器。`);

    } catch (error) {
        console.error(`-> ❌ 运行出错: ${error.message}`);
        // 核心容错机制：即使报错也留下案发现场截图
        if (page) {
            await page.screenshot({ path: `debug_error_${Date.now()}.png`, fullPage: true }).catch(() => {});
            console.log(`-> 📸 已保存错误截图`);
        }
    } finally {
        if (context) await context.close();
        console.log('-> 🏁 沙盒测试结束。');
    }
}

runDebug();