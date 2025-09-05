// run_download.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * 轮询检查报表是否生成成功
 * @param {import('playwright').Page} page - Playwright 的 Page 对象
 * @param {number} timeout - 总超时时间（毫秒）
 * @param {number} interval - 每次轮询的间隔时间（毫秒）
 */
async function pollForReportReady(page, timeout = 600000, interval = 5000) {
    console.log(`[轮询] 开始检查报表生成状态，最长等待 ${timeout / 1000} 秒...`);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        // 点击刷新按钮
        await page.getByRole('button', { name: '刷新表格' }).click();
        console.log(`[轮询] 已点击刷新，等待 ${interval / 1000} 秒后检查状态...`);
        
        // 等待一下，让数据加载
        await page.waitForTimeout(interval);

        // 定位到表格的第一行，并获取其状态文本
        // 注意: 这个选择器需要根据实际页面结构调整，这里假设状态在第4个单元格(td)
        const firstRow = page.locator('tbody tr').first();
        const statusCell = firstRow.locator('td').nth(1); // 假设状态在第四列，索引从0开始

        try {
            // 确保状态单元格可见
            await statusCell.waitFor({ state: 'visible', timeout: 5000 });
            const statusText = await statusCell.textContent();
            console.log(`[轮询] 当前最新任务状态: "${statusText}"`);

            if (statusText && statusText.includes('生成成功')) {
                console.log('[轮询] ✅ 报表生成成功！');
                return true; // 成功，跳出循环
            }
            // 如果是 "生成中" 或 "排队中"，则继续等待，不做任何事
            
        } catch (error) {
            console.log('[轮询] 无法获取最新任务状态，可能列表为空或正在加载。继续等待...');
        }
    }
    
    throw new Error(`[轮询] 超时 ${timeout / 1000} 秒，报表仍未生成成功。`);
}


// --- 主函数：包裹所有操作 ---
(async () => {
    let browser;
    let page;
    try {
        // --- 1. 启动浏览器并加载登录状态 ---
        console.log('正在静默启动浏览器...');
        browser = await chromium.launch({
            headless: true // 静默运行
        });

        // 从 auth.json 文件加载登录状态
        const context = await browser.newContext({ storageState: 'auth.json' });
        page = await context.newPage();
        console.log('浏览器已启动，并加载了登录状态。');

        // --- 2. 导航到目标报表页面 ---
        const reportUrl = "https://one.alimama.com/index.html?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf#!/report/item_promotion?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf&rptType=item_promotion&isRequestedQztDefaultSet=1";
        await page.goto(reportUrl);
        console.log('已成功导航到报表页面。');
        await page.waitForSelector('span[mx-click*="download"]', { timeout: 20000 });

        // --- 3. 点击“下载报表”按钮 ---
        await page.getByRole('button', { name: '下载报表' }).click();
        console.log('已成功点击“下载报表”。');

        // --- 4. 设置下载参数并提交 ---
        const dialogLocator = page.locator('div[mxv][data-spm="onebp_views_pages_report_download-dialog"]');
        await dialogLocator.waitFor({ state: 'visible', timeout: 10000 });
        console.log('下载对话框已显示。');

        const confirmButton = page.getByRole('button', { name: '确定' });
        await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
        await confirmButton.click();
        console.log('已点击“确定”，提交下载任务。服务器正在生成报表...');

        // --- 5. 跳转到下载任务列表 ---
        const downloadListUrl = "https://one.alimama.com/index.html?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf#!/report/download-list";
        await page.goto(downloadListUrl);
        console.log('已成功导航到下载任务列表。');

        // --- 6. [核心修改] 轮询等待报表生成成功 ---
        await page.waitForSelector('table', { timeout: 15000 });
        await pollForReportReady(page); // 调用轮询函数

        // --- 7. 下载文件 ---
        // 设置下载事件监听
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '刷新表格' }).click();
        console.log('已点击“刷新表格”，正在等待报表生成...');

        const dataRow = page.locator('tbody tr:has-text("生成成功")').first();
        await dataRow.waitFor({ state: 'visible' });
        console.log('最新的报表已确认生成成功。');
        
        console.log('正在查找下载按钮...');
        // 在阿里妈妈的页面中，操作按钮通常需要悬停才出现
        await dataRow.hover();
        console.log('已悬停在数据行以显示操作按钮。');
        
        // 注意：这里的 + tr 选择器可能不稳定，如果按钮就在tr内，直接用dataRow.locator更好
        const actionRow = dataRow.locator('+ tr');
        const downloadButton = actionRow.getByRole('button', { name: '下载' });

        await downloadButton.waitFor({ state: 'visible', timeout: 5000 });
        console.log('已找到下载按钮，准备点击下载...');
        await downloadButton.click();

        // --- 8. 保存文件 ---
        const download = await downloadPromise;
        const downloadedFileName = download.suggestedFilename();
        const downloadsDir = "C:\\Users\\Administrator\\Downloads\\待转化";
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const savePath = path.join(downloadsDir, downloadedFileName);

        await download.saveAs(savePath);

        if (fs.existsSync(savePath)) {
            console.log(`✅ 文件已成功下载并保存到: ${savePath}`);
        } else {
            throw new Error(`文件保存失败，路径未找到: ${savePath}`);
        }

    } catch (error) {
        console.error("脚本执行过程中发生错误:", error);
    } finally {
        if (browser) {
            await browser.close();
            console.log('浏览器已关闭。');
        }
    }
})();