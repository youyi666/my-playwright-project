const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');

const PROFILE_DIR = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0';

async function tryClosePopups(page) {
    const closeSelectors = ['[data-testid="beast-core-modal-icon-close"]', '.beast-core-modal-close', 'button:has-text("知道了")', '.beast-core-modal svg', 'i'];
    for (const s of closeSelectors) {
        const btn = page.locator(s).first();
        if (await btn.isVisible({ timeout: 500 })) { 
            await btn.click({ force: true }).catch(() => {}); 
            await page.waitForTimeout(500); 
        }
    }
}

// 辅助函数：计算昨天的 Unix 时间戳（秒）
function getYesterdayTimestamps() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    // 昨天 00:00:00
    yesterday.setHours(0, 0, 0, 0);
    const startTime = Math.floor(yesterday.getTime() / 1000); // 除以1000转换为秒
    
    // 昨天 23:59:59
    yesterday.setHours(23, 59, 59, 999);
    const endTime = Math.floor(yesterday.getTime() / 1000);
    
    return { startTime, endTime };
}

async function apiHijack() {
    console.log('-> 🚀 启动沙盒 12：瞒天过海 (API 动态劫持)...');
    const context = await chromium.launchPersistentContext(PROFILE_DIR, { 
        headless: false, 
        viewport: null 
    });
    const page = context.pages()[0] || await context.newPage();

    try {
        const { startTime, endTime } = getYesterdayTimestamps();
        console.log(`-> 🎯 算出的目标时间戳：开始=${startTime}, 结束=${endTime}`);

        // 【核心黑客科技：拦截并篡改发往特定 URL 的请求】
        await page.route('**/mars/shop/recentOrders/export/task/add', async route => {
            const request = route.request();
            if (request.method() === 'POST') {
                try {
                    const postData = JSON.parse(request.postData());
                    console.log(`\n-> 🕵️ 成功拦截到发包！原本界面的时间是: ${postData.groupStartTime} 至 ${postData.groupEndTime}`);
                    
                    // 偷梁换柱！篡改参数
                    postData.groupStartTime = startTime;
                    postData.groupEndTime = endTime;
                    
                    console.log(`-> 💉 已强行注入昨天的日期戳！正在放行请求...`);
                    
                    // 将改好的数据重新打包发送
                    await route.continue({
                        postData: JSON.stringify(postData)
                    });
                } catch (e) {
                    await route.continue();
                }
            } else {
                await route.continue();
            }
        });

        console.log('-> 🌐 加载网页，准备全自动执行...');
        await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await tryClosePopups(page);

        // 彻底抛弃日历！直接无脑点“生成报表”相关按钮
        console.log('-> ⚙️ 正在绕开日历，直接点击批量导出...');
        const batchExportBtn = page.getByRole('button', { name: '批量导出' });
        await batchExportBtn.waitFor({ state: 'visible', timeout: 15000 });
        await batchExportBtn.click();
        await page.waitForTimeout(1500);

        console.log('-> ⚙️ 点击生成报表（这将触发被我们拦截的 API）...');
        const generateBtn = page.getByRole('button', { name: '生成报表', exact: true });
        await generateBtn.click();
        
        console.log('-> ⏳ 操作完成，请观察终端里的拦截日志！');
        
        // 暂停一下，让你看看战果
        await page.pause();

    } catch (e) {
        if (!e.message.includes('closed')) {
            console.error(`\n-> ❌ 发生严重报错: ${e.message}`);
            await page.pause();
        }
    } finally {
        if (context) await context.close();
    }
}

apiHijack();