// 04-Debug_Structure.js - 彻底诊断为什么找不到按钮
const { chromium } = require('playwright');
const path = require('path');

const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const TARGET_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

async function debugStructure() {
    console.log(`\n--- 🕵️‍♀️ [诊断模式] DOM 结构深度分析 ---`);
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
        viewport: null
    });
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    try {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(10000); // 等待渲染

        console.log(' -> 正在页面上寻找所有包含 "下载报表" 文本的元素...');

        // 1. 宽泛搜索：页面上到底有没有这几个字？
        const allTexts = await page.getByText('下载报表').all();
        console.log(` -> 🔍 页面上共发现 ${allTexts.length} 处 "下载报表" 文本。`);

        if (allTexts.length === 0) {
            console.error(' -> ❌ 严重问题：页面上根本没有“下载报表”这几个字！可能是登录失效、页面空白或被反爬拦截。');
            // 截图
            await page.screenshot({ path: 'debug_no_text.png' });
            console.log(' -> 📸 已截图保存为 debug_no_text.png');
        } else {
            // 2. 深度分析每一个找到的元素
            for (let i = 0; i < allTexts.length; i++) {
                const el = allTexts[i];
                const isVisible = await el.isVisible();
                const tagName = await el.evaluate(e => e.tagName);
                const outerHTML = await el.evaluate(e => e.outerHTML);
                const parentHTML = await el.evaluate(e => e.parentElement ? e.parentElement.outerHTML : 'No Parent');
                
                console.log(`\n   --- [元素 #${i+1}] ---`);
                console.log(`   可见性: ${isVisible ? '✅ 可见' : '❌ 不可见'}`);
                console.log(`   标签名: <${tagName}>`);
                console.log(`   HTML源码: ${outerHTML.substring(0, 100)}...`);
                console.log(`   父级HTML: ${parentHTML.substring(0, 150)}...`);
                
                // 3. 测试旧的定位器是否能匹配到这个元素
                const isMatchOld = await el.evaluate(e => e.closest('div.download-box') !== null);
                console.log(`   是否在 div.download-box 内: ${isMatchOld ? '✅ 是' : '❌ 否 (这就是导致失败的原因)'}`);
            }
        }

    } catch (e) {
        console.error('❌ 诊断过程出错:', e);
    } finally {
        // 不关闭浏览器，方便你查看
        console.log('\n🛑 诊断结束。请分析上方日志。如果“是否在 div.download-box 内”为“否”，说明原来的 class 名变了。');
    }
}

debugStructure();