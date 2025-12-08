// pdd-quota-increase-test-persistent.js - 独立的拼多多提额测试脚本 (修正导航超时问题)

const { chromium, errors } = require('playwright');
const path = require('path');
const fs = require('fs/promises');


// ======================= [配置区域] =======================
// **重要：此路径与您提供的 pdd_activity_scraper.js 脚本中的路径一致**
const userDataDir = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\PDD\\pdd-auth-profile';

// 拼多多目标URL
const PDD_TARGET_URL = 'https://mms.pinduoduo.com/orders/reportManage?msfrom=mms_sidenav';
const APPLY_REASON = '发货'; 

// 🚀 优化改动 1：移除了 HUMAN_LIKE_DELAY 相关的常量

// ======================= [辅助函数] =======================
/**
 * 提取字符串中的第一个数字（整数或浮点数）。
 * @param {string} text - 包含数字的字符串。
 * @returns {number | null} 提取到的数字或 null。
 */
function extractFirstNumber(text) {
    const match = text.match(/(\d+(\.\d+)?)/);
    if (match) {
        return parseFloat(match[1]);
    }
    return null;
}

// 🚀 优化改动 2：移除了 randomDelay 函数

/**
 * 执行拼多多提额任务
 */
async function pddQuotaIncreaseTest() {
    console.log('\n--- 🚀 正在启动浏览器 (持久化会话) 并执行拼多多提额任务 ---');

    let context;
    let page;

    try {
        // 检查用户配置目录
        console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
        try { 
            await fs.access(userDataDir); 
        } catch { 
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); 
            return; 
        }
        
        // 使用 launchPersistentContext 启动
        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null 
        });
        
        page = context.pages().length ? context.pages()[0] : await context.newPage();
        console.log('✅ 用户配置加载成功！会话已恢复。');


        // --- 步骤 1: 导航到拼多多目标页面 ---
        console.log(`\n➡️ 导航到拼多多目标页面: ${PDD_TARGET_URL} (等待 'domcontentloaded')`);
        await page.goto(PDD_TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); 
        
        // 关键：等待页面内容稳定加载
        // 🚀 优化改动 3：将 3000ms 缩短到 1000ms
        await page.waitForTimeout(1000); 

        // --- 步骤 2: 执行提额操作 ---
        console.log('--- 开始执行提额操作 ---');
        
        // 🚀 优化改动 4：移除了 randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // ======================= [核心点击重试逻辑] =======================

        // 核心定位器：提额弹窗中的最大提额量提示，用于检查弹窗是否弹出
        const maxLimitTextLocator = page.locator('div[id="number"]').locator('div.Form_itemHelper_5-164-0').first();
        
        // 链接定位器：基于父结构和角色
        const tiEButtonLocator = page.locator('div.ReportLimit_contentTip__3e3sT').getByRole('link', { name: '申请今日提额' }).first();
        
        let dialogOpened = false;
        let attempt = 0;
        const maxAttempts = 3;

        console.log('🔍 正在尝试多种方式点击 "申请今日提额" 链接，直到对话框弹出...');

        while (!dialogOpened && attempt < maxAttempts) {
            attempt++;
            console.log(`   -> 第 ${attempt} 次尝试点击...`);
            
            try {
                if (attempt === 1) {
                    // 尝试 1: Playwright 标准点击
                    await tiEButtonLocator.waitFor({ state: 'visible', timeout: 5000 });
                    await tiEButtonLocator.click();
                    console.log('   -> 尝试方法 1: Playwright 标准点击');
                } else if (attempt === 2) {
                    // 尝试 2: JavaScript 强制点击
                    // 确保元素句柄存在，再执行 JS 点击
                    const elementHandle = await tiEButtonLocator.elementHandle({ timeout: 5000 });
                    if (elementHandle) {
                        await page.evaluate(element => { element.click(); }, elementHandle);
                        console.log('   -> 尝试方法 2: JavaScript 强制点击');
                    } else {
                        throw new Error("Element handle not found for JS click.");
                    }
                } else if (attempt === 3) {
                    // 尝试 3: 通用文本定位 + 强制点击
                    const fallbackLocator = page.getByText('申请今日提额', { exact: true }).first();
                    await fallbackLocator.waitFor({ state: 'visible', timeout: 5000 });
                    await fallbackLocator.click({ force: true });
                    console.log('   -> 尝试方法 3: 通用文本定位 + 强制点击');
                }
                
                // 🚀 优化改动 5：将等待弹窗反应时间从 1000-2000ms 统一缩短到 500ms
                await page.waitForTimeout(500); 
                
                // 检查对话框是否弹出：通过检查下一个关键元素是否可见来判断
                await maxLimitTextLocator.waitFor({ state: 'visible', timeout: 5000 }); 
                dialogOpened = true;
                console.log(`✅ 第 ${attempt} 次尝试成功！提额对话框已弹出。`);

            } catch (e) {
                console.log(`   -> 第 ${attempt} 次尝试失败，错误: ${e.message.split('\n')[0]}`);
                // 🚀 优化改动 6：将失败后稍等片刻的时间从 1000-2000ms 缩短到 1000ms
                await page.waitForTimeout(1000); 
            }
        }

        if (!dialogOpened) {
            throw new Error(`经过 ${maxAttempts} 次尝试，提额对话框仍未弹出，脚本终止。`);
        }
        
        // ======================= [核心点击重试逻辑 结束] =======================

        
        // 🚀 优化改动 7：移除了 randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 3. 提取最大提额数字
        const maxLimitText = await maxLimitTextLocator.textContent();
        console.log(`   - 提取到的提示文本: ${maxLimitText.trim()}`);

        const maxQuota = extractFirstNumber(maxLimitText);

        if (!maxQuota || maxQuota <= 0) {
            throw new Error(`无法从提示文本中提取到有效的最大提额数字。提取结果: ${maxQuota}`);
        }
        console.log(`✅ 成功提取到最大可申请提额量: ${maxQuota}`);

        // 4. 找到“申请提额量”的输入框并填入提取到的数字
        // 定位 id="number" 的 div 内部的 input
        const quotaInput = page.locator('div[id="number"] input[data-testid="beast-core-inputNumber-htmlInput"]').first();
        await quotaInput.fill(String(maxQuota)); 
        console.log(`➡️ "申请提额量" 输入框已填入: ${maxQuota}`);

        // 🚀 优化改动 8：移除了 randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 5. 找到“申请理由”的输入框并填入理由
        // 定位 id="reason" 的 div 内部的 textarea
        const reasonInput = page.locator('div[id="reason"] textarea[data-testid="beast-core-textArea-htmlInput"]').first();
        await reasonInput.fill(APPLY_REASON);
        console.log(`➡️ "申请理由" 输入框已填入: ${APPLY_REASON}`);

        // 🚀 优化改动 9：移除了 randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 6. 点击“提交”按钮 
        const submitButton = page.getByRole('button', { name: '提交' }).last();
        await submitButton.click();
        console.log('✅ 已点击提交按钮。');
        
        // 等待任务完成
        // 🚀 优化改动 10：将 3000ms 缩短到 1000ms
        await page.waitForTimeout(1000); 

        console.log('\n🎉 拼多多提额流程执行完毕！请检查浏览器中的结果。');

    } catch (error) {
        console.error('❌ 脚本在执行过程中出错:', error.message);
    } finally {
        if (context) {
            await context.close(); 
            console.log('🔚 浏览器已关闭，脚本执行结束。');
        }
    }
}

// 运行主函数
pddQuotaIncreaseTest();