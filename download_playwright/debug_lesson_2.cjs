const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');

const PROFILE_DIR = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0';

// 改进版的弹窗清理
async function tryClosePopups(page) {
    try {
        const closeSelectors = [
            '[data-testid="beast-core-modal-icon-close"]',
            '.beast-core-modal-close',
            'button:has-text("知道了")',
            '.beast-core-modal svg', 
            'i' // <- 收录你发现的隐藏开关
        ];
        for (const selector of closeSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 发现弹窗 (${selector})，正在清理...`);
                await btn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500); 
            }
        }
    } catch (e) {}
}

async function testCalendarAndDate() {
    console.log('-> 🚀 启动日历调试沙盒 2.1...');
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        slowMo: 500, 
        viewport: null
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // 进页面先扫一次雷
    await tryClosePopups(page);

    console.log('-> ⏸️ 准备执行开门逻辑。点击 Resume 观察日历是否能稳定保持打开。');
    await page.pause(); // 【断点 1】

    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
    
    // 【核心修复：状态防抖】
    // 1. 先尝试最常规的点击
    console.log('-> 尝试常规点击输入框...');
    await dateInput.click({ force: true });
    await page.waitForTimeout(1000); // 等待动画

    // 2. 检查：如果没开，再尝试底层事件
    if (!await calendarContainer.isVisible()) {
        console.log('-> 常规点击失败，尝试底层 focus 唤醒...');
        await dateInput.evaluate(node => node.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(1000);
    }

    if (await calendarContainer.isVisible()) {
        console.log('-> ✅ 日历已稳定打开！准备尝试点击 [15号]');
        
        // 尝试在日历里找 "15" 这个数字
        const targetDay = '15';
        const regex = new RegExp(`^\\s*${targetDay}\\s*$`);
        const dayCell = calendarContainer.locator('td:not(.disabled):not(.prev-month):not(.next-month)').filter({ hasText: regex }).last();
        
        if (await dayCell.isVisible()) {
            await dayCell.click({ force: true });
            console.log(`-> ✅ 成功点击了 ${targetDay} 号！`);
        } else {
            console.log(`-> ❌ 没找到 ${targetDay} 号所在的格子。`);
        }
    } else {
        console.log('-> ❌ 日历依然无法稳定打开。');
    }

    console.log('-> ⏸️ 请检查网页最终状态：日历选上了吗？');
    await page.pause(); // 【断点 2】

    console.log('-> 🏁 沙盒测试结束。');
    await context.close();
}

testCalendarAndDate();