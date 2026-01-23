// 02-PDD_Order_Task.js - 专注于拼多多订单报表下载与入库
// [2025-01-23 修复版 V19] 基于诊断日志确认结构，采用“智能等待+循环刷新”策略，解决渲染不稳定的问题

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
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0'; 

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
const DB_ORDER_TABLE_NAME = 'pddorder'; 
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

// ======================= [数据库逻辑] =======================

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

async function selectDateRange(page, dateStrStart, dateStrEnd) {
    const dayStart = parseInt(dateStrStart.split('-')[2], 10).toString();
    const dayEnd = parseInt(dateStrEnd.split('-')[2], 10).toString();

    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    
    if (!await calendarContainer.isVisible()) {
        console.log(' -> ⚠️ 检测到日历弹窗已关闭，尝试重新打开...');
        const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
        await dateInput.click({ force: true });
        try {
            await calendarContainer.waitFor({ state: 'visible', timeout: 5000 });
            console.log(' -> ✅ 重新打开日历弹窗成功。');
        } catch (e) {
            throw new Error('❌ 无法打开日历弹窗，后续操作无法继续。');
        }
    } else {
        await calendarContainer.waitFor({ state: 'visible', timeout: 5000 });
    }

    await page.waitForTimeout(1500); 

    const clickRobust = async (targetDay, type) => {
        const candidates = calendarContainer.getByText(targetDay, { exact: true });
        const count = await candidates.count();
        console.log(`[调试] ${type}: 在日历中找到了 ${count} 个数字 "${targetDay}"`);

        let clickedAny = false;
        for (let i = 0; i < count; i++) {
            try {
                const el = candidates.nth(i);
                if (!await el.isVisible()) {
                    continue;
                }
                await el.click({ timeout: 1000, force: true });
                clickedAny = true;
                await page.waitForTimeout(200); 
            } catch (e) {}
        }
        if (!clickedAny) {
            throw new Error(`无法在日历中点击 ${type}: ${targetDay}`);
        }
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
    }
}

// ======================= [任务主流程] =======================

async function pddOrderDownloadAndImportTask(page) {
    console.log(`\n--- 📦 [任务] 正在执行订单报表下载、导入及归档任务 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    
    await initialOrderImportAndArchive();
    
    const datesToDownloadSet = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS);
    const sortedDatesToDownload = Array.from(datesToDownloadSet).sort();
    
    if (sortedDatesToDownload.length === 0) {
        console.log(`✅ 数据完整，无需下载。`);
        return;
    }

    const dateRangesToDownload = groupConsecutiveDates(sortedDatesToDownload);
    console.log(`\n发现 ${sortedDatesToDownload.length} 个缺失日期，分为 ${dateRangesToDownload.length} 组。`);
    let downloadCounter = 0;

    for (const range of dateRangesToDownload) {
        const { start: dateStrStart, end: dateStrEnd } = range;
        let filePath = '';
        try {
            console.log(`\n[处理中] 范围: ${dateStrStart} 至 ${dateStrEnd}`);
            await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // 尝试关闭可能的弹窗
            try {
                const closeIcon = page.locator('[data-testid="beast-core-modal-icon-close"]');
                if (await closeIcon.isVisible({ timeout: 5000 })) {
                    await closeIcon.click();
                    await randomDelay(500, 1000);
                } 
            } catch (e) {}

            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            
            // --- 日期选择逻辑保持不变 ---
            const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
            const datePickerPortal = page.locator('[data-testid="beast-core-portal"]');
            let isPickerOpen = await datePickerPortal.isVisible();
            let retryCount = 0;

            while (!isPickerOpen && retryCount < 3) {
                await dateInput.click({ force: true });
                try {
                    await datePickerPortal.waitFor({ state: 'visible', timeout: 3000 });
                    isPickerOpen = true;
                } catch (e) {
                    retryCount++;
                    await randomDelay(1000, 2000);
                }
            }

            if (!isPickerOpen) {
                throw new Error('❌ 严重错误：尝试多次仍无法打开日期选择器，任务终止。');
            }
            
            await randomDelay(500, 1000);
            
            const resetLink = page.getByText('归零').first();
            if (await resetLink.isVisible()) {
                await resetLink.click();
                await randomDelay(700, 1000);
                if (!await datePickerPortal.isVisible()) {
                    await dateInput.click({ force: true });
                    await datePickerPortal.waitFor({ state: 'visible', timeout: 5000 });
                }
            }
            
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
            console.log(' -> 已生成报表，进入下载检测循环 (适配测试脚本逻辑 V2)...');
            
            // 给服务器一点反应时间，避免立即检测为空
            await page.waitForTimeout(2000);

            let isDownloadTriggered = false;
            
            // --- [修改重点] 采用测试脚本的检测逻辑 ---
            // 最多重试 30 次 (约 2-3 分钟)
            for (let i = 0; i < 30; i++) {
                
                // 1. 定位列表第一项 (Download Box)
                // 每次循环重新定位，防止 DOM 刷新导致元素失效
                const firstCard = page.locator('div.download-box').first();
                
                // 检查列表是否已加载
                if (await firstCard.count() === 0) {
                     console.log(` -> [${i+1}/30] ⏳ 列表容器未加载，点击刷新...`);
                     const globalRefresh = page.getByText('刷新').last();
                     if (await globalRefresh.isVisible()) await globalRefresh.click({ force: true });
                     await page.waitForTimeout(3000);
                     continue;
                }

                // 2. 在卡片内寻找包含“下载报表”文字的按钮 (精确匹配测试脚本逻辑)
                const targetBtn = firstCard.locator('button').filter({ hasText: '下载报表' });
                
                // 3. 主动检查按钮是否可见 (不使用 try/catch 等待，而是直接判断 count)
                const isBtnVisible = await targetBtn.count() > 0;

                if (isBtnVisible) {
                    console.log(` -> [${i+1}/30] 🎯 成功发现“下载报表”按钮！`);

                    // [高亮视觉反馈] - 移植自测试脚本，确认为正确元素
                    await targetBtn.evaluate(node => {
                        node.style.border = '5px solid red';
                        node.style.backgroundColor = 'yellow';
                    });
                    
                    // 确保元素在视图内
                    await targetBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(1000); // 稍作停顿，避免操作过快

                    try {
                        // 设置下载监听 (超时设置为 30秒)
                        console.log(' -> 🖱️ 正在执行点击操作 (强制模式)...');
                        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
                        
                        // 使用 force: true 绕过可能的透明遮挡
                        await targetBtn.click({ force: true });

                        const download = await downloadPromise;
                        const suggestedFilename = download.suggestedFilename();
                        console.log(`   ✅ 捕获到下载事件: ${suggestedFilename}`);
                        
                        // 保存文件
                        filePath = path.join(ORDER_DOWNLOAD_FOLDER, suggestedFilename);
                        await download.saveAs(filePath);
                        console.log(`   ✅ 文件已保存: ${filePath}`);
                        
                        isDownloadTriggered = true;
                        downloadCounter++;
                        break; // 下载成功，跳出循环

                    } catch (err) {
                        console.error(`   ❌ 点击了按钮但下载失败/超时: ${err.message}`);
                        // 如果点击失败，可能是假死，尝试刷新后继续循环
                    }

                } else {
                    // 4. 如果没有找到按钮，诊断原因并刷新
                    // 获取卡片文本判断状态
                    const cardText = await firstCard.innerText().catch(() => '');
                    const cleanText = cardText.replace(/\s+/g, ' ').substring(0, 50);
                    
                    console.log(` -> [${i+1}/30] ⚠️ 未找到下载按钮。卡片状态: [${cleanText}...]`);

                    if (cardText.includes('生成中')) {
                        console.log('    -> 状态判定：[生成中]，等待 5 秒...');
                        await page.waitForTimeout(5000);
                    } else if (cardText.includes('失败')) {
                        console.log('    -> 状态判定：[生成失败]，尝试重新点击生成或刷新...');
                        // 如果失败了，可能需要退出重试，或者这里简单处理为刷新
                    } else {
                        console.log('    -> 状态判定：未知/已过期，尝试刷新...');
                    }

                    // 核心动作：点击刷新以更新列表状态
                    // 寻找页面右上部分可能存在的刷新按钮
                    const refreshBtn = page.getByText('刷新').last();
                    if (await refreshBtn.isVisible()) {
                        console.log('    -> 🔄 点击刷新按钮...');
                        await refreshBtn.click({ force: true });
                        await page.waitForTimeout(3000); // 给刷新留足时间
                    } else {
                        await page.waitForTimeout(2000);
                    }
                }
            }
            // --- [循环结束] ---

            if (!isDownloadTriggered) {
                 throw new Error('❌ 超时：30次尝试后仍未下载成功 (请检查控制台输出的卡片文本状态)');
            }

            // 批次休息逻辑
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
    console.log(`\n--- 🚀 [Order Only] 启动拼多多订单报表下载任务 (V19) ---`);

    let context;
    let page;
    try {
        try { 
            await fs.access(userDataDir);
        } catch { 
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); 
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
        
        await pddOrderDownloadAndImportTask(page);

    } catch (error) {
        console.error('❌ 脚本在执行过程中遇到严重错误:', error.message);
    } finally {
        if (context) {
            await context.close();
            console.log('\n🔚 浏览器已关闭。');
        }
    }
}

main();