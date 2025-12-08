// viomi-download-script.js - 最终修正版 V3 (核心逻辑更新：检查文件内容而非文件名)
// 核心逻辑：
// 1. 检查从2025-01-01到昨天的全部日期，与数据库中已有日期进行比对，找出所有缺失的日期。
// 2. 对于缺失的日期，不再检查文件名，而是扫描下载文件夹中的所有Excel文件。
// 3. 打开每个Excel文件，读取其内容中的真实日期，并建立一个“内容日期 -> 文件路径”的映射。
// 4. 使用此映射来准确判断缺失日期的文件是否存在，并将任务分为“仅导入”和“下载并导入”。
// 5. 先执行所有“仅导入”任务，再启动浏览器执行“下载并导入”任务。

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';

// --- 配置区域 ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;
const DOWNLOAD_DIRECTORY = 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\拼多多';
const DB_FILE = 'Z:\\天猫生意参谋\\TmallDataCenter.db';
const DB_TABLE_NAME = 'pinduoduo_sales_flow';

// --- 函数定义区域 ---

// --- 新增区域 开始 ---
/**
 * 将 Date 对象格式化为 'YYYY-MM-DD' 格式的本地日期字符串，以避免时区问题。
 * @param {Date} date - 需要格式化的日期对象。
 * @returns {string} 'YYYY-MM-DD' 格式的字符串。
 */
function getLocalDateString(date) {
    if (!(date instanceof Date) || isNaN(date)) {
        // 对于无效的日期输入，返回一个空字符串或进行错误处理
        return '';
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // 月份是从0开始的
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


/**
 * 【核心修改】扫描指定目录下的所有 .xlsx 文件，读取其内容，并根据第一行数据的“日期”列建立一个映射。
 * @param {string} directory - 要搜索的文件夹路径。
 * @returns {Map<string, string>} 一个从文件内部日期 ('YYYY-MM-DD') 到其完整文件路径的映射。
 */
function mapFilesByDateContent(directory) {
    const dateToFileMap = new Map();
    console.log(`\n🔍 正在扫描目录 [${directory}] 中的文件内容...`);

    if (!fs.existsSync(directory)) {
        console.log(`⚠️ 目录不存在，无法扫描本地文件。`);
        return dateToFileMap;
    }

    const allFiles = fs.readdirSync(directory).filter(file => file.toLowerCase().endsWith('.xlsx'));
    console.log(`📂 发现 ${allFiles.length} 个 .xlsx 文件，开始逐一解析...`);

    for (const file of allFiles) {
        const filePath = path.join(directory, file);
        try {
            const workbook = xlsx.readFile(filePath);
            if (!workbook.SheetNames.length) {
                console.log(`   - 🟡 文件 [${file}] 为空或格式不正确，已跳过。`);
                continue;
            }

            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            
            // 读取表头和第一行数据
            const header = xlsx.utils.sheet_to_json(worksheet, { header: 1, range: 0 })[0] || [];
            const firstDataRow = xlsx.utils.sheet_to_json(worksheet)[0];

            if (!firstDataRow) {
                console.log(`   - 🟡 文件 [${file}] 没有数据行，已跳过。`);
                continue;
            }

            const dateColumnName = '日期';
            if (!header.includes(dateColumnName) || !firstDataRow[dateColumnName]) {
                 console.log(`   - 🟡 文件 [${file}] 中未找到有效的'日期'列或值，已跳过。`);
                continue;
            }

            const dateValue = firstDataRow[dateColumnName];
            let dateString = '';

            // --- 日期值标准化逻辑 (与 importExcelToDb 保持一致) ---
            if (typeof dateValue === 'number') {
                // 处理Excel的数字格式日期
                const excelEpoch = new Date(1899, 11, 30);
                const jsDate = new Date(excelEpoch.getTime() + dateValue * 24 * 60 * 60 * 1000);
                dateString = getLocalDateString(jsDate);
            } else {
                 // 处理字符串或已为Date对象的日期
                const jsDate = new Date(dateValue);
                dateString = getLocalDateString(jsDate);
            }
            // --- 日期值标准化逻辑 结束 ---

            if (dateString) {
                if (dateToFileMap.has(dateString)) {
                    console.log(`   - ⚠️ 发现内容日期为 [${dateString}] 的重复文件: [${file}]。将使用后者覆盖。`);
                }
                dateToFileMap.set(dateString, filePath);
                 console.log(`   - ✅ 文件 [${file}] 的内容日期解析为: [${dateString}]`);
            } else {
                 console.log(`   - 🔴 文件 [${file}] 中的日期值无法解析，已跳过。`);
            }

        } catch (error) {
            console.error(`   - ❌ 读取或解析文件 [${file}] 时出错: ${error.message}`);
        }
    }
    console.log(`\n🗺️ 文件内容扫描完成，共建立 ${dateToFileMap.size} 个有效日期映射。`);
    return dateToFileMap;
}
// --- 新增区域 结束 ---


/**
 * 从数据库中获取所有已存在的日期
 * @returns {Set<string>} 一个包含 'YYYY-MM-DD' 格式日期的集合
 */
function getAllDatesFromDB() {
    try {
        const db = new Database(DB_FILE, { fileMustExist: true });
        const stmt = db.prepare(`SELECT DISTINCT "日期" FROM ${DB_TABLE_NAME}`);
        const results = stmt.all();
        db.close();
        const dates = new Set(results.map(row => row['日期']));
        console.log(`📈 数据库中目前存在 ${dates.size} 个不重复的日期记录。`);
        return dates;
    } catch (error) {
        console.log('🤔 无法打开数据库或表为空，将视为空白数据库处理。');
        return new Set();
    }
}

/**
 * 生成指定范围内的所有日期字符串
 * @param {Date} start - 开始日期
 * @param {Date} end - 结束日期
 * @returns {string[]} 'YYYY-MM-DD' 格式的日期数组
 */
function generateDateRange(start, end) {
    const dates = [];
    let currentDate = new Date(start);
    while (currentDate <= end) {
        // --- 修改区域 开始：使用新的辅助函数以避免时区问题 ---
        dates.push(getLocalDateString(currentDate)); // 原代码: currentDate.toISOString().slice(0, 10)
        // --- 修改区域 结束 ---
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
}


// --- 修改区域：删除旧的 findExistingFiles 函数 ---
// function findExistingFiles(directory, dates) { ... } // <- 整段函数定义已删除
// --- 修改区域 结束 ---


async function importExcelToDb(filePath) {
    console.log(`🔄 正在准备导入文件: ${path.basename(filePath)}`);
    try {
        const db = new Database(DB_FILE); const workbook = xlsx.readFile(filePath); const sheetName = workbook.SheetNames[0]; const worksheet = workbook.Sheets[sheetName]; const data = xlsx.utils.sheet_to_json(worksheet);
        if (data.length === 0) { console.log('⚠️ 文件为空，无需导入。'); db.close(); return true; }
        const columns = Object.keys(data[0]); const placeholders = columns.map(() => '?').join(', '); const columnNames = columns.map(col => `"${col}"`).join(', ');
        const insertStmt = db.prepare(`INSERT INTO ${DB_TABLE_NAME} (${columnNames}) VALUES (${placeholders})`);
        const insertMany = db.transaction((rows) => {
            for (const row of rows) {
                const values = columns.map(col => row[col]); const dateIndex = columns.indexOf('日期');
                if (dateIndex !== -1 && values[dateIndex]) {
                    // --- 修改区域 开始：使用新的辅助函数处理日期转换，避免时区问题 ---
                    if (typeof values[dateIndex] === 'number') {
                        const excelEpoch = new Date(1899, 11, 30); 
                        const jsDate = new Date(excelEpoch.getTime() + values[dateIndex] * 24 * 60 * 60 * 1000); 
                        values[dateIndex] = getLocalDateString(jsDate); 
                    } else { 
                        values[dateIndex] = getLocalDateString(new Date(values[dateIndex])); 
                    }
                    // --- 修改区域 结束 ---
                }
                insertStmt.run(...values);
            }
        });
        insertMany(data); console.log(`✅ 成功导入 ${data.length} 条数据到数据库。`); db.close(); return true;
    } catch (error) { console.error(`❌ 文件导入数据库时出错: ${error}`); return false; }
}

async function clearDownloadList(page) {
    console.log('🗑️ 正在清空下载列表...');
    const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15 C2.790861,15"])');
    await downloadManagerIcon.click();
    await page.waitForTimeout(500);
    const deleteButtonLocator = page.getByRole('button', { name: 'delete' });
    while (await deleteButtonLocator.count() > 0) {
        await deleteButtonLocator.first().click();
        await page.waitForTimeout(500); 
    }
    console.log('✅ 下载列表已清空。');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
}

async function downloadReportForDate(page, reportDate) {
    console.log(`\n--- 开始下载日期: ${reportDate} ---`);
    try {
        await clearDownloadList(page);
        console.log(`➡️ 正在为日期 [${reportDate}] 生成报表...`);
        const startDatePicker = page.locator('div.ant-picker').first();
        const startDateInput = startDatePicker.locator('input');
        const startClearButton = startDatePicker.locator('span.ant-picker-clear');
        if (await startClearButton.isVisible({ timeout: 2000 })) { await startClearButton.click(); }
        await startDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await startDateInput.fill(reportDate);
        const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
        await visiblePanelStart.locator(`td[title="${reportDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });
        console.log(`  -> 设置开始日期为: ${reportDate}`);
        const endDatePicker = page.locator('div.ant-picker').nth(1);
        const endDateInput = endDatePicker.locator('input');
        const endClearButton = endDatePicker.locator('span.ant-picker-clear');
        if (await endClearButton.isVisible({ timeout: 2000 })) { await endClearButton.click(); }
        await endDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await endDateInput.fill(reportDate);
        const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
        await visiblePanelEnd.locator(`td[title="${reportDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });
        console.log(`  -> 设置结束日期为: ${reportDate}`);
        const reportCard = page.locator('div.container--r3tGG').filter({ hasText: '拼多多商品销售流量' });
        await page.getByRole('button', { name: '查 询' }).click();
        await reportCard.waitFor({ state: 'visible', timeout: 60000 });
        await reportCard.hover();
        const downloadTriggerIcon = reportCard.getByLabel('download').nth(1);
        await downloadTriggerIcon.click();
        console.log('✅ 已启动后台文件生成。');
        console.log('⏸️ 等待 3 秒，让后台任务先行处理...');
        await page.waitForTimeout(3000);
        console.log('🔄 正在刷新页面以获取最新任务状态...');
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
        console.log('✅ 页面刷新完成。');
        console.log('➡️ 打开下载管理，检查任务状态...');
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15 C2.790861,15"])');
        await downloadManagerIcon.click();
        const firstEntry = page.locator('li[class^="item--"]').first();
        await firstEntry.waitFor({ state: 'visible', timeout: 10000 });
        console.log('⏳ 正在等待报表生成成功（最大等待1分钟）...');
        const successLocator = firstEntry.locator('span.ant-tag:text("成功")');
        await successLocator.waitFor({ state: 'visible', timeout: 60000 });
        console.log('✅ 报表已生成成功！');
        const finalDownloadLink = firstEntry.locator('p[class^="success--"]');
        const linkText = await finalDownloadLink.textContent();
        console.log(`✅ 已找到可下载的目标文件链接: ${linkText}`);
        console.log('🔗 准备点击链接并捕获下载...');
        const downloadPromise = page.waitForEvent('download');
        const popupPromise = page.waitForEvent('popup').catch(e => e);
        await finalDownloadLink.click();
        const download = await downloadPromise;
        const popup = await popupPromise;
        console.log('✅ 下载事件已捕获!');
        if (popup instanceof page.constructor && !popup.isClosed()) {
            await popup.close();
        }
        if (!fs.existsSync(DOWNLOAD_DIRECTORY)) { fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true }); }
        const suggestedFileName = download.suggestedFilename();
        const filePath = path.join(DOWNLOAD_DIRECTORY, suggestedFileName);
        await download.saveAs(filePath);
        console.log(`🎉 表格已成功下载到: ${filePath}`);
        await page.keyboard.press('Escape');
        return { success: true, savePath: filePath };

    } catch (error) {
        console.error(`❌ 下载日期 [${reportDate}] 的报告时失败:`, error);
        return { success: false, savePath: null };
    }
}

async function main() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) { console.error('错误：请先设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。'); process.exit(1); }
    
    console.log('--- 任务初始化：正在检查数据完整性 ---');
    
    const startDate = new Date('2024-10-01');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const requiredDates = generateDateRange(startDate, yesterday);
    console.log(`🗓️ 需要检查的日期范围: ${requiredDates[0]} 到 ${requiredDates[requiredDates.length - 1]}`);

    const existingDatesInDb = getAllDatesFromDB();

    const missingDates = requiredDates.filter(date => !existingDatesInDb.has(date));

    if (missingDates.length === 0) {
        console.log('👍 数据库中的数据已是最新且完整，无需执行任何任务。脚本执行完毕。');
        return;
    }
    console.log(`\n❗️ 在数据库中发现 ${missingDates.length} 个缺失的日期: [${missingDates.join(', ')}]`);

    // --- 修改区域 开始：调用新的核心函数，通过文件内容来查找匹配的文件 ---
    // 5. 检查本地文件中，有哪些文件的内容日期是我们需要的
    const localFileDateMap = mapFilesByDateContent(DOWNLOAD_DIRECTORY);
    // --- 修改区域 结束 ---
    
    const tasksToImportOnly = [];
    const tasksToDownload = [];

    for (const date of missingDates) {
        // --- 修改区域 开始：使用新的映射来分配任务 ---
        if (localFileDateMap.has(date)) {
            tasksToImportOnly.push(localFileDateMap.get(date));
        } else {
            tasksToDownload.push(date);
        }
        // --- 修改区域 结束 ---
    }

    // --- 任务分配与执行 ---
    
    if (tasksToImportOnly.length > 0) {
        console.log(`\n--- 步骤 A: 执行仅导入任务 (${tasksToImportOnly.length} 个) ---`);
        console.log(`   - 待导入文件: [${tasksToImportOnly.map(p => path.basename(p)).join(', ')}]`);
        for (const filePath of tasksToImportOnly) {
            await importExcelToDb(filePath);
        }
        console.log('✅ 所有仅导入任务已完成。');
    } else {
        console.log('\nℹ️ 没有在本地发现内容日期匹配的、可直接导入的文件。');
    }

    if (tasksToDownload.length === 0) {
        console.log('\n👍 所有缺失数据均已通过本地文件补齐，无需下载。脚本执行完毕。');
        return;
    }

    console.log(`\n--- 步骤 B: 执行下载并导入任务 (${tasksToDownload.length} 个) ---`);
    console.log(`   - 待下载日期: [${tasksToDownload.join(', ')}]`);

    console.log('\n🚀 正在启动浏览器...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log('✅ 浏览器启动成功。');

    try {
        console.log('➡️ 正在登录系统...');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=833');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForURL(/.*dashboard.*/, { timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 60000 });
        console.log('✅ 登录成功，页面已加载。');
        
        console.log('\n➡️ 开始按序执行下载任务...');
        for (const dateString of tasksToDownload) {
            const downloadResult = await downloadReportForDate(page, dateString);
            if (downloadResult.success && downloadResult.savePath) {
                await importExcelToDb(downloadResult.savePath);
                // (可选) 可以在此删除已成功导入的文件: fs.unlinkSync(downloadResult.savePath);
            } else {
                console.error(`❗ 日期 [${dateString}] 的任务处理失败，将继续下一个任务...`);
            }
        }
        console.log('\n✅ 所有下载任务执行完毕。');

    } catch (error) {
        console.error('❌ 脚本在主流程中执行出错:', error);
    } finally {
        await browser.close();
        console.log('🔚 浏览器已关闭，脚本执行结束。');
    }
}

// 运行主函数
main();