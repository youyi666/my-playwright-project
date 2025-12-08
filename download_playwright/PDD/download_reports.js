// pdd_all_in_one.js - 融合了提额测试和报表下载导入数据库的脚本

const { chromium, errors } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// --- 数据库和Excel处理相关的依赖 ---
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
// 1. 用户登录配置文件夹 (两个脚本共用)
const userDataDir = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\PDD\\pdd-auth-profile';

// --- 提额任务配置 ---
const PDD_QUOTA_URL = 'https://mms.pinduoduo.com/orders/reportManage?msfrom=mms_sidenav';
const APPLY_REASON = '发货'; 

// --- 报表下载任务配置 ---
const DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\推广_商品数据\\拼多多';
const targetUrlTemplate = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';
const CHECK_PAST_DAYS = 90; // 回溯检查的天数

// 行为模拟配置
const DOWNLOADS_PER_BATCH = 15;
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const LONG_DELAY_MIN_MS = 35000;
const LONG_DELAY_MAX_MS = 65000;
const HUMAN_LIKE_DELAY_MIN_MS = 500; // 提额任务使用
const HUMAN_LIKE_DELAY_MAX_MS = 1500; // 提额任务使用

// --- 数据库和数据处理的全局常量配置 ---
const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
const DB_TABLE_NAME = 'pdd_product_promotion';
const pddPromoNumericColumns = ["花费(元)", "订单数", "成交金额(元)", "投产比", "点击量", "点击率(%)", "千次展现花费(元)"];


// ======================= [辅助函数 - 通用] =======================

function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(` -> 模拟操作，随机等待 ${delay / 1000} 秒...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


// ======================= [提额任务函数] =======================

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

/**
 * 执行拼多多提额任务
 * @param {import('playwright').Page} page - Playwright Page 对象.
 */
async function pddQuotaIncreaseTask(page) {
    console.log('\n--- 🚀 [任务 1/2] 正在执行拼多多提额任务 ---');

    try {
        // --- 步骤 1: 导航到拼多多目标页面 ---
        console.log(`\n➡️ 导航到提额目标页面: ${PDD_QUOTA_URL} (等待 'domcontentloaded')`);
        await page.goto(PDD_QUOTA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); 
        await page.waitForTimeout(3000); // 等待页面内容稳定加载

        // --- 步骤 2: 执行提额操作 ---
        console.log('--- 开始执行提额操作 ---');
        
        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 核心定位器：提额弹窗中的最大提额量提示
        const maxLimitTextLocator = page.locator('div[id="number"]').locator('div.Form_itemHelper_5-164-0').first();
        // 链接定位器
        const tiEButtonLocator = page.locator('div.ReportLimit_contentTip__3e3sT').getByRole('link', { name: '申请今日提额' }).first();
        
        let dialogOpened = false;
        let attempt = 0;
        const maxAttempts = 3;

        console.log('🔍 正在尝试多种方式点击 "申请今日提额" 链接...');

        while (!dialogOpened && attempt < maxAttempts) {
            attempt++;
            try {
                if (attempt === 1) {
                    await tiEButtonLocator.waitFor({ state: 'visible', timeout: 5000 });
                    await tiEButtonLocator.click();
                } else if (attempt === 2) {
                    const elementHandle = await tiEButtonLocator.elementHandle({ timeout: 5000 });
                    if (elementHandle) {
                        await page.evaluate(element => { element.click(); }, elementHandle);
                    } else {
                        throw new Error("Element handle not found for JS click.");
                    }
                } else if (attempt === 3) {
                    const fallbackLocator = page.getByText('申请今日提额', { exact: true }).first();
                    await fallbackLocator.waitFor({ state: 'visible', timeout: 5000 });
                    await fallbackLocator.click({ force: true });
                }
                
                await randomDelay(1000, 2000); 
                
                await maxLimitTextLocator.waitFor({ state: 'visible', timeout: 5000 }); 
                dialogOpened = true;
                console.log(`✅ 第 ${attempt} 次尝试成功！提额对话框已弹出。`);

            } catch (e) {
                console.log(`   -> 第 ${attempt} 次尝试失败，错误: ${e.message.split('\n')[0]}`);
                await randomDelay(1000, 2000); 
            }
        }

        if (!dialogOpened) {
            console.error('❌ 经过多次尝试，提额对话框仍未弹出，跳过提额任务。');
            return;
        }

        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 3. 提取最大提额数字
        const maxLimitText = await maxLimitTextLocator.textContent();
        console.log(`   - 提取到的提示文本: ${maxLimitText.trim()}`);
        const maxQuota = extractFirstNumber(maxLimitText);

        if (!maxQuota || maxQuota <= 0) {
            console.error(`❌ 无法从提示文本中提取到有效的最大提额数字。提取结果: ${maxQuota}，跳过提额任务。`);
            return;
        }
        console.log(`✅ 成功提取到最大可申请提额量: ${maxQuota}`);

        // 4. 找到“申请提额量”的输入框并填入
        const quotaInput = page.locator('div[id="number"] input[data-testid="beast-core-inputNumber-htmlInput"]').first();
        await quotaInput.fill(String(maxQuota)); 
        console.log(`➡️ "申请提额量" 输入框已填入: ${maxQuota}`);

        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 5. 找到“申请理由”的输入框并填入
        const reasonInput = page.locator('div[id="reason"] textarea[data-testid="beast-core-textArea-htmlInput"]').first();
        await reasonInput.fill(APPLY_REASON);
        console.log(`➡️ "申请理由" 输入框已填入: ${APPLY_REASON}`);

        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 6. 点击“提交”按钮 
        const submitButton = page.getByRole('button', { name: '提交' }).last();
        await submitButton.click();
        console.log('✅ 已点击提交按钮。');
        
        await page.waitForTimeout(3000); 

        console.log('\n🎉 拼多多提额流程执行完毕！请检查浏览器中的结果。');

    } catch (error) {
        console.error('❌ 提额任务在执行过程中出错:', error.message);
    }
}


// ======================= [数据库导入函数 (不变)] =======================
async function savePddReportToDatabase(csvPath, dateStr) {
    console.log(`\n--- [数据库导入] 开始处理文件: ${path.basename(csvPath)} ---`);
    let db;
    try {
        db = new Database(CENTRAL_DB_PATH);
        
        const workbook = xlsx.readFile(csvPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        let rawData = xlsx.utils.sheet_to_json(worksheet, { raw: false });

        if (rawData.length === 0) {
            console.log(`文件 [${path.basename(csvPath)}] 数据为空，跳过导入。`);
            return;
        }

        const toNumeric = (val) => {
            if (val === null || val === undefined || val === "-") return null;
            const num = parseFloat(String(val).replace(/[,%]/g, ''));
            return isNaN(num) ? null : num;
        };

        const processedData = rawData.map(row => {
            const finalRow = {};
            for (const key in row) {
                finalRow[key.trim()] = row[key];
            }
            finalRow['统计日期'] = dateStr;
            pddPromoNumericColumns.forEach(col => {
                if (finalRow.hasOwnProperty(col)) {
                   if (col === '点击率(%)') {
                       finalRow[col] = toNumeric(finalRow[col]) / 100;
                   } else {
                       finalRow[col] = toNumeric(finalRow[col]);
                   }
                }
            });
            return finalRow;
        }).filter(row => row['商品ID'] !== '-' && row['统计日期']);

        const currentFileHeaders = Object.keys(processedData[0]);
        const primaryKeys = ['统计日期', '商品ID'].map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));

        const getColumnType = (header) => {
            return pddPromoNumericColumns.includes(header) ? 'REAL' : 'TEXT';
        };

        const tableInfo = db.prepare(`PRAGMA table_info("${DB_TABLE_NAME}")`).all();
        if (tableInfo.length === 0) {
            db.exec(`
                CREATE TABLE "${DB_TABLE_NAME}" (
                    ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `);
            console.log(`数据表 [${DB_TABLE_NAME}] 不存在，已成功创建。`);
        } else {
            const existingColumns = tableInfo.map(col => col.name);
            const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
            if (newHeaders.length > 0) {
                db.transaction(() => {
                    for (const header of newHeaders) {
                        const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                        db.prepare(`ALTER TABLE "${DB_TABLE_NAME}" ADD COLUMN "${sanitizedHeader}" ${getColumnType(header)}`).run();
                    }
                })();
            }
        }

        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        const insertQuery = `
            INSERT INTO "${DB_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
            VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
            ON CONFLICT(${primaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
            ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
        `;
        const insertStmt = db.prepare(insertQuery);

        db.transaction((rows) => {
            for (const row of rows) {
                const dataToInsert = {};
                const sanitizedCurrentRow = {};
                for(const key in row) {
                    sanitizedCurrentRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key];
                }
                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                insertStmt.run(dataToInsert);
            }
        })(processedData);
        
        console.log(`✅ [导入成功] 文件 [${path.basename(csvPath)}] 的 ${processedData.length} 条数据已成功同步至数据库。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理文件 [${path.basename(csvPath)}] 时发生数据库错误:`, e.message);
    } finally {
        if (db) db.close();
    }
}
// ==========================================================


// ======================= [下载任务函数] =======================

/**
 * 扫描目录，获取指定天数内所有已存在的文件日期。
 * @param {string} directory - 要扫描的目录.
 * @param {number} daysAgo - 回溯检查的天数.
 * @returns {Promise<Set<string>>} - 一个包含 'YYYY-MM-DD' 格式日期的集合.
 */
async function getExistingDatesFromFiles(directory, daysAgo) {
    console.log(`正在扫描目录 [${directory}] 以查找最近 ${daysAgo} 天内已下载的文件...`);
    const existingDates = new Set();
    const dateRegex = /(\d{4}-\d{2}-\d{2})/;
    
    // 计算日期范围
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);

    try {
        await fs.mkdir(directory, { recursive: true });
        const files = await fs.readdir(directory);

        for (const file of files) {
            if (file.endsWith('.csv')) {
                const match = file.match(dateRegex);
                if (match) {
                    const fileDate = new Date(match[1]);
                    fileDate.setHours(0, 0, 0, 0);
                    // 确保文件日期在我们的检查范围内
                    if (fileDate >= startDate && fileDate < today) {
                        existingDates.add(formatDate(fileDate));
                    }
                }
            }
        }
        console.log(`扫描完成，在指定范围内共找到 ${existingDates.size} 个已存在的文件日期。`);
        return existingDates;
    } catch (error) {
        console.error(`扫描目录时发生错误: ${error.message}`);
        return existingDates; // 返回空集合
    }
}

/**
 * 执行报表下载和导入任务
 * @param {import('playwright').Page} page - Playwright Page 对象.
 */
async function pddReportDownloadAndImportTask(page) {
    console.log(`\n--- 🔄 [任务 2/2] 正在执行报表下载和数据库导入任务 ---`);

    // 1. 获取范围内“已有”的日期
    const existingDatesSet = await getExistingDatesFromFiles(DOWNLOAD_FOLDER, CHECK_PAST_DAYS);

    // 2. 生成范围内“应有”的日期
    const requiredDates = [];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - CHECK_PAST_DAYS);
    startDate.setHours(0, 0, 0, 0);

    let currentDate = new Date(startDate);
    while (currentDate <= yesterday) {
        requiredDates.push(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    console.log(`理论上应有 ${requiredDates.length} 天的数据 (从 ${formatDate(startDate)} 到 ${formatDate(yesterday)})。`);

    // 3. 对比，计算出“缺失”的日期
    const datesToDownload = requiredDates.filter(date => !existingDatesSet.has(date));


    if (datesToDownload.length === 0) {
        console.log(`✅ 最近 ${CHECK_PAST_DAYS} 天的数据完整，无需下载。`);
        return;
    }

    console.log(`\n发现 ${datesToDownload.length} 个需要下载的报表日期:`);
    console.log(datesToDownload.join(', '));
    console.log('---');

    let downloadCounter = 0;
    const successfulDownloads = []; // 用于存储成功下载的文件信息

    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[处理中] 日期: ${dateStr}`);
            const targetUrl = targetUrlTemplate.replace(/{DATE}/g, dateStr);

            console.log(` -> 导航到: ${targetUrl}`);
            // 使用 page.goto 导航到报表下载页
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            console.log(' -> 页面加载完成，正在查找下载按钮...');

            // 定位下载按钮
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

            successfulDownloads.push({ path: filePath, date: dateStr });

            downloadCounter++;

            if (downloadCounter > 0 && downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                console.log(`\n--- 已连续下载 ${DOWNLOADS_PER_BATCH} 个文件，执行一次长暂停以模拟人类行为 ---`);
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
                console.log('--- 长暂停结束，继续任务 ---\n');
            } else {
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }

        } catch (error) {
            console.error(`❌ [失败] 处理日期 ${dateStr} 时遇到错误: ${error.message}`);
            console.error(' -> 将跳过这个日期，继续下一个。');
        }
    }
    
    console.log('\n--- 所有下载任务已处理完毕！---');

    if (successfulDownloads.length > 0) {
        console.log(`\n--- 开始执行数据库导入，共 ${successfulDownloads.length} 个文件 ---`);
        for (const file of successfulDownloads) {
            await savePddReportToDatabase(file.path, file.date);
        }
        console.log('\n--- 所有文件均已导入数据库 ---');
    }
}


// ======================= [主入口函数] =======================
async function main() {
    console.log(`\n--- 🚀 [ALL-IN-ONE] 启动拼多多综合任务脚本 ---`);

    let context;
    let page;

    try {
        // 检查用户配置目录
        console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
        try { 
            await fs.access(userDataDir); 
        } catch { 
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); 
            console.error('请先成功运行一次本脚本并手动登录，以生成登录配置。');
            return; 
        }
        
        // 使用 launchPersistentContext 启动一次浏览器会话
        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null 
        });
        
        page = context.pages().length ? context.pages()[0] : await context.newPage();
        console.log('✅ 用户配置加载成功！会话已恢复。');

        // 1. 执行提额任务
        await pddQuotaIncreaseTask(page);
        
        // 2. 执行报表下载和数据库导入任务
        await pddReportDownloadAndImportTask(page);

    } catch (error) {
        console.error('❌ 脚本在执行过程中遇到严重错误:', error.message);
    } finally {
        if (context) {
            await context.close(); 
            console.log('\n🔚 浏览器已关闭，脚本所有任务执行结束。');
        }
    }

    console.log('\n🎉 脚本所有任务执行完毕！');
}

main();