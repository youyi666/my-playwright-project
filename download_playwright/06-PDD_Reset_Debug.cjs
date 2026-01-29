// 06-PDD_Reset_Debug.cjs (V2)
// [2026-01-28 归零与日期交互专用调试器 - 强力开门版]
// 核心升级：引入 ensureCalendarOpen 函数，彻底解决“点击无反应”导致的测试中断

const { chromium } = require('playwright');
const path = require('path');

// ======================= [配置] =======================
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const TARGET_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0';

// ======================= [辅助函数] =======================
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function highlight(element) {
    if (element && await element.isVisible()) {
        await element.evaluate(node => {
            node.style.border = '4px solid red';
            node.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
            node.style.transition = 'all 0.3s';
        });
        await delay(300);
    }
}

// 🔴 核心修复：强力开门函数
async function ensureCalendarOpen(page) {
    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');

    // 如果已经开了，直接返回
    if (await calendarContainer.isVisible()) return;

    // 最多重试 3 次
    for (let i = 1; i <= 3; i++) {
        try {
            console.log(`     -> [尝试 ${i}/3] 强制点击输入框...`);
            await highlight(dateInput); // 高亮一下
            await dateInput.click({ force: true });
            
            // 等待弹窗
            await calendarContainer.waitFor({ state: 'visible', timeout: 2000 });
            return;
        } catch (e) {
            console.warn(`     ⚠️ 第 ${i} 次点击未触发日历，准备重试...`);
            await delay(1000);
        }
    }
    throw new Error("UI 响应死锁：尝试 3 次均无法打开日历");
}

// ======================= [核心逻辑] =======================

async function runDebug() {
    console.log(`\n--- 🩺 [归零功能 V2] 强力诊断启动 ---`);
    let context, page;

    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
            viewport: null
        });
        page = context.pages()[0] || await context.newPage();

        console.log(` -> 正在访问订单页...`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await delay(3000);

        // 关闭干扰弹窗
        try {
            const closeBtn = page.locator('[data-testid="beast-core-modal-icon-close"]');
            if (await closeBtn.isVisible()) await closeBtn.click();
        } catch (e) {}

        const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
        const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');

        // === 开始压力测试循环 ===
        for (let round = 1; round <= 3; round++) {
            console.log(`\n========== 第 ${round} 轮测试 ==========`);

            // 1. 强力打开日历
            console.log(' [1] 正在打开日历...');
            await ensureCalendarOpen(page);
            console.log('     ✅ 日历已打开');

            // 2. 寻找归零按钮
            let resetLink = calendarContainer.locator('text=归零').or(calendarContainer.locator('a, span').filter({ hasText: '归零' })).first();
            
            // 3. 【诱导逻辑】激活归零
            if (!await resetLink.isVisible()) {
                console.log(' [2] 未发现“归零”，执行诱导激活...');
                
                // 点一个日期
                const activeCell = calendarContainer.locator('td:not(.disabled):not(.gray)').nth(15);
                await highlight(activeCell);
                await activeCell.click({ force: true });
                await delay(500);

                // 点完日期日历可能关了，必须重新强力打开！
                await ensureCalendarOpen(page);
            } else {
                console.log(' [2] “归零”按钮当前可见。');
            }

            // 4. 执行归零
            if (await resetLink.isVisible()) {
                console.log(' [3] 🎯 点击“归零”...');
                await highlight(resetLink);
                await resetLink.click({ force: true });
                await delay(1000); 

                // 归零后日历可能关闭，再次确保打开
                await ensureCalendarOpen(page);
            } else {
                console.error(' ❌ 诱导失败：归零按钮仍未出现。');
            }

            // 5. 模拟重新选择 (验证归零后功能)
            console.log(' [4] 验证归零后选日期 (27号)...');
            const targetDay = "27";
            const regex = new RegExp(`^\\s*${targetDay}\\s*$`);
            const cells = calendarContainer.locator('td').filter({ hasText: regex });
            const count = await cells.count();
            let clicked = false;
            
            for(let i=0; i<count; i++) {
                const cell = cells.nth(i);
                if (await cell.isVisible()) {
                    const cls = await cell.getAttribute('class') || '';
                    if (!cls.includes('disabled') && !cls.includes('prev-month')) {
                        await highlight(cell);
                        await cell.click({ force: true });
                        clicked = true;
                        console.log('     ✅ 成功点击 27 号');
                        break;
                    }
                }
            }
            
            if (!clicked) console.log('     ⚠️ 未找到 27 号');
            await delay(1000);
        }

        console.log(`\n--- ✅ 测试结束 ---`);

    } catch (e) {
        console.error('\n❌ 测试中断:', e);
    } finally {
        if (context) await context.close();
    }
}

runDebug();