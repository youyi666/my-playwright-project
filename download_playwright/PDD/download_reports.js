// download_reports.js--我被这个日期搞蒙了，暂时通过这种修改，才能正确生成昨日的表格。

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// ======================= [配置区域] =======================
// 1. 用户登录配置文件夹 (请确保与您 scrape.js 中的路径一致)
const userDataDir = path.join(process.cwd(), 'pdd-auth-profile');

// 2. 报表下载的目标文件夹
const DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\推广_商品数据\\拼多多';

// 3. 目标网页的URL模板
const targetUrlTemplate = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';

// 4. (可选) 如果文件夹为空，从多少天前开始下载
const DEFAULT_START_DAYS_AGO = 7;

// ======================= [本次修改 1/4] =======================
// 5. (新增) 行为模拟配置
const DOWNLOADS_PER_BATCH = 15; // 每下载多少个文件后进行一次长暂停
const SHORT_DELAY_MIN_MS = 3000; // 短暂延迟的最小毫秒数 (原为 2000)
const SHORT_DELAY_MAX_MS = 7000; // 短暂延迟的最大毫秒数
const LONG_DELAY_MIN_MS = 35000; // 长暂停的最小毫秒数
const LONG_DELAY_MAX_MS = 65000; // 长暂停的最大毫秒数
// ==========================================================


/**
 * ======================= [本次修改 2/4] =======================
 * (新增) 生成一个在指定范围内的随机延迟时间
 * @param {number} min - 最小毫秒数
 * @param {number} max - 最大毫秒数
 * @returns {Promise<void>}
 */
function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(` -> 随机等待 ${delay / 1000} 秒...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}
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
        // ========================= [原有修改位置 1/2] =========================
        // 更新正则表达式以匹配 YYYYMMDD 格式的日期
        const dateRegex = /(\d{4})-(\d{2})-(\d{2})/;
        // ====================================================================

        files.forEach(file => {
            const match = file.match(dateRegex);
            if (match) {
                // ========================= [原有修改位置 2/2] =========================
                // 从匹配结果构建 YYYY-MM-DD 格式的日期字符串
                const dateString = `${match[1]}-${match[2]}-${match[3]}`; // 例如: '2025-09-07'
                // [正确代码]
                const parts = dateString.split('-'); // 例如, '2025-09-07' -> ['2025', '09', '07']
                // 使用数组元素创建日期，并确保月份-1 (因为JS月份从0开始)
                const fileDate = new Date(parts[0], parts[1] - 1, parts[2]); 
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
        yesterday.setDate(today.getDate() ); // 昨天是 2025-09-07

        let startDate = new Date();
        if (latestDate) {
            console.log(`本地找到的最新报表日期是: ${latestDate.toISOString().split('T')[0]}`);
            // [更稳健的新代码]
            startDate = new Date(latestDate); // 1. 先创建一个 latestDate 的精确副本
            startDate.setDate(startDate.getDate() ); // 2. 然后让这个副本自己增加一天
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
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
        viewport: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });

    const page = context.pages().length ? context.pages()[0] : await context.newPage();
    console.log('✅ 用户配置加载成功！开始执行下载任务...');

    // ======================= [本次修改 3/4] =======================
    // (新增) 下载计数器，用于触发长暂停
    let downloadCounter = 0;
    // ==========================================================

    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[处理中] 日期: ${dateStr}`);
            const targetUrl = targetUrlTemplate.replace(/{DATE}/g, dateStr);

            console.log(` -> 导航到: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            console.log(' -> 页面加载完成，正在查找下载按钮...');

            const downloadButton = page.getByRole('button', { name: '下载' }).nth(1);
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

            // ======================= [本次修改 4/4] =======================
            downloadCounter++; // 计数器加 1

            // 检查是否达到了批次下载的数量
            if (downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                console.log(`\n--- 已连续下载 ${DOWNLOADS_PER_BATCH} 个文件，执行一次长暂停以模拟人类行为 ---`);
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
                console.log('--- 长暂停结束，继续任务 ---\n');
            } else {
                // 将固定的 2 秒等待改为随机的短延迟
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }
            // ==========================================================

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