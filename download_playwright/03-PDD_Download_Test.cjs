// 03-PDD_Download_Test.cjs
// [2026-01-28 V7 智能等待版]
// 核心修复：不再固定等待3秒，而是强制等待“下载报表”文字出现后再操作

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs/promises');

// ======================= [配置] =======================
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询', '测试下载');
const TARGET_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

async function runTest() {
    console.log(`\n--- 🚀 [V7 智能等待版] 启动 ---`);
    let context, page;

    try {
        // 1. 启动
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
            viewport: null,
            downloadsPath: DOWNLOAD_FOLDER 
        });
        page = context.pages().length ? context.pages()[0] : await context.newPage();

        // 2. 访问
        console.log(` -> 进入页面: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        
        // --- 核心修改：不再傻等3秒，而是智能等待目标出现 ---
        console.log(' -> ⏳ 正在等待“下载报表”按钮出现 (最多等 30秒)...');
        
        try {
            // 尝试等待页面上出现任意一个包含“下载报表”文字的元素
            await page.waitForSelector('text=下载报表', { timeout: 10000 });
            console.log(' -> ✅ 列表已加载！');
        } catch (e) {
            console.warn(' -> ⚠️ 等待超时，列表可能未自动加载。尝试点击“查询/刷新”...');
            // 如果等了10秒还没出来，尝试点一下查询或刷新
            const refreshBtn = page.getByText('刷新').or(page.getByText('查询')).first();
            if (await refreshBtn.isVisible()) {
                await refreshBtn.click();
                await page.waitForTimeout(2000); // 点完再等一会
            }
        }

        // 3. 开始遍历
        const buttons = page.getByTestId('beast-core-button');
        const count = await buttons.count();
        console.log(` -> 扫描到 ${count} 个按钮...`);

        let clicked = false;

        for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i);
            
            // 获取按钮文字（容错处理）
            const text = await btn.innerText().catch(() => '');
            
            // 只要文字里包含 "下载报表"
            if (text.includes('下载报表')) {
                console.log(` -> 🎯 锁定第 ${i} 个按钮: [${text.replace(/\s/g, '')}]`);
                
                // 高亮
                await btn.evaluate(node => node.style.border = '5px solid red');
                await page.waitForTimeout(500);

                console.log(' -> 🖱️ 点击下载...');
                try {
                    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }); // 给足时间下载
                    
                    // 强制点击，防止有透明遮罩
                    await btn.click({ force: true });
                    
                    const download = await downloadPromise;
                    const fileName = download.suggestedFilename();
                    console.log(` ✅ [成功] 捕获下载: ${fileName}`);

                    await fs.mkdir(DOWNLOAD_FOLDER, { recursive: true });
                    const savePath = path.join(DOWNLOAD_FOLDER, `TEST_V7_${fileName}`);
                    await download.saveAs(savePath);
                    console.log(`    文件已保存至: ${savePath}`);

                    clicked = true;
                    break; // 成功一个就结束
                } catch (e) {
                    console.error(` ⚠️ 点击了但下载超时: ${e.message}`);
                }
            }
        }

        if (!clicked) {
            console.error(' ❌ 依然未找到“下载报表”。可能是登录过期或列表确实为空。');
        }

    } catch (error) {
        console.error('❌ 错误:', error);
    } finally {
        console.log('\n -> 🛑 测试结束。');
        // if (context) await context.close();
    }
}

runTest();