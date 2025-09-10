// run_sycm_download.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- 新增 ---
// 函数：格式化日期对象为 'YYYY-MM-DD' 字符串
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- 新增 ---
// 函数：从指定目录的文件名中解析并找到最新的日期
function getLatestDateFromFiles(directory) {
    console.log(`正在扫描目录 [${directory}] 以查找最新的已下载文件...`);
    if (!fs.existsSync(directory)) {
        console.log('目录不存在，将从默认起始点开始下载。');
        return null; // 如果目录不存在，返回 null
    }

    const files = fs.readdirSync(directory);
    const dateRegex = /(\d{4}-\d{2}-\d{2})/; // 用于从文件名中提取 YYYY-MM-DD 格式的日期
    let latestDate = null;

    for (const file of files) {
        const match = file.match(dateRegex);
        if (match) {
            const currentDate = new Date(match[1]);
            if (!latestDate || currentDate > latestDate) {
                latestDate = currentDate;
            }
        }
    }

    if (latestDate) {
        console.log(`找到的最新文件日期为: ${formatDate(latestDate)}`);
    } else {
        console.log('未在目录中找到任何符合日期格式的文件。');
    }
    
    return latestDate;
}

// --- 新增 ---
// 函数：生成需要下载的日期列表
function generateDateQueue(latestDate) {
    const datesToDownload = [];
    
    // 计算起始日期：如果找到了最新日期，则从其后一天开始；否则，可以设置一个默认起始日期，这里以7天前为例
    const startDate = new Date();
    if (latestDate) {
        startDate.setTime(latestDate.getTime());
        startDate.setDate(startDate.getDate() + 1);
    } else {
        // 如果文件夹是空的，可以自定义从哪天开始下载，例如7天前
        startDate.setDate(startDate.getDate() - 7); 
        console.log('未找到历史文件，将默认从7天前开始检查任务。');
    }

    // 计算截止日期：总是到昨天为止
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    // 生成日期队列
    let currentDate = new Date(startDate.getTime());
    while (currentDate <= yesterday) {
        datesToDownload.push(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return datesToDownload;
}


// --- 新增 ---
// 函数：封装单次下载操作
async function downloadReportForDate(page, date) {
    console.log(`\n--- [任务开始] 正在处理日期: ${date} ---`);
    try {
        // --- 3. 导航到目标页面 ---
        const targetUrl = `https://sycm.taobao.com/cc/item_rank?dateRange=${date}%7C${date}&dateType=day`;
        await page.goto(targetUrl);
        console.log(`已成功导航到目标页面: ${targetUrl}`);

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
            console.log(`✅ [任务成功] 日期 ${date} 的报表下载完成！`);
        } else {
            throw new Error(`下载失败：文件未在指定路径找到 ${savePath}`);
        }
        return true;
    } catch (error) {
        console.error(`❌ [任务失败] 下载日期 ${date} 的报表时发生错误:`, error.message);
        // 保存错误截图和HTML，有助于排查是哪个日期的页面出了问题
        await page.screenshot({ path: `sycm_error_${date}_screenshot.png`, fullPage: true });
        fs.writeFileSync(`sycm_error_${date}_page.html`, await page.content());
        console.log('已保存该日期的错误截图和页面HTML，以便调试。');
        return false;
    }
}


// --- 主函数：包裹所有操作 ---
// --- 修改：主函数流程重构以支持循环下载 ---
(async () => {
    let browser; 
    let page;
    try {
        // --- 新增：首先确定需要下载的任务队列 ---
        const downloadsDir = "z:\\天猫生意参谋\\商品_商品排行";
        const latestDateInFiles = getLatestDateFromFiles(downloadsDir);
        const datesToDownload = generateDateQueue(latestDateInFiles);

        if (datesToDownload.length === 0) {
            console.log('所有报表都已是最新，无需下载。脚本执行完毕。');
            return; // 没有需要下载的日期，直接退出
        }

        console.log(`\n检测到需要下载 ${datesToDownload.length} 个报表，日期分别为:`, datesToDownload);
        console.log('--------------------------------------------------');

        // --- 1. 启动浏览器并加载登录状态 ---
        console.log('正在静默启动浏览器...');
        browser = await chromium.launch({ 
            headless: true // true 为静默运行, false 会显示浏览器窗口
        });
        
        // 从 auth.json 文件加载登录状态
        // 注意：这个 auth.json 必须包含 sycm.taobao.com 的登录信息
        const context = await browser.newContext({ storageState: 'auth.json' });
        page = await context.newPage();
        console.log('浏览器已启动，并加载了登录状态。');

        // --- 新增：循环执行下载任务 ---
        for (const date of datesToDownload) {
            await downloadReportForDate(page, date);
        }

        console.log('\n🎉 所有下载任务已执行完毕！');

    } catch (error) {
        console.error("脚本主流程发生严重错误:", error);
        // 主流程错误（如浏览器启动失败）时，也尝试记录信息
        if (page) {
            await page.screenshot({ path: 'sycm_main_error_screenshot.png', fullPage: true });
            fs.writeFileSync('sycm_main_error_page.html', await page.content());
            console.log('已保存错误截图和页面HTML，以便调试。');
        }
    } finally {
        if (browser) {
            await browser.close();
            console.log('浏览器已关闭。');
        }
    }
})();