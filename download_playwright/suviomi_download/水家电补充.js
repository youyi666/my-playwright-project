// viomi-download-script-monthly.js - 【v17 - 固定范围批量下载版】
// v17 更新：
// 1. [核心逻辑变更] 新增 createFixedRangeTasks 函数，用于生成一个从 2023-03 到 2025-08 的硬编码任务列表。
// 2. [移除] 移除了所有动态计算月份的逻辑（如检查数据库、获取上个月等）。
// 3. [保留] 下载流程中筛选“产品公司”为“水家电”的功能保持不变。

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';

// --- 配置区域 (参照 Python 脚本) ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;
const DOWNLOAD_DIRECTORY = 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\渠道品类流量分布-多表版';
const DATABASE_PATH = 'Z:\\sky.viomi.com.cn\\运营分析\\suviom2.db';

// 主键规则定义 (从 Python 脚本翻译而来)
// 这个对象的顺序现在至关重要，它定义了Excel中工作表的处理顺序
const PRIMARY_KEY_RULES = {
    "1商品概况": ["月份"],
    "2交易流量趋势": ["日期"],
    "3访客数分布": ["月份", "渠道类型"],
    "4支付用户数分布": ["月份", "渠道类型"],
    "5支付金额分布": ["月份", "渠道类型"],
    "6支付件数分布": ["月份", "渠道类型"],
    "7销售流量分布": ["月份", "渠道类型"],
    "8转化率分布": ["月份", "渠道类型"],
    "9类目销售流量分布": ["月份", "产品公司"],
    "10销售额TOP20": ["日期", "渠道类型","平台商品id"],
    "11渠道品类流量分布": ["日期", "渠道类型","类目"],
};

// --- 函数定义区域 ---

/**
 * 清理工作表名称，使其成为一个合法的SQL表名
 * @param {string} sheetName - 原始工作表名
 * @returns {string} 清理后的表名
 */
function cleanTableName(sheetName) {
    let name = sheetName.trim();
    name = name.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '_');
    return name;
}

/**
 * 一个不受时区影响的日期格式化函数
 * @param {Date} date - 日期对象
 * @returns {string} 'YYYY-MM-DD' 格式的字符串
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 扫描下载目录，将所有已存在的Excel文件导入数据库
 */
async function scanAndImportExistingFiles() {
    console.log(`\n--- 步骤 A: 开始扫描本地目录 [${DOWNLOAD_DIRECTORY}] 并导入数据 ---`);
    if (!fs.existsSync(DOWNLOAD_DIRECTORY)) {
        console.log('⚠️ 本地下载目录不存在，跳过扫描步骤。');
        fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true });
        return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIRECTORY);
    const excelFiles = files.filter(file => file.endsWith('.xlsx'));

    if (excelFiles.length === 0) {
        console.log('✅ 目录中没有找到已存在的Excel文件。');
        return;
    }

    console.log(`🔍 发现 ${excelFiles.length} 个Excel文件，准备导入数据库...`);
    for (const file of excelFiles) {
        const filePath = path.join(DOWNLOAD_DIRECTORY, file);
        await importDataLikePython(filePath);
    }
    console.log('✅ 所有本地Excel文件已处理完毕。');
}


// --- 新增函数 (按您的最终要求写死日期范围) ---
/**
 * [新增] 创建一个固定日期范围的下载任务列表 (2023-03 to 2025-08)
 * @returns {Array<object>} 包含指定范围内所有月份任务的数组
 */
function createFixedRangeTasks() {
    console.log('📅 正在为固定范围 [2023-03 to 2025-08] 生成下载任务列表...');
    
    const tasks = [];
    const startDate = new Date('2023-03-01');
    const endDate = new Date('2025-08-01');

    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth() + 1;
        
        const firstDay = new Date(year, month - 1, 1);
        const lastDay = new Date(year, month, 0); // 获取下个月的第0天即为本月最后一天

        tasks.push({
            year,
            month,
            startDate: formatDate(firstDay),
            endDate: formatDate(lastDay),
        });

        // 移动到下一个月
        currentDate.setMonth(currentDate.getMonth() + 1);
    }
    
    console.log(`✅ 任务列表已生成，共计 ${tasks.length} 个任务。`);
    return tasks;
}
// --- 函数新增结束 ---


/**
 * [已重构] 将多表Excel数据追加到数据库，此版本按工作表顺序处理，忽略其实际名称。
 * @param {string} filePath - Excel文件路径
 * @returns {Promise<boolean>}
 */
async function importDataLikePython(filePath) {
    console.log(`\n🔄 [数据导入] 正在处理文件: ${path.basename(filePath)} (按顺序模式)`);
    try {
        const workbook = xlsx.readFile(filePath);
        
        const trendSheetName = workbook.SheetNames[1]; 
        if (!trendSheetName) {
            console.error(`❌ 文件 [${path.basename(filePath)}] 的工作表数量不足2个，无法提取月份信息，导入失败。`);
            return false;
        }
        const trendSheet = workbook.Sheets[trendSheetName];
        const trendData = xlsx.utils.sheet_to_json(trendSheet);
        
        let monthStr = null;
        for (const row of trendData) {
            const dateText = row['日期'];
            if (dateText && typeof dateText === 'string' && dateText.match(/^\d{4}-\d{2}-\d{2}$/)) {
                monthStr = dateText.slice(0, 7);
                break;
            }
        }

        if (!monthStr) {
            console.error(`❌ 在第二个工作表中未找到任何有效的 'YYYY-MM-DD' 格式日期，导入失败。`);
            return false;
        }
        console.log(`  > 提取到文件月份: ${monthStr}`);

        const db = new Database(DATABASE_PATH);
        const ruleKeys = Object.keys(PRIMARY_KEY_RULES);

        for (let i = 0; i < workbook.SheetNames.length; i++) {
            const originalSheetName = workbook.SheetNames[i];
            const targetSheetName = ruleKeys[i];

            if (!targetSheetName) {
                console.log(`  - 警告：文件中的第 ${i + 1} 个工作表 ('${originalSheetName}') 没有对应的处理规则，已跳过。`);
                continue;
            }

            const pkFields = PRIMARY_KEY_RULES[targetSheetName];
            if (!pkFields) { 
                console.log(`  - 工作表 #${i + 1} ('${originalSheetName}') 对应的规则 '${targetSheetName}' 未找到主键定义，跳过。`);
                continue;
            }
            
            const tableName = cleanTableName(targetSheetName);
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[originalSheetName]);

            if (data.length === 0) {
                console.log(`  - 工作表 #${i + 1} ('${originalSheetName}') 为空，跳过。`);
                continue;
            }
            console.log(`  - 正在处理第 ${i + 1} 个工作表 ('${originalSheetName}') -> 目标表: "${tableName}"...`);
            
            if (pkFields.includes("月份")) {
                data.forEach(row => row['月份'] = monthStr);
            }

            const tableInfo = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
            if (!tableInfo) {
                const columns = Object.keys(data[0]);
                const createTableColumns = columns.map(col => `"${col}" TEXT`).join(', ');
                const primaryKeyClause = `PRIMARY KEY (${pkFields.map(f => `"${f}"`).join(', ')})`;
                const createQuery = `CREATE TABLE "${tableName}" (${createTableColumns}, ${primaryKeyClause})`;
                db.exec(createQuery);
                console.log(`    - 表 "${tableName}" 不存在，已自动创建并设置主键: (${pkFields.join(', ')})。`);
            }

            const columns = Object.keys(data[0]);
            const placeholders = columns.map(() => '?').join(', ');
            const columnNames = columns.map(col => `"${col}"`).join(', ');
            const insertStmt = db.prepare(`INSERT OR REPLACE INTO "${tableName}" (${columnNames}) VALUES (${placeholders})`);
            
            const insertMany = db.transaction((rows) => {
                for (const row of rows) {
                    const values = columns.map(col => row[col]);
                    insertStmt.run(...values);
                }
            });

            insertMany(data);
            console.log(`    👍 成功同步 ${data.length} 条数据。`);
        }
        db.close();
        return true;
    } catch (error) {
        console.error(`❌ [数据导入] 文件处理失败: ${error}`);
        if(error.message.includes('UNIQUE constraint failed')){
             console.error('   > 错误提示：这通常是因为您修改了主键规则，但数据库中仍是旧结构。请考虑删除旧的 .db 文件后重试。');
        }
        return false;
    }
}

async function clearDownloadList(page) {
    console.log('🗑️ 正在清空下载列表...');
    try {
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
    } catch (error) {
        console.warn(`⚠️ 清空下载列表时出现轻微错误 (可能列表已为空): ${error.message}`);
        if (page && !page.isClosed()) {
            await page.keyboard.press('Escape').catch(() => {});
        }
    }
}


async function downloadReportForMonth(page, task) {
    console.log(`\n--- 开始下载月份: ${task.year}-${String(task.month).padStart(2, '0')} ( ${task.startDate} to ${task.endDate} ) ---`);
    try {
        await clearDownloadList(page);

        console.log('🔄 正在刷新页面以确保状态干净...');
        await page.reload({ waitUntil: 'networkidle' });
        console.log('✅ 页面已刷新。');

        console.log(`➡️ 正在为月份 [${task.year}-${task.month}] 设置日期...`);
        
        const startDatePicker = page.locator('div.ant-picker').first();
        const startDateInput = startDatePicker.locator('input');
        const startClearButton = startDatePicker.locator('span.ant-picker-clear');
        if (await startClearButton.isVisible({ timeout: 5000 })) { await startClearButton.click(); }
        await startDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await startDateInput.fill(task.startDate);
        const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
        await visiblePanelStart.locator(`td[title="${task.startDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

        const endDatePicker = page.locator('div.ant-picker').nth(1);
        const endDateInput = endDatePicker.locator('input');
        const endClearButton = endDatePicker.locator('span.ant-picker-clear');
        if (await endClearButton.isVisible({ timeout: 5000 })) { await endClearButton.click(); }
        await endDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await endDateInput.fill(task.endDate);
        const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
        await visiblePanelEnd.locator(`td[title="${task.endDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });
        
        // --- [保留功能] 筛选产品公司 ---
        console.log('➡️ 正在筛选产品公司为“水家电”...');
        try {
            const productCompanyFilter = page.locator('div.ant-form-item:has-text("产品公司")');
            await productCompanyFilter.locator('div.ant-select-selector').click();
            await page.locator('div.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ state: 'visible', timeout: 5000 });
            await productCompanyFilter.locator('input.ant-select-selection-search-input').fill('水家电');
            
            const option = page.locator('div.ant-select-item-option-content', { hasText: '水家电' });
            await option.waitFor({ state: 'visible', timeout: 5000 });
            await option.click();
            console.log('✅ 已成功选择“水家电”。');
            
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
        } catch (filterError) {
            console.error('❌ 筛选“产品公司”时发生错误! 请检查页面元素或网络状态。将跳过此任务。');
            console.error(filterError);
            return { success: false, savePath: null };
        }
        // --- 筛选功能结束 ---
        
        await page.getByRole('button', { name: '查 询' }).first().click();
        console.log('➡️ 正在点击全局下载按钮...');
        const globalDownloadButton = page.getByRole('button', { name: 'download' }).first();
        await globalDownloadButton.click();
        
        console.log('➡️ 等待确认对话框...');
        const confirmButton = page.getByRole('button', { name: '确 定' });
        await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
        await confirmButton.click();
        console.log('✅ 已启动后台文件生成。');
        
        console.log('➡️ 打开下载管理，等待任务完成...');
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15 C2.790861,15"])');
        await downloadManagerIcon.click();
        
        const firstEntry = page.locator('li[class^="item--"]').first();
        await firstEntry.waitFor({ state: 'visible', timeout: 180000 });

        console.log('⏳ 正在等待报表生成成功...');
        const successLocator = firstEntry.locator('span.ant-tag:text("成功")');
        await successLocator.waitFor({ state: 'visible', timeout: 180000 });
        console.log('✅ 报表已生成成功！');

        const finalDownloadLink = firstEntry.locator('p[class^="success--"]');
        const linkText = await finalDownloadLink.textContent();
        console.log(`✅ 已找到可下载的目标文件链接: ${linkText}`);
        
        const downloadPromise = page.waitForEvent('download');
        await finalDownloadLink.click();
        const download = await downloadPromise;
        console.log('✅ 下载事件已捕获!');
        
        if (!fs.existsSync(DOWNLOAD_DIRECTORY)) { fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true }); }
        const suggestedFileName = download.suggestedFilename();
        const filePath = path.join(DOWNLOAD_DIRECTORY, suggestedFileName);
        await download.saveAs(filePath);
        console.log(`🎉 表格已成功下载到: ${filePath}`);

        await page.keyboard.press('Escape');
        return { success: true, savePath: filePath };

    } catch (error) {
        console.error(`❌ 下载月份 [${task.year}-${task.month}] 的报告时失败:`, error);
        return { success: false, savePath: null };
    }
}

async function main() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
        console.error('错误：请先设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。');
        process.exit(1);
    }
    
    await scanAndImportExistingFiles();

    // --- 代码修改区域: 变更任务生成逻辑 ---
    console.log('\n--- 步骤 B: 开始为固定日期范围生成下载任务 ---');
    const monthlyTasks = createFixedRangeTasks();
    // --- 修改结束 ---

    if (monthlyTasks.length === 0) {
        console.log('\n未能生成下载任务。脚本执行完毕。');
        return;
    }
    
    console.log('\n--- 步骤 C: 准备启动浏览器执行批量下载任务 ---');
    
    console.log('🚀 正在启动浏览器...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log('✅ 浏览器启动成功。');

    try {
        console.log('➡️ 步骤 D: 正在登录系统...');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=857');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForURL(/.*dashboard.*/, { timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 60000 });
        console.log('✅ 登录成功，页面已加载。');
        
        console.log('➡️ 步骤 E: 开始按序执行月度下载任务...');
        for (const task of monthlyTasks) {
            const downloadResult = await downloadReportForMonth(page, task);
            if (downloadResult.success && downloadResult.savePath) {
                await importDataLikePython(downloadResult.savePath);
            } else {
                console.error(`❗ 月份 [${task.year}-${task.month}] 的任务处理失败，将继续下一个任务...`);
            }
        }
        console.log('✅ 所有下载任务执行完毕。');

    } catch (error) {
        console.error('❌ 脚本在主流程中执行出错:', error);
    } finally {
        await browser.close();
        console.log('🔚 浏览器已关闭，脚本执行结束。');
    }
}

// 运行主函数
main();