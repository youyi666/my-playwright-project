// 02-PDD_Order_Task.js - 专注于拼多多订单报表下载与入库
// [2025-01-17 修复版 V2] 修复“全部订单”包含后缀问题 & 增强日期弹窗稳定性

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
// 1. 用户登录配置文件夹 (共用)
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');

// 2. 订单报表任务配置
const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询'); 
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入');
const ORDER_CHECK_PAST_DAYS = 90; // 回溯检查的天数
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav'; 

// 3. 行为模拟配置
const DOWNLOADS_PER_BATCH = 15;
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const LONG_DELAY_MIN_MS = 35000;
const LONG_DELAY_MAX_MS = 65000;
const HUMAN_LIKE_DELAY_MIN_MS = 500; 
const HUMAN_LIKE_DELAY_MAX_MS = 1500;

// 4. 数据库配置
const CENTRAL_DB_PATH = path.join(__dirname, 'sql_data', 'TmallDataCenter.db');
const DB_ORDER_TABLE_NAME = 'pddorder'; // 订单报表表名
const ORDER_PRIMARY_KEY = '订单号';
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; 

// ======================= [辅助函数] =======================

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

async function moveFileToArchive(sourcePath, archiveDir, newFileName = null) {
    try {
        await fs.mkdir(archiveDir, { recursive: true });
        const fileName = newFileName || path.basename(sourcePath); 
        const destPath = path.join(archiveDir, fileName);
        await fs.rename(sourcePath, destPath);
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        console.error(`❌ 文件归档失败 (${path.basename(sourcePath)}): ${e.message}`);
    }
}

// ======================= [数据库逻辑 - 订单报表] =======================

function formatPaymentDate(dateTimeStr) {
    if (!dateTimeStr) return null;
    const cleanStr = String(dateTimeStr).trim();
    if (cleanStr.length === 0) return null;

    const dateMatch = cleanStr.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})/);
    if (dateMatch) {
        let part1 = dateMatch[1];
        let part2 = dateMatch[2];
        let part3 = dateMatch[3];
        
        let year, month, day;
        if (part1.length === 4) { 
            year = part1; month = part2; day = part3;
        } else if (part3.length === 4) { 
            year = part3; month = part1; day = part2;
        } else if (part3.length === 2 && part1.length <= 2) { 
            year = `20${part3}`; month = part1; day = part2;
        } else {
             return null;
        }
        
        month = String(month).padStart(2, '0');
        day = String(day).padStart(2, '0');
        const formattedDate = `${year}-${month}-${day}`;

        if (/^\d{4}-\d{2}-\d{2}$/.test(formattedDate)) {
             return formattedDate;
        }
    }
    return null;
}

function processOrderDataForDatabase(rawData, fileName, db) {
    if (rawData.length === 0) { return 0; }

    const cleanedRawData = rawData.map(row => {
        const cleanedRow = {};
        for (const key in row) {
            cleanedRow[String(key).trim()] = row[key];
        }
        return cleanedRow;
    });
    const firstRow = cleanedRawData[0]; 
    const originalHeaders = Object.keys(firstRow);
    
    if (!originalHeaders.includes('支付时间') || !originalHeaders.includes(ORDER_PRIMARY_KEY)) {
        console.warn(` -> ⚠️ 警告: 文件 [${fileName}] 缺少必要的列("支付时间"或"${ORDER_PRIMARY_KEY}")，跳过导入。`);
        return 0;
    }

    const headersWithDate = [...originalHeaders, ORDER_PAYMENT_DATE_HEADER];
    const processedData = cleanedRawData.map((row, index) => { 
        const newRow = { ...row }; 
        const orderId = newRow[ORDER_PRIMARY_KEY]; 
        const paymentTime = newRow['支付时间']; 
        const paymentDate = formatPaymentDate(paymentTime); 
        newRow[ORDER_PAYMENT_DATE_HEADER] = paymentDate;
        
        if (!orderId || !paymentDate) {
             return null;
        }
        return newRow;
    }).filter(row => row !== null);

    if (processedData.length === 0) { 
        console.log(` -> ⚠️ 文件 [${fileName}] 中没有有效的订单数据可导入 (共 ${rawData.length} 行)。`);
        return 0; 
    }
    
    const sanitizedHeaders = headersWithDate.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
    const primaryKeySanitized = ORDER_PRIMARY_KEY.replace(/[\s\.\-\/\\()]/g, '_');
    
    const tableInfo = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all();
    const existingColumns = tableInfo.map(col => col.name);
    
    db.transaction(() => {
        if (tableInfo.length === 0) {
            const columnDefs = sanitizedHeaders.map(h => `"${h}" TEXT`).join(', ');
            db.exec(`
                CREATE TABLE "${DB_ORDER_TABLE_NAME}" (
                    ${columnDefs},
                    PRIMARY KEY ("${primaryKeySanitized}")
                );
            `);
            console.log(` -> 数据表 [${DB_ORDER_TABLE_NAME}] 不存在，已成功创建。`);
        } else {
            const newHeaders = sanitizedHeaders.filter(h => !existingColumns.includes(h));
            for (const header of newHeaders) {
                db.prepare(`ALTER TABLE "${DB_ORDER_TABLE_NAME}" ADD COLUMN "${header}" TEXT`).run();
            }
            if (newHeaders.length > 0) {
                console.log(` -> 表结构已更新，新增 ${newHeaders.length} 列。`);
            }
        }
    })();

    const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(col => col.name);
    const columnsToUpdate = finalTableColumns.filter(h => h !== primaryKeySanitized);

    const insertQuery = `
        INSERT INTO "${DB_ORDER_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
        VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
        ON CONFLICT("${primaryKeySanitized}") DO UPDATE SET
        ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
    `;
    const insertStmt = db.prepare(insertQuery);
    const checkQuery = `SELECT COUNT(*) AS count FROM "${DB_ORDER_TABLE_NAME}" WHERE "${primaryKeySanitized}" = ?;`;
    const checkStmt = db.prepare(checkQuery);

    let insertedCount = 0;
    
    db.transaction(() => {
        for (const row of processedData) {
            const orderId = row[ORDER_PRIMARY_KEY];
            const isExist = checkStmt.get(orderId).count > 0;
            const dataToInsert = {};
            const sanitizedCurrentRow = {};
        
            headersWithDate.forEach((header) => {
                const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                sanitizedCurrentRow[sanitizedHeader] = row[header];
            });
            
            for (const tableCol of finalTableColumns) {
                dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
            }
            
            const info = insertStmt.run(dataToInsert);
            if (info.changes > 0 && !isExist) { 
                 insertedCount++;
            }
        }
    })();
    console.log(` -> 文件 [${fileName}] 中 ${processedData.length} 条有效记录，新增导入 ${insertedCount} 条。`);
    return insertedCount;
}

async function initialOrderImportAndArchive() {
    console.log(`\n--- 📦 [初始化导入] 扫描并导入下载目录中的现有文件 (按订单号查重) ---`);
    let db;
    try {
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });
        const files = await fs.readdir(ORDER_DOWNLOAD_FOLDER);
        
        db = new Database(CENTRAL_DB_PATH);
        let importedCount = 0;
        let processedFileCount = 0;

        for (const file of files) {
            const filePath = path.join(ORDER_DOWNLOAD_FOLDER, file);
            if (path.resolve(filePath) === path.resolve(ORDER_ARCHIVE_FOLDER)) {
                continue;
            }
            
            if (path.extname(file).toLowerCase() === '.csv' || path.extname(file).toLowerCase() === '.xlsx') {
                console.log(` -> 发现未归档文件: ${file}`);
                const workbook = xlsx.readFile(filePath);
                const sheetName = workbook.SheetNames[0];
                
                let rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false });
                const firstRow = rawData.length > 0 ? rawData[0] : {};
                const hasPrimaryKey = Object.keys(firstRow).some(key => String(key).trim() === ORDER_PRIMARY_KEY);
                
                if (rawData.length === 0 || !hasPrimaryKey) {
                     console.log(`   - ⚠️ [文件无效] 文件 [${file}] 数据为空或缺少主键 "${ORDER_PRIMARY_KEY}"，跳过处理。`);
                     await moveFileToArchive(filePath, ORDER_ARCHIVE_FOLDER);
                     continue;
                }

                const successCount = processOrderDataForDatabase(rawData, file, db);
                if (successCount > 0) {
                    importedCount += successCount;
                }
                
                await moveFileToArchive(filePath, ORDER_ARCHIVE_FOLDER);
                processedFileCount++;
            }
        }
        
        if (processedFileCount === 0) {
            console.log(`✅ 下载目录 [${ORDER_DOWNLOAD_FOLDER}] 中没有未处理文件需要导入。`);
        } else {
             console.log(`✅ ${processedFileCount} 个订单报表文件已处理并归档，共新增 ${importedCount} 条记录。`);
        }
        return importedCount;
    } catch (error) {
        console.error(`❌ [初始化导入失败] 处理目录文件时发生错误: ${error.message}`);
    } finally {
        if (db) db.close();
    }
    return 0;
}

async function getMissingDatesFromDatabase(daysAgo) {
    console.log(`\n🔍 正在查询数据库 [${DB_ORDER_TABLE_NAME}] 查找最近 ${daysAgo} 天缺失的订单支付日期...`);
    let db;
    const existingDates = new Set();
    const requiredDates = new Set();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    let currentDate = new Date(startDate);
    while (currentDate < today) {
        requiredDates.add(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (requiredDates.size === 0) return new Set();

    try {
        db = new Database(CENTRAL_DB_PATH, { readonly: true });
        const paymentDateSanitized = ORDER_PAYMENT_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        
        const tableInfo = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all();
        const columnExists = tableInfo.some(col => col.name === paymentDateSanitized);
        
        if (!columnExists) {
            console.warn(` ⚠️ 警告: 数据库表 [${DB_ORDER_TABLE_NAME}] 中缺少 [${ORDER_PAYMENT_DATE_HEADER}] 字段，将重新下载所有日期以确保数据完整！`);
            return requiredDates;
        }

        const minDate = formatDate(startDate);
        const query = `
            SELECT DISTINCT "${paymentDateSanitized}" 
            FROM "${DB_ORDER_TABLE_NAME}" 
            WHERE "${paymentDateSanitized}" >= ?;
        `;
        const rows = db.prepare(query).all(minDate);
        
        for (const row of rows) {
            const dateStr = row[paymentDateSanitized];
            if (dateStr && requiredDates.has(dateStr)) {
                existingDates.add(dateStr);
            }
        }
        
    } catch (e) {
        console.error(`❌ [数据库查漏失败]: ${e.message}`);
        console.warn(' ⚠️ 由于数据库查询失败，将重新下载所有日期以确保数据完整！');
        return requiredDates;
    } finally {
        if (db) db.close();
    }

    const datesToDownload = Array.from(requiredDates).filter(date => !existingDates.has(date));
    const missingDatesSet = new Set(datesToDownload);

    console.log(` -> 数据库中已找到 ${existingDates.size} 个日期的数据。`);
    console.log(` -> 发现 ${missingDatesSet.size} 个缺失日期。`);
    
    return missingDatesSet;
}

// ======================= [UI 交互辅助函数] =======================

function groupConsecutiveDates(dates) {
    if (dates.length === 0) return [];
    const ranges = [];
    let currentStart = dates[0];
    let currentEnd = dates[0];
    for (let i = 1; i < dates.length; i++) {
        const prevDate = new Date(currentEnd);
        prevDate.setDate(prevDate.getDate() + 1); 
        
        const currentDate = new Date(dates[i]);
        if (formatDate(prevDate) === dates[i]) {
            currentEnd = dates[i];
        } else {
            const endDatePlusOne = new Date(currentEnd);
            endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
            ranges.push({
                start: currentStart, 
                end: formatDate(endDatePlusOne) 
            });
            currentStart = dates[i];
            currentEnd = dates[i];
        }
    }

    const endDatePlusOne = new Date(currentEnd);
    endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
    ranges.push({
        start: currentStart, 
        end: formatDate(endDatePlusOne) 
    });
    return ranges;
}

// [2025-01-17 优化] 增强版 selectDateRange：能自动尝试重新打开弹窗
async function selectDateRange(page, dateStrStart, dateStrEnd) {
    const dayStart = parseInt(dateStrStart.split('-')[2], 10).toString();
    const dayEnd = parseInt(dateStrEnd.split('-')[2], 10).toString();

    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    
    // 检查弹窗是否可见，如果不可见，尝试点击输入框重新打开
    if (!await calendarContainer.isVisible()) {
        console.log(' -> ⚠️ 检测到日历弹窗已关闭，尝试重新打开...');
        const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
        await dateInput.click({ force: true });
        // 等待弹窗出现
        try {
            await calendarContainer.waitFor({ state: 'visible', timeout: 5000 });
            console.log(' -> ✅ 重新打开日历弹窗成功。');
        } catch (e) {
            throw new Error('❌ 无法打开日历弹窗，后续操作无法继续。');
        }
    } else {
        // 如果已经可见，还是稍微 wait 一下确保状态稳定
        await calendarContainer.waitFor({ state: 'visible', timeout: 5000 });
    }

    const clickRobust = async (targetDay, type) => {
        const candidates = calendarContainer.getByText(targetDay, { exact: true });
        const count = await candidates.count();
        let success = false;
        for (let i = 0; i < count; i++) {
            try {
                const el = candidates.nth(i);
                if (!await el.isVisible()) continue;
                await el.click({ timeout: 1000, force: true });
                console.log(`   -> [${type}] 点击 "${targetDay}" 成功 (nth:${i})`);
                success = true;
                break;
            } catch (e) { continue; }
        }
        if (!success) throw new Error(`无法在日历中点击 ${type}: ${targetDay}`);
    };

    console.log(` -> 正在选择日期: ${dayStart} 至 ${dayEnd}`);
    await clickRobust(dayStart, "起始日期");
    await randomDelay(600, 1000); 
    
    await clickRobust(dayEnd, "结束日期");
    await randomDelay(500, 800);

    const confirmBtn = calendarContainer.locator('button').filter({ hasText: /^确认$/ })
        .or(calendarContainer.getByRole('button', { name: '确认' }));
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        console.log(' -> 已点击日历内部的“确认”按钮');
    } else {
        console.warn(' -> 未找到确认按钮，可能是自动确认模式？');
    }
}

// ======================= [任务主流程] =======================

async function pddOrderDownloadAndImportTask(page) {
    console.log(`\n--- 📦 [任务] 正在执行订单报表下载、导入及归档任务 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    // 1. 初始化本地文件
    await initialOrderImportAndArchive();
    
    // 2. 数据库查漏
    const datesToDownloadSet = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS);
    const sortedDatesToDownload = Array.from(datesToDownloadSet).sort();
    
    if (sortedDatesToDownload.length === 0) {
        console.log(`✅ 数据完整，无需下载。`);
        return;
    }

    // 3. 分组
    const dateRangesToDownload = groupConsecutiveDates(sortedDatesToDownload);
    console.log(`\n发现 ${sortedDatesToDownload.length} 个缺失日期，分为 ${dateRangesToDownload.length} 组。`);
    let downloadCounter = 0;

    for (const range of dateRangesToDownload) {
        const { start: dateStrStart, end: dateStrEnd } = range;
        let filePath = '';
        try {
            console.log(`\n[处理中] 范围: ${dateStrStart} 至 ${dateStrEnd}`);
            await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // 弹窗处理
            try {
                const closeButton = page.getByRole('button', { name: '我知道了' }).or(page.locator('[aria-label*="关闭"]')).first();
                if (await closeButton.isVisible({ timeout: 3000 })) {
                    await closeButton.click();
                }
            } catch (e) {}

            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            
            // ================= [修复点 1：精准点击“全部订单”] =================
            console.log(' -> 正在尝试切换到“全部”订单状态...');
            try {
                // 1. 尝试找到 Tab Label，文本包含“全部订单”
                // 使用 filter hasText 可以匹配 "全部订单(近3个月)" 这种文本
                const allTabLabel = page.locator('[data-testid="beast-core-tab-itemLabel"]').filter({ hasText: '全部订单' }).first();
                
                // 2. 如果找不到，尝试更广泛的文本匹配
                const allTabGeneric = page.getByText('全部订单').first();

                if (await allTabLabel.isVisible({ timeout: 3000 })) {
                    await allTabLabel.click();
                    console.log(' -> ✅ 已点击“全部订单”Tab (精准匹配)。');
                } else if (await allTabGeneric.isVisible({ timeout: 2000 })) {
                    await allTabGeneric.click();
                    console.log(' -> ✅ 已点击“全部订单” (模糊匹配)。');
                } else {
                     console.warn(' -> ⚠️ 未找到“全部订单”相关按钮，可能页面结构已变或默认已在全部页。');
                }
            } catch (e) {
                console.warn(` -> ⚠️ 切换“全部”状态时遇到轻微错误: ${e.message} (不影响后续流程)`);
            }
            await randomDelay(1000, 1500);
            // =====================================================================

            // 打开日期选择器
            const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
            const datePickerPortal = page.locator('[data-testid="beast-core-portal"]');
            let isPickerOpen = await datePickerPortal.isVisible();
            let retryCount = 0;

            while (!isPickerOpen && retryCount < 3) {
                if (retryCount > 0) {
                    console.log(`   -> ⚠️ 日历弹窗未出现，正在重试点击 (${retryCount}/3)...`);
                }
                
                await dateInput.click({ force: true });
                try {
                    await datePickerPortal.waitFor({ state: 'visible', timeout: 3000 });
                    isPickerOpen = true;
                    console.log(' -> ✅ 日期选择器已成功打开。');
                } catch (e) {
                    retryCount++;
                    await randomDelay(1000, 2000);
                }
            }

            if (!isPickerOpen) {
                throw new Error('❌ 严重错误：尝试多次仍无法打开日期选择器，任务终止。');
            }
            
            await randomDelay(500, 1000);

            // 点击“归零”
            // 注意：点击归零可能会关闭弹窗，所以这里不依赖它，或者点完检查弹窗
            const resetLink = page.getByText('归零').first();
            if (await resetLink.isVisible()) {
                // console.log(' -> 尝试点击“归零”...');
                // await resetLink.click();
                // await randomDelay(300, 500);
                // 某些版本点击归零后弹窗会刷新或关闭，稳妥起见，这里先跳过归零
                // 因为后续选择日期会覆盖旧值，不点归零通常也安全。
                // 如果必须点，需要在此处重新检查 isPickerOpen
                // 为了稳定性，本次修复暂不点“归零”，直接选日期
            }
            
            // 选择日期 (selectDateRange 内部现在会自动重开弹窗)
            await selectDateRange(page, dateStrStart, dateStrEnd);

            await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            
            // 点击查询
            const queryButton = page.getByRole('button', { name: '查询', exact: true });
            await queryButton.click();
            console.log(' -> 已点击查询，等待加载...');
            await page.waitForTimeout(3000); 

            // 点击批量导出
            const batchExportButton = page.getByRole('button', { name: '批量导出' });
            await batchExportButton.click();
            console.log(' -> 已点击批量导出。');
            await randomDelay(1000, 2000);
            
            // 点击生成报表
            const generateReportButton = page.getByRole('button', { name: '生成报表' });
            await generateReportButton.click();
            console.log(' -> 已生成报表，正在等待“下载报表”按钮出现...');
            
            // ================= [下载逻辑] =================
            // 显式等待足够长的时间，让报表生成（PDD有时需要10-20秒）
            await page.waitForTimeout(10000); 

            // 定义下载按钮定位器 (匹配 <button><span>下载报表</span></button>)
            const downloadBtnLocator = page.locator('button').filter({ hasText: '下载报表' }).first();

            try {
                // 等待按钮出现 (最长60秒)
                await downloadBtnLocator.waitFor({ state: 'visible', timeout: 60000 });
                console.log(' -> ✅ “下载报表”按钮已出现，准备点击...');

                // 使用 Promise.all 防止点击后 crash
                const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 120000 }), // 等待浏览器触发下载事件
                    downloadBtnLocator.click() // 点击按钮
                ]);

                const suggestedFilename = download.suggestedFilename();
                filePath = path.join(ORDER_DOWNLOAD_FOLDER, suggestedFilename);
                await download.saveAs(filePath);
                
                console.log(`✅ [下载成功] ${filePath}`);
                downloadCounter++;
            } catch (dlError) {
                throw new Error(`下载阶段失败 (按钮未出现或点击无效): ${dlError.message}`);
            }
            // =============================================================

            if (downloadCounter > 0 && downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                console.log(`\n--- 休息中... ---`);
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
            } else {
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }
            
        } catch (error) {
            console.error(`❌ [失败] ${dateStrStart}-${dateStrEnd}: ${error.message}`);
        }
    }
    
    console.log('\n--- 任务结束 ---');
    if (downloadCounter > 0) {
        await initialOrderImportAndArchive();
    }
}

// ======================= [入口函数] =======================
async function main() {
    console.log(`\n--- 🚀 [Order Only] 启动拼多多订单报表下载任务 ---`);

    let context;
    let page;
    try {
        console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
        try { 
            await fs.access(userDataDir);
        } catch { 
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); 
            console.error('请先成功运行一次登录配置或检查路径。');
            return; 
        }
        
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });

        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null,
            downloadsPath: ORDER_DOWNLOAD_FOLDER 
        });
        page = context.pages().length ? context.pages()[0] : await context.newPage();
        console.log('✅ 用户配置加载成功！会话已恢复。');

        // 执行订单报表任务
        await pddOrderDownloadAndImportTask(page);

    } catch (error) {
        console.error('❌ 脚本在执行过程中遇到严重错误:', error.message);
    } finally {
        if (context) {
            await context.close();
            console.log('\n🔚 浏览器已关闭，订单报表任务执行结束。');
        }
    }
    console.log('\n🎉 订单报表任务执行完毕！');
}

main();