// download_reports.js

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// ======================= [配置区域] =======================
// 1. 用户登录配置文件夹 (请确保与您 scrape.js 中的路径一致)
const userDataDir = path.join(process.cwd(), 'pdd-auth-profile');

// 2. 报表下载的目标文件夹
const DOWNLOAD_FOLDER = 'Z:\\天猫生意参謀\\推广_商品数据\\拼多多';

// 3. 目标网页的URL模板
const targetUrlTemplate = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';

// 4. (可选) 如果文件夹为空，从多少天前开始下载
const DEFAULT_START_DAYS_AGO = 7;
// ==========================================================


/**
 * 计算需要下载的日期范围
 * @param {string} directory - 要检查的文件夹路径
 * @returns {Promise<string[]>} - 返回一个包含 "YYYY-MM-DD" 格式日期的数组
 */
async function getDatesToDownload(directory) {
    console.log(`正在检查文件夹: ${directory}`);
    try {
        await fs.mkdir(directory, { recursive: true }); // 确保文件夹存在
        const files = await fs.readdir(directory);

        let latestDate = null;
        // ========================= [本次修改位置 1/2] =========================
        // 更新正则表达式以匹配 YYYYMMDD 格式的日期
        const dateRegex = /(\d{4})(\d{2})(\d{2})/;
        // ====================================================================

        files.forEach(file => {
            const match = file.match(dateRegex);
            if (match) {
                // ========================= [本次修改位置 2/2] =========================
                // 从匹配结果构建 YYYY-MM-DD 格式的日期字符串
                const dateString = `${match[1]}-${match[2]}-${match[3]}`; // 例如: '2025-09-07'
                const fileDate = new Date(dateString);
                // ====================================================================

                if (!latestDate || fileDate > latestDate) {
                    latestDate = fileDate;
                }
            }
        });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 根据当前时间 (Monday, September 8, 2025) 计算昨天
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1); // 昨天是 2025-09-07

        let startDate = new Date();
        if (latestDate) {
            console.log(`本地找到的最新报表日期是: ${latestDate.toISOString().split('T')[0]}`);
            startDate.setTime(latestDate.getTime());
            startDate.setDate(latestDate.getDate() + 1);
        } else {
            console.log('本地文件夹为空或未找到有效报表，将从默认天数前开始下载...');
            startDate.setDate(today.getDate() - DEFAULT_START_DAYS_AGO);
        }

        const dates = [];
        // 循环直到 startDate 大于 yesterday
        while (startDate <= yesterday) {
            dates.push(startDate.toISOString().split('T')[0]);
            startDate.setDate(startDate.getDate() + 1);
        }

        return dates;

    } catch (error) {
        console.error('计算日期时出错:', error);
        return [];
    }
}

/**
 * 主函数
 */
async function main() {
    const datesToDownload = await getDatesToDownload(DOWNLOAD_FOLDER);

    if (datesToDownload.length === 0) {
        console.log('✅ 所有报表都已是最新，无需下载。');
        return;
    }

    console.log(`\n发现 ${datesToDownload.length} 个需要下载的报表日期:`);
    console.log(datesToDownload.join(', '));
    console.log('---');

    console.log(`正在从 \`${userDataDir}\` 加载用户配置以保持登录状态...`);
    if (!await fs.access(userDataDir).then(() => true).catch(() => false)) {
        console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`);
        console.error('请先成功运行一次您的 scrape.js 或本脚本并手动登录，以生成登录配置。');
        return;
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized'],
        viewport: null,
    });

    const page = context.pages().length ? context.pages()[0] : await context.newPage();
    console.log('✅ 用户配置加载成功！开始执行下载任务...');

    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[处理中] 日期: ${dateStr}`);
            const targetUrl = targetUrlTemplate.replace(/{DATE}/g, dateStr);

            console.log(` -> 导航到: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            console.log(' -> 页面加载完成，正在查找下载按钮...');

            const downloadButton = page.getByRole('button', { name: '下载' });
            await downloadButton.waitFor({ state: 'visible', timeout: 30000 });

            console.log(' -> 找到按钮，准备点击并捕获下载...');

            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                downloadButton.click(),
            ]);

            const fileName = `pdd_promotion_report_${dateStr}.csv`;
            const filePath = path.join(DOWNLOAD_FOLDER, fileName);

            await download.saveAs(filePath);
            console.log(`✅ [成功] 报表已保存到: ${filePath}`);

            await page.waitForTimeout(2000);

        } catch (error) {
            console.error(`❌ [失败] 处理日期 ${dateStr} 时遇到错误: ${error.message}`);
            console.error(' -> 将跳过这个日期，继续下一个。');
        }
    }

    console.log('\n---');
    console.log('所有下载任务已处理完毕！');
    await context.close();
}

main();