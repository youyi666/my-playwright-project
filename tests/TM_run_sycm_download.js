// run_sycm_download.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- 主函数：包裹所有操作 ---
(async () => {
    let browser; 
    let page;
    try {
        // --- 1. 启动浏览器并加载登录状态 ---
        console.log('正在静默启动浏览器...');
        browser = await chromium.launch({ 
            headless: false // true 为静默运行, false 会显示浏览器窗口
        });
        
        // 从 auth.json 文件加载登录状态
        // 注意：这个 auth.json 必须包含 sycm.taobao.com 的登录信息
        const context = await browser.newContext({ storageState: 'auth.json' });
        page = await context.newPage();
        console.log('浏览器已启动，并加载了登录状态。');

        // --- 2. 动态计算日期 ---
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const year = yesterday.getFullYear();
        const month = String(yesterday.getMonth() + 1).padStart(2, '0');
        const day = String(yesterday.getDate()).padStart(2, '0');
        const formattedDate = `${year}-${month}-${day}`;
        console.log(`准备下载日期为: ${formattedDate} 的报表...`);
        
        // --- 3. 导航到目标页面 ---
        const targetUrl = `https://sycm.taobao.com/cc/item_rank?dateRange=${formattedDate}%7C${formattedDate}&dateType=day`;
        await page.goto(targetUrl);
        console.log('已成功导航到目标页面。');

        // --- 4. 处理可能出现的新手引导 ---
        try {
            console.log('正在检查“立即查看”新手引导...');
            const viewNowButton = page.getByRole('button', { name: '立即查看' });
            const pagePromise = page.context().waitForEvent('page');
            await viewNowButton.click({ timeout: 3000 }); // 增加轻微超时
            const newPage = await pagePromise;
            await newPage.close();
            console.log('已关闭新标签页，新手引导已解除。');
        } catch (error) {
            console.log('未发现新手引导，继续执行...');
        }
        
        // --- 5. 定位并点击下载链接 ---
        console.log('正在查找并点击下载链接...');
        const downloadPromise = page.waitForEvent('download');
        const downloadLink = page.locator('a.sycm-traced-download-text.sycm-cc-item-rank-download');

        await downloadLink.waitFor({ state: 'visible', timeout: 10000 }); // 增加等待时间
        console.log('已成功定位到下载链接。');
        await downloadLink.click();
        console.log('已成功点击下载链接。');

        // --- 6. 等待下载完成并保存文件 ---
        const download = await downloadPromise;
        console.log(`文件下载已开始，建议的文件名为: ${download.suggestedFilename()}`);

        const downloadsDir = "C:\\Users\\Administrator\\Downloads\\待转化";
        if (!fs.existsSync(downloadsDir)){
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const savePath = path.join(downloadsDir, download.suggestedFilename());
        
        await download.saveAs(savePath);
        console.log(`文件已成功保存到: ${savePath}`);

        // --- 7. 验证文件已成功下载 ---
        if (fs.existsSync(savePath)) {
            console.log('✅ 下载成功：文件已在本地验证存在！');
        } else {
            throw new Error(`下载失败：文件未在指定路径找到 ${savePath}`);
        }

    } catch (error) {
        console.error("脚本执行过程中发生错误:", error);
        // 在独立脚本中，错误发生时自动保存截图和HTML，非常有助于排查问题
        if (page) {
            await page.screenshot({ path: 'sycm_error_screenshot.png', fullPage: true });
            fs.writeFileSync('sycm_error_page.html', await page.content());
            console.log('已保存错误截图和页面HTML，以便调试。');
        }
    } finally {
        if (browser) {
            await browser.close();
            console.log('浏览器已关闭。');
        }
    }
})();