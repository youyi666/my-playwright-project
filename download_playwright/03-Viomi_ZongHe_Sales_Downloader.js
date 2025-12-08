// viomi-download-script-daily.js - 【v15 - 按顺序处理工作表最终版 - 日度下载版】
// v15 更新：
// 1. [核心] 重构数据导入逻辑，不再依赖工作表名称，而是严格按其在文件中的顺序进行处理和映射，极大提升了脚本的健壮性。
// 2. 月份提取逻辑同步更新，固定读取第二个工作表，与名称解耦。
// v14 更新：
// 1. 重构主流程：脚本启动后先扫描本地目录，将所有已存在的Excel文件导入数据库。
// 2. 增强数据库逻辑：在创建表时，严格根据规则设置主键，并使用UPSERT(INSERT OR REPLACE)逻辑防止数据重复。
// 3. 优化执行：只有在本地文件全部入库后，依然发现有缺失的月份时，才会启动浏览器进行下载。

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';
import { fileURLToPath } from 'url'; // [改动 1.1] 新增 import

// --------------------------- [ESM 兼容性修改 - 开始] ---------------------------
// [改动 1.2] 定义 __filename 和 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --------------------------- [ESM 兼容性修改 - 结束] ---------------------------


// --- 配置区域 (参照 Python 脚本) ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// [改动 2.1: 下载目录 - 相对路径]
// 原始: const DOWNLOAD_DIRECTORY = 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\渠道品类流量分布-多表版';
const DOWNLOAD_DIRECTORY = path.join(__dirname, 'exc_data', '平台获取-商品销售流量', '渠道品类流量分布-多表版');

// [改动 2.2: 数据库路径 - 相对路径]
// 原始: const DATABASE_PATH = 'Z:\\sky.viomi.com.cn\\运营分析\\suviom2.db';
const DATABASE_PATH = path.join(__dirname, 'sql_data', 'suviom2.db');

// [改动 2.3: 新增归档目录配置]
const ARCHIVE_DIRECTORY = path.join(DOWNLOAD_DIRECTORY, '已导入'); 

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
    // 移除名称前后的空格，增强鲁棒性
    let name = sheetName.trim();
    // 移除数字前缀，如 "1商品概况" -> "商品概况"
    // name = name.replace(/^\d+[-_]?/, '');
    // 将所有非法字符替换为下划线
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
 * [改动 3: 新增归档函数] 移动文件到归档目录
 * @param {string} sourcePath - 源文件路径.
 * @param {string} archiveDir - 目标归档目录.
 * @param {string} [newFileName] - 可选，指定归档后的新文件名.
 */
async function moveFileToArchive(sourcePath, archiveDir, newFileName = null) {
    console.log(' -> 正在执行文件归档操作...');
    try {
        // 确保目录存在
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
            console.log(` -> 归档目录 [${path.basename(archiveDir)}] 不存在，已创建。`);
        }
        
        const fileName = newFileName || path.basename(sourcePath); 
        const destPath = path.join(archiveDir, fileName);
        
        // 使用 fs.promises.rename 进行异步文件移动
        await fs.promises.rename(sourcePath, destPath); 
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        console.error(`❌ 文件归档失败 (${path.basename(sourcePath)}): ${e.message}`);
    }
}


/**
 * [新增] 扫描下载目录，将所有已存在的Excel文件导入数据库
 */
async function scanAndImportExistingFiles() {
    console.log(`\n--- 步骤 A: 开始扫描本地目录 [${DOWNLOAD_DIRECTORY}] 并导入数据 ---`);
    if (!fs.existsSync(DOWNLOAD_DIRECTORY)) {
        console.log('⚠️ 本地下载目录不存在，跳过扫描步骤。');
        fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true });
        return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIRECTORY);
    // 仅处理 Excel 文件，且排除归档目录下的文件
    const excelFiles = files.filter(file => 
        file.endsWith('.xlsx') && path.resolve(path.join(DOWNLOAD_DIRECTORY, file)) !== path.resolve(ARCHIVE_DIRECTORY)
    );

    if (excelFiles.length === 0) {
        console.log('✅ 目录中没有找到已存在的Excel文件。');
        return;
    }

    console.log(`🔍 发现 ${excelFiles.length} 个Excel文件，准备导入数据库...`);
    for (const file of excelFiles) {
        const filePath = path.join(DOWNLOAD_DIRECTORY, file);
        const importSuccess = await importDataLikePython(filePath);
        
        // [改动 3.1: 导入成功后执行归档]
        if (importSuccess) {
             await moveFileToArchive(filePath, ARCHIVE_DIRECTORY);
        } else {
             console.warn(`⚠️ 文件 [${file}] 导入数据库失败，跳过归档。`);
        }
    }
    console.log('✅ 所有本地Excel文件已处理完毕。');
}


/**
 * [修改] 检查数据库，计算并生成缺失日期的下载任务
 * @returns {Promise<Array<object>>}
 */
// --- 日度修改点 1: 函数更名和逻辑重构为日度检查 ---
async function getMissingDailyTasks() {
    console.log('🔍 开始计算需要下载的缺失日期...');
    
    const allTargetDates = new Set();
    const startDate = new Date('2025-10-01'); // --- 日度修改点 2: 起始日期修改 ---
    const today = new Date();
    // 确保时区无关，并将 today 设为今天的开始（0点）
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1); // 检查到昨天为止

    let currentDate = new Date(startDate);
    // 循环直到昨天
    while (currentDate <= yesterday) {
        allTargetDates.add(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1); // 按天步进
    }
    const targetDatesArray = Array.from(allTargetDates).sort();
    const lastTargetDate = targetDatesArray.length > 0 ? targetDatesArray[targetDatesArray.length - 1] : 'N/A';
    console.log(`📈 理论上需要下载 ${targetDatesArray.length} 个日期的数据 (到 ${lastTargetDate} 为止)。`);

    let existingDates = new Set();
    // 关键：确保数据库目录存在，否则 new Database 会报错
    fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
    const db = new Database(DATABASE_PATH, { fileMustExist: false });

    // 检查一个包含“日期”作为主键的表。
    const checkTableNameRule = "10销售额TOP20"; 
    const checkTableName = cleanTableName(checkTableNameRule);
    try {
        const tableInfo = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(checkTableName);
        
        if (tableInfo) {
            // 查询“日期”字段而不是“月份”
            const rows = db.prepare(`SELECT DISTINCT "日期" FROM "${checkTableName}" WHERE "日期" >= ? ORDER BY "日期"`).all(formatDate(startDate));
            rows.forEach(row => existingDates.add(row['日期']));
            console.log(`✅ 数据库中表 "${checkTableName}" 已存在 ${existingDates.size} 个日期的数据。`);
        } else {
            console.log(`🤔 在数据库中未找到目标表 "${checkTableName}"，将尝试下载所有理论日期。`);
        }
    } catch (e) {
        console.warn(`⚠️ 无法读取数据库或表 "${checkTableName}"，将尝试下载所有理论日期。错误: ${e.message}`);
    } finally {
        db.close();
    }


    const missingDates = targetDatesArray.filter(date => !existingDates.has(date));

    if (missingDates.length === 0) {
        console.log('👍 所有日期的数据均已存在，无需下载。');
        return [];
    }
    console.log(`🗓️ 计算完成，发现 ${missingDates.length} 个缺失的日期需要下载: [${missingDates.join(', ')}]`);

    // 为每个缺失日期创建一个任务，start/end date 相同
    const tasks = missingDates.map(dateStr => {
        return {
            date: dateStr,
            startDate: dateStr,
            endDate: dateStr, // 日报的开始和结束日期相同
        };
    });
    return tasks;
}

// --- MODIFICATION START ---
/**
 * [已重构] 将多表Excel数据追加到数据库，此版本按工作表顺序处理，忽略其实际名称。
 * @param {string} filePath - Excel文件路径
 * @returns {Promise<boolean>}
 */
async function importDataLikePython(filePath) {
    console.log(`\n🔄 [数据导入] 正在处理文件: ${path.basename(filePath)} (按顺序模式)`);
    try {
        const workbook = xlsx.readFile(filePath);
        
        // --- 提取月份/日期逻辑（按顺序） ---
        // 固定从第十个工作表（索引为9）提取日期信息，因为这是销售额TOP20表，包含“日期”列
        const trendSheetName = workbook.SheetNames[9]; 
        if (!trendSheetName) {
            console.error(`❌ 文件 [${path.basename(filePath)}] 的工作表数量不足10个，无法提取日期/月份信息，导入失败。`);
            return false;
        }
        const trendSheet = workbook.Sheets[trendSheetName];
        const trendData = xlsx.utils.sheet_to_json(trendSheet);
        
        let monthStr = null;
        let dateStr = null; // --- 日度修改点 3: 增加 dateStr 变量用于日度表 ---
        for (const row of trendData) {
            const dateText = row['日期'];
            if (dateText && typeof dateText === 'string' && dateText.match(/^\d{4}-\d{2}-\d{2}$/)) {
                monthStr = dateText.slice(0, 7);
                dateStr = dateText; // 提取具体的日期
                break;
            }
        }

        if (!monthStr) {
            console.error(`❌ 在第十个工作表中未找到任何有效的 'YYYY-MM-DD' 格式日期，导入失败。`);
            return false;
        }
        console.log(`  > 提取到文件日期: ${dateStr} (月份: ${monthStr})`); // 打印日期和月份

        const db = new Database(DATABASE_PATH);
        // 获取规则的有序列表，用于按顺序映射
        const ruleKeys = Object.keys(PRIMARY_KEY_RULES);

        // --- 按工作表顺序循环并导入数据 ---
        for (let i = 0; i < workbook.SheetNames.length; i++) {
            const originalSheetName = workbook.SheetNames[i]; // Excel中的原始名称（仅供读取数据）
            const targetSheetName = ruleKeys[i]; // 我们根据顺序指定的目标名称（用于所有逻辑）

            // 如果Excel中的工作表数量多于我们定义的规则数量，则跳过后续的
            if (!targetSheetName) {
                console.log(`  - 警告：文件中的第 ${i + 1} 个工作表 ('${originalSheetName}') 没有对应的处理规则，已跳过。`);
                continue;
            }

            const pkFields = PRIMARY_KEY_RULES[targetSheetName];
            // 理论上 targetSheetName 存在，pkFields 就一定存在，这是一个安全检查
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
            
            // --- 日度修改点 4: 确保日度/月度字段的填充 ---
            if (pkFields.includes("月份")) {
                data.forEach(row => row['月份'] = monthStr);
            }
            if (pkFields.includes("日期")) {
                // 如果主键包含“日期”，则用提取到的具体日期填充所有行
                data.forEach(row => row['日期'] = dateStr); 
            }
            // 确保没有主键，但数据中没有日期或月份的表，不会被强制添加
            // 经检查，所有表要么有日期，要么有月份作为主键或日期字段。此逻辑应保持稳健。


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
// --- MODIFICATION END ---


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


/**
 * [修改] 下载日度报表
 * @param {object} task - 包含 date, startDate, endDate 的任务对象
 */
// --- 日度修改点 5: 函数更名为 downloadReportForDay ---
async function downloadReportForDay(page, task) {
    console.log(`\n--- 开始下载日期: ${task.date} ( ${task.startDate} to ${task.endDate} ) ---`);
    try {
        await clearDownloadList(page);

        console.log('🔄 正在刷新页面以确保状态干净...');
        await page.reload({ waitUntil: 'networkidle' });
        console.log('✅ 页面已刷新。');

        console.log(`➡️ 正在为日期 [${task.date}] 设置日期并生成报表...`);
        
        // 由于 startDate 和 endDate 相同，只需设置一次日期
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

        // 设置结束日期 (与开始日期相同)
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
        
        await page.getByRole('button', { name: '查 询' }).first().click();
        console.log('➡️ 正在点击全局下载按钮...');
        const globalDownloadButton = page.getByRole('button', { name: 'download' }).first();
        await globalDownloadButton.click();
        
        console.log('➡️ 等待确认对话框...');
        const confirmButton = page.getByRole('button', { name: '确 定' });
        await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
        await confirmButton.click();
        console.log('✅ 已启动后台文件生成。');
        console.log('⏸️ 等待 3 秒，让后台任务先行处理...');
        await page.waitForTimeout(3000);
        console.log('🔄 正在刷新页面以获取最新任务状态...');
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
        console.log('✅ 页面刷新完成。');
        
        console.log('➡️ 打开下载管理，等待任务完成...');
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15 C2.790861,15"])');
        await downloadManagerIcon.click();
        
        const firstEntry = page.locator('li[class^="item--"]').first();
        await firstEntry.waitFor({ state: 'visible', timeout: 180000 });

        console.log('⏳ 正在等待报表生成成功...');
        const successLocator = firstEntry.locator('span.ant-tag:text("成功")');
        await successLocator.waitFor({ state: 'visible', timeout: 60000 });
        console.log('✅ 报表已生成成功！');

        const finalDownloadLink = firstEntry.locator('p[class^="success--"]');
        const linkText = await finalDownloadLink.textContent();
        console.log(`✅ 已找到可下载的目标文件链接: ${linkText}`);
        
        const downloadPromise = page.waitForEvent('download');
        await finalDownloadLink.click();
        const download = await downloadPromise;
        console.log('✅ 下载事件已捕获!');
        
        // 在此处再次确保目录存在
        if (!fs.existsSync(DOWNLOAD_DIRECTORY)) { fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true }); }
        const suggestedFileName = download.suggestedFilename();
        const filePath = path.join(DOWNLOAD_DIRECTORY, suggestedFileName);
        await download.saveAs(filePath);
        console.log(`🎉 表格已成功下载到: ${filePath}`);

        await page.keyboard.press('Escape');
        return { success: true, savePath: filePath };

    } catch (error) {
        console.error(`❌ 下载日期 [${task.date}] 的报告时失败:`, error);
        return { success: false, savePath: null };
    }
}

async function main() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
        console.error('错误：请先设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。');
        process.exit(1);
    }
    
    // 步骤 1: 扫描并导入本地已存在的文件
    await scanAndImportExistingFiles();

    // 步骤 2: 基于更新后的数据库，计算真正缺失的任务
    console.log('\n--- 步骤 B: 开始计算缺失日期 ---');
    // --- 日度修改点 6: 调用新的日度任务函数 ---
    const dailyTasks = await getMissingDailyTasks();

    // 步骤 3: 如果没有需要下载的任务，直接结束
    // --- 日度修改点 7: 检查 dailyTasks 数量 ---
    if (dailyTasks.length === 0) {
        console.log('\n数据库数据完整，无需执行在线下载任务。脚本执行完毕。');
        return;
    }
    
    console.log('\n--- 步骤 C: 检测到数据缺失，准备启动浏览器执行下载任务 ---');
    
    console.log('🚀 正在启动浏览器...');
    // 为了防止在日度下载中大量下载，建议保持 headless: true，但为了调试方便，保留为 false
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
        
        console.log('➡️ 步骤 E: 开始按序执行日度下载任务...');
        // --- 日度修改点 8: 循环 dailyTasks 并调用 downloadReportForDay ---
        for (const task of dailyTasks) {
            const downloadResult = await downloadReportForDay(page, task);
            if (downloadResult.success && downloadResult.savePath) {
                // 下载成功后立刻导入，确保数据一致性
                const importSuccess = await importDataLikePython(downloadResult.savePath);
                
                // [改动 5.1: 导入成功后执行归档]
                if (importSuccess) {
                     await moveFileToArchive(downloadResult.savePath, ARCHIVE_DIRECTORY);
                } else {
                     console.warn(`⚠️ 文件 [${path.basename(downloadResult.savePath)}] 导入数据库失败，跳过归档。`);
                }
                
            } else {
                console.error(`❗ 日期 [${task.date}] 的任务处理失败，将继续下一个任务...`);
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