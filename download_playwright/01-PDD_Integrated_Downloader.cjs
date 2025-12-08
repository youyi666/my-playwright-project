// pdd_all_in_one.js - 最终版：融合了提额、推广报表、订单报表下载导入数据库的脚本 (基于数据库查重查漏)

const { chromium, errors } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// --- 数据库和Excel处理相关的依赖 ---
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
// 1. 用户登录配置文件夹 (两个脚本共用)
// [路径改动 1: 持久化会话路径]
// 原始: const userDataDir = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\PDD\\pdd-auth-profile';
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');

// --- 提额任务配置 ---
const PDD_QUOTA_URL = 'https://mms.pinduoduo.com/orders/reportManage?msfrom=mms_sidenav';
const APPLY_REASON = '发货'; 

// --- 推广报表任务配置 (原有的逻辑) ---
// [路径改动 2: 推广报表下载目录]
// 原始: const PROMOTION_DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\推广_商品数据\\拼多多';
const PROMOTION_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '推广_商品数据', '拼多多');
const PROMOTION_ARCHIVE_FOLDER = path.join(PROMOTION_DOWNLOAD_FOLDER, '已导入'); // 【修改：推广报表归档目录】
const PROMOTION_TARGET_URL_TEMPLATE = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';
const PROMOTION_CHECK_PAST_DAYS = 90; // 回溯检查的天数


// --- 订单报表任务配置 [新增/修改] ---
// [路径改动 3: 订单报表下载目录]
// 原始: const ORDER_DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\订单_订单查询'; // 目标下载目录
const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询'); // 目标下载目录
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入'); // 归档目录
const ORDER_CHECK_PAST_DAYS = 90; // 回溯检查的天数
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav'; 
const REPORT_LIST_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0'; // 报表列表页 URL


// 行为模拟配置
const DOWNLOADS_PER_BATCH = 15;
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const LONG_DELAY_MIN_MS = 35000;
const LONG_DELAY_MAX_MS = 65000;
const HUMAN_LIKE_DELAY_MIN_MS = 500; 
const HUMAN_LIKE_DELAY_MAX_MS = 1500; 

// --- 数据库和数据处理的全局常量配置 ---
// [路径改动 4: 数据库路径]
// 原始: const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db'; // 数据库路径
const CENTRAL_DB_PATH = path.join(__dirname, 'sql_data', 'TmallDataCenter.db'); // 数据库路径
const DB_PROMOTION_TABLE_NAME = 'pdd_product_promotion'; // 推广报表表名
const PROMOTION_DATE_HEADER = '统计日期'; // 【新增：推广报表用于查漏补缺的日期字段】
const DB_ORDER_TABLE_NAME = 'pddorder'; // 订单报表表名
const ORDER_PRIMARY_KEY = '订单号'; // 订单表主键
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; // 用于查漏补缺的日期字段
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

/**
 * 移动文件到归档目录
 * @param {string} sourcePath - 源文件路径.
 * @param {string} archiveDir - 目标归档目录.
 * @param {string} [newFileName] - 可选，指定归档后的新文件名.
 */
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




// ======================= [数据库导入函数 (推广报表)] =======================
// ... (savePddPromotionReportToDatabase 函数内容不变) ...
async function savePddPromotionReportToDatabase(csvPath, dateStr) {
    console.log(`\n--- [数据库导入] 开始处理推广报表文件: ${path.basename(csvPath)} ---`);
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

        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        if (tableInfo.length === 0) {
            db.exec(`
                CREATE TABLE "${DB_PROMOTION_TABLE_NAME}" (
                    ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `);
            console.log(`数据表 [${DB_PROMOTION_TABLE_NAME}] 不存在，已成功创建。`);
        } else {
            const existingColumns = tableInfo.map(col => col.name);
            const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
            if (newHeaders.length > 0) {
                db.transaction(() => {
                    for (const header of newHeaders) {
                        const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                        db.prepare(`ALTER TABLE "${DB_PROMOTION_TABLE_NAME}" ADD COLUMN "${sanitizedHeader}" ${getColumnType(header)}`).run();
                    }
                })();
            }
        }

        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        const insertQuery = `
            INSERT INTO "${DB_PROMOTION_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
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
        
        console.log(`✅ [导入成功] 推广报表文件 [${path.basename(csvPath)}] 的 ${processedData.length} 条数据已成功同步至数据库。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理推广报表文件 [${path.basename(csvPath)}] 时发生数据库错误:`, e.message);
    } finally {
        if (db) db.close();
    }
}
// ==========================================================

/**
 * [关键修复] 格式化支付时间字符串为 YYYY-MM-DD 格式
 * @param {string} dateTimeStr - 支付时间字符串，例如 "2025/10/13 23:24:31" 或 "2025/10/3 5:00:00"
 * @returns {string | null} 格式化后的日期字符串 "YYYY-MM-DD" 或 null
 */
function formatPaymentDate(dateTimeStr) {
    if (!dateTimeStr) return null;
    
    // 强制转换为字符串并清理空格 (解决 "    " 空白值问题)
    const cleanStr = String(dateTimeStr).trim(); 
    if (cleanStr.length === 0) return null; // 过滤掉纯空白的原始支付时间

    // 目标是捕获 M/D/YY 或 YYYY/M/D 等格式的日期部分。
    // 正则表达式匹配 Y/M/D, Y-M-D, YYYY/M/D, YYYY-M-D 格式，允许年、月、日是 1-4 位数字。
    const dateMatch = cleanStr.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})/);
    
    if (dateMatch) {
        // parts[1]=年/月/日之一, parts[2]=月/日之一, parts[3]=年/月/日之一
        let part1 = dateMatch[1];
        let part2 = dateMatch[2];
        let part3 = dateMatch[3];
        
        let year, month, day;

        // 假设两位数年份是YY，四位是YYYY。两位数年通常在末尾 (美式 M/D/YY)
        if (part1.length === 4) { // 格式 YYYY/MM/DD 或 YYYY-MM-DD
            year = part1;
            month = part2;
            day = part3;
        } else if (part3.length === 4) { // 格式 MM/DD/YYYY 或 M/D/YYYY
            year = part3;
            month = part1;
            day = part2;
        } else if (part3.length === 2 && part1.length <= 2) { // 格式 M/D/YY (如 7/16/25)
            // 假设这是 M/D/YY 格式 (Excel常见)
            year = `20${part3}`; // 转换为 4 位年份
            month = part1;
            day = part2;
        } else {
             // 无法识别的日期结构
             return null;
        }
        
        // 强制月和日为两位数
        month = String(month).padStart(2, '0');
        day = String(day).padStart(2, '0');
        
        const formattedDate = `${year}-${month}-${day}`;

        // 最终验证格式是否符合 YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(formattedDate)) {
             return formattedDate;
        }
    }
    
    return null;
}

/**
 * [核心逻辑] 订单报表导入数据库的核心逻辑（按订单号查重）。
 * @param {Array<object>} rawData - 待导入的订单数据（JSON格式）.
 * @param {string} fileName - 文件名（仅用于日志）.
 * @param {Database} db - 数据库连接对象.
 * @returns {number} 成功导入的记录数.
 */
function processOrderDataForDatabase(rawData, fileName, db) {
    if (rawData.length === 0) { return 0; }

    // 【修复点 1】 深度清洗所有原始数据的键(列名)，解决不可见字符/空格问题
    const cleanedRawData = rawData.map(row => {
        const cleanedRow = {};
        for (const key in row) {
            // 使用 trim() 清洗键名
            cleanedRow[String(key).trim()] = row[key];
        }
        return cleanedRow;
    });

    const firstRow = cleanedRawData[0]; // 使用清洗后的数据
    const originalHeaders = Object.keys(firstRow); // 此时的列名已经被清洗过了
    
    // 检查关键列是否存在
    if (!originalHeaders.includes('支付时间') || !originalHeaders.includes(ORDER_PRIMARY_KEY)) {
        console.warn(` -> ⚠️ 警告: 文件 [${fileName}] 缺少必要的列("支付时间"或"${ORDER_PRIMARY_KEY}")，跳过导入。`);
        return 0;
    }

    const headersWithDate = [...originalHeaders, ORDER_PAYMENT_DATE_HEADER];
    
    // 1. 数据处理：格式化 '支付时间' 并新增 '支付日期' 字段
    const processedData = cleanedRawData.map((row, index) => { // 增加 index
        const newRow = { ...row }; // 此时 newRow 的键是干净的
        
        const orderId = newRow[ORDER_PRIMARY_KEY]; // 获取订单号
        const paymentTime = newRow['支付时间']; // 获取原始支付时间
        
        const paymentDate = formatPaymentDate(paymentTime); // 尝试格式化
        newRow[ORDER_PAYMENT_DATE_HEADER] = paymentDate;
        
        // 过滤掉没有订单号或支付日期的行
        if (!orderId || !paymentDate) {
             // 【调试输出】如果行被过滤，记录原因
             // console.log(`   - [过滤] 行 ${index + 1} 被跳过。订单号: ${orderId || '空'}, 原始支付时间: "${paymentTime || '空'}", 格式化支付日期: ${paymentDate || '空'}`);
             return null;
        }
        return newRow;
    }).filter(row => row !== null); 

    if (processedData.length === 0) { 
        console.log(` -> ⚠️ 文件 [${fileName}] 中没有有效的订单数据可导入 (共 ${rawData.length} 行)。`);
        return 0; 
    }
    
    // 2. 准备安全列名
    const sanitizedHeaders = headersWithDate.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
    const primaryKeySanitized = ORDER_PRIMARY_KEY.replace(/[\s\.\-\/\\()]/g, '_');
    const paymentDateSanitized = ORDER_PAYMENT_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');


    // 3. 动态创建/更新表结构，确保所有列存在，特别是新的支付日期列
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

    // 4. 准备插入/覆盖更新语句
    const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(col => col.name);
    const columnsToUpdate = finalTableColumns.filter(h => h !== primaryKeySanitized);

    const insertQuery = `
        INSERT INTO "${DB_ORDER_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
        VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
        ON CONFLICT("${primaryKeySanitized}") DO UPDATE SET
        ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
    `;
    const insertStmt = db.prepare(insertQuery);
    
    // 5. 准备查重语句 (按订单号)
    const checkQuery = `SELECT COUNT(*) AS count FROM "${DB_ORDER_TABLE_NAME}" WHERE "${primaryKeySanitized}" = ?;`;
    const checkStmt = db.prepare(checkQuery);

    let insertedCount = 0;
    
    // 6. 执行事务插入
    db.transaction(() => {
        for (const row of processedData) {
            const orderId = row[ORDER_PRIMARY_KEY];
            // 查重：检查该订单号是否已存在
            const isExist = checkStmt.get(orderId).count > 0;

            // 订单报表设计为只插入不存在的记录（避免重复处理已归档订单），但此处需要修改为：
            // 只要订单数据有效，就执行 INSERT OR REPLACE，因为如果订单状态发生变化（如从“待发货”到“已发货”），需要更新记录。
            // 鉴于脚本的归档机制（只处理未归档文件，且查重是按订单号），这里我们保留 INSERT OR REPLACE 的强大更新能力。
            // 实际只插入新增记录，因为更新是自动发生的。

            // if (!isExist) { // 原始脚本的逻辑是只插入新增，这里我们使用 INSERT OR REPLACE 自动处理
                const dataToInsert = {};
                const sanitizedCurrentRow = {};
                
                // 将原始列名转换为安全列名
                headersWithDate.forEach((header) => {
                    const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                    sanitizedCurrentRow[sanitizedHeader] = row[header];
                });
                
                // 填充最终表中所有列的数据
                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                
                const info = insertStmt.run(dataToInsert);
                if (info.changes > 0 && !isExist) { // 如果是新增记录
                     insertedCount++;
                }
            // }
        }
    })();
    
    console.log(` -> 文件 [${fileName}] 中 ${processedData.length} 条有效记录，新增导入 ${insertedCount} 条。`);

    return insertedCount;
}


/**
 * [核心逻辑] 扫描 ORDER_DOWNLOAD_FOLDER 目录中所有未归档的文件，导入数据库并归档。
 * 此函数现在通过查询数据库的订单号主键来查重。
 */
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
            // 确保文件不是归档目录本身
            if (path.resolve(filePath) === path.resolve(ORDER_ARCHIVE_FOLDER)) {
                continue;
            }
            
            if (path.extname(file).toLowerCase() === '.csv' || path.extname(file).toLowerCase() === '.xlsx') {
                
                console.log(` -> 发现未归档文件: ${file}`);
                
                const workbook = xlsx.readFile(filePath);
                const sheetName = workbook.SheetNames[0];
                
                // 确保读取时将数据转换为对象数组（列名作为键）
                let rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false });
                
                // 深度检查第一行是否包含主键 (需先进行键名清洗，但这里先进行基本检查)
                const firstRow = rawData.length > 0 ? rawData[0] : {};
                // [注意：这里依赖于原始文件中列名的准确性，在 processOrderDataForDatabase 中会进行 trim()]
                const hasPrimaryKey = Object.keys(firstRow).some(key => String(key).trim() === ORDER_PRIMARY_KEY);

                if (rawData.length === 0 || !hasPrimaryKey) {
                     console.log(`   - ⚠️ [文件无效] 文件 [${file}] 数据为空或缺少主键 "${ORDER_PRIMARY_KEY}"，跳过处理。`);
                     // [保留归档，避免下次扫描]
                     await moveFileToArchive(filePath, ORDER_ARCHIVE_FOLDER); 
                     continue;
                }

                // 导入数据并按订单号查重，返回实际插入的条数
                const successCount = processOrderDataForDatabase(rawData, file, db);
                
                if (successCount > 0) {
                    importedCount += successCount;
                }
                
                // 导入完成后，立即归档文件
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

/**
 * [核心逻辑] 查询数据库，找出近90天内缺少推广报表统计日期的日期。
 * 【新增函数，用于推广报表查漏】
 * @param {number} daysAgo - 回溯检查的天数.
 * @returns {Promise<Set<string>>} - 缺失的 'YYYY-MM-DD' 格式日期的集合.
 */
async function getMissingPromotionDatesFromDatabase(daysAgo) {
    console.log(`\n🔍 正在查询数据库 [${DB_PROMOTION_TABLE_NAME}] 查找最近 ${daysAgo} 天缺失的推广报表日期...`);
    let db;
    const existingDates = new Set();
    
    // 1. 生成范围内“应有”的日期
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

    // 2. 查询数据库中已存在的日期
    try {
        db = new Database(CENTRAL_DB_PATH, { readonly: true });
        
        const promotionDateSanitized = PROMOTION_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        
        // 检查 '统计日期' 字段是否存在，如果不存在则假装所有日期都缺失
        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        const columnExists = tableInfo.some(col => col.name === promotionDateSanitized);
        
        if (!columnExists) {
            console.warn(` ⚠️ 警告: 数据库表 [${DB_PROMOTION_TABLE_NAME}] 中缺少 [${PROMOTION_DATE_HEADER}] 字段，将重新下载所有日期以确保数据完整！`);
            return requiredDates;
        }

        const minDate = formatDate(startDate);
        const query = `
            SELECT DISTINCT "${promotionDateSanitized}" 
            FROM "${DB_PROMOTION_TABLE_NAME}" 
            WHERE "${promotionDateSanitized}" >= ?;
        `;
        const rows = db.prepare(query).all(minDate);
        
        for (const row of rows) {
            const dateStr = row[promotionDateSanitized];
            if (dateStr && requiredDates.has(dateStr)) {
                existingDates.add(dateStr);
            }
        }
        
    } catch (e) {
        console.error(`❌ [数据库查漏失败]: ${e.message}`);
        console.warn(' ⚠️ 由于数据库查询失败，将重新下载所有日期以确保数据完整！');
        return requiredDates; // 如果数据库失败，则下载所有日期
    } finally {
        if (db) db.close();
    }

    // 3. 计算缺失的日期
    const datesToDownload = Array.from(requiredDates).filter(date => !existingDates.has(date));
    const missingDatesSet = new Set(datesToDownload);

    console.log(` -> 数据库中已找到 ${existingDates.size} 个日期的数据。`);
    console.log(` -> 发现 ${missingDatesSet.size} 个缺失日期。`);
    
    return missingDatesSet;
}


/**
 * [核心逻辑] 查询数据库，找出近90天内缺少订单支付日期的日期。
 * @param {number} daysAgo - 回溯检查的天数.
 * @returns {Promise<Set<string>>} - 缺失的 'YYYY-MM-DD' 格式日期的集合.
 */
async function getMissingDatesFromDatabase(daysAgo) {
    console.log(`\n🔍 正在查询数据库 [${DB_ORDER_TABLE_NAME}] 查找最近 ${daysAgo} 天缺失的订单支付日期...`);
    let db;
    const existingDates = new Set();
    
    // 1. 生成范围内“应有”的日期
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

    // 2. 查询数据库中已存在的日期
    try {
        db = new Database(CENTRAL_DB_PATH, { readonly: true });
        
        const paymentDateSanitized = ORDER_PAYMENT_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        
        // 检查 '支付日期' 字段是否存在，如果不存在则假装所有日期都缺失
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
        return requiredDates; // 如果数据库失败，则下载所有日期
    } finally {
        if (db) db.close();
    }

    // 3. 计算缺失的日期
    const datesToDownload = Array.from(requiredDates).filter(date => !existingDates.has(date));
    const missingDatesSet = new Set(datesToDownload);

    console.log(` -> 数据库中已找到 ${existingDates.size} 个日期的数据。`);
    console.log(` -> 发现 ${missingDatesSet.size} 个缺失日期。`);
    
    return missingDatesSet;
}


// ======================= [推广报表下载任务 (已修改查漏逻辑)] =======================
/**
 * 扫描目录，获取指定天数内所有已存在的文件日期。
 * @param {string} directory - 要扫描的目录.
 * @param {number} daysAgo - 回溯检查的天数.
 * @returns {Promise<Set<string>>} - 一个包含 'YYYY-MM-DD' 格式日期的集合.
 */
async function getExistingPromotionDatesFromFiles(directory, daysAgo) {
    console.log(`正在扫描目录 [${directory}] 以查找最近 ${daysAgo} 天内已下载的推广报表文件...`);
    const existingDates = new Set();
    const dateRegex = /pdd_promotion_report_(\d{4}-\d{2}-\d{2})\.csv/;
    
    // 计算日期范围
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);

    try {
        await fs.mkdir(directory, { recursive: true });
        const files = await fs.readdir(directory);

        for (const file of files) {
            const filePath = path.join(directory, file);
            // 排除归档目录下的文件
            if (path.resolve(filePath).startsWith(path.resolve(PROMOTION_ARCHIVE_FOLDER))) {
                continue;
            }
            
            const match = file.match(dateRegex);
            if (match) {
                const fileDateStr = match[1];
                const fileDate = new Date(fileDateStr);
                fileDate.setHours(0, 0, 0, 0);
                // 确保文件日期在我们的检查范围内 (不包含今天)
                if (fileDate >= startDate && fileDate < today) {
                    existingDates.add(fileDateStr);
                }
            }
        }
        console.log(`扫描完成，在指定范围内共找到 ${existingDates.size} 个已存在的推广报表日期。`);
        return existingDates;
    } catch (error) {
        console.error(`扫描目录时发生错误: ${error.message}`);
        return existingDates; // 返回空集合
    }
}

/**
 * 执行推广报表下载和导入任务 (原 pddReportDownloadAndImportTask)
 * 【已修改查漏逻辑：数据库优先查漏，文件次之】
 * @param {import('playwright').Page} page - Playwright Page 对象.
 */
async function pddPromotionReportTask(page) {
    console.log(`\n--- 📈 [任务 2/3] 正在执行推广报表下载和数据库导入任务 (基于数据库查漏) ---`);

    // 1. 检查数据库，获取缺失的日期 (数据库优先原则)
    const datesMissingInDB = await getMissingPromotionDatesFromDatabase(PROMOTION_CHECK_PAST_DAYS);
    let datesToDownload = Array.from(datesMissingInDB).sort(); // 默认是数据库中缺失的日期
    
    if (datesToDownload.length === 0) {
        console.log(`✅ 最近 ${PROMOTION_CHECK_PAST_DAYS} 天的推广报表数据已在数据库中完整，无需操作。`);
        return;
    }
    
    // 2. 在数据库存在缺失的情况下，检查本地下载目录，看是否有文件未导入。
    //    目的是排除掉那些'已下载但因故未归档/导入'的文件，避免重复下载。
    console.log('\n--- [文件查漏] 检查下载目录中是否有未导入的文件需要优先处理 ---');
    const existingDatesSet = await getExistingPromotionDatesFromFiles(PROMOTION_DOWNLOAD_FOLDER, PROMOTION_CHECK_PAST_DAYS);
    
    // 筛选出那些既在数据库中缺失，又未在下载目录中发现的文件 (即需要新下载的文件)
    const datesToActuallyDownload = datesToDownload.filter(date => !existingDatesSet.has(date));
    
    if (datesToActuallyDownload.length === 0) {
        console.log(`✅ 所有数据库中缺失的日期，对应的文件在本地下载目录中都已存在，无需重复下载。`);
        console.log(' -> 脚本将跳过下载。请确保本地文件已通过其他方式处理或归档。');
        return;
    }
    
    datesToDownload = datesToActuallyDownload; // 实际需要通过网络下载的日期列表


    console.log(`\n发现 ${datesToDownload.length} 个需要下载的推广报表日期:`);
    console.log(datesToDownload.join(', '));
    console.log('---');

    let downloadCounter = 0;
    const successfulDownloads = []; // 用于存储成功下载的文件信息

    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[处理中] 推广报表日期: ${dateStr}`);
            const targetUrl = PROMOTION_TARGET_URL_TEMPLATE.replace(/{DATE}/g, dateStr);

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
            const filePath = path.join(PROMOTION_DOWNLOAD_FOLDER, fileName);

            await download.saveAs(filePath);
            console.log(`✅ [成功] 推广报表已保存到: ${filePath}`);

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
            console.error(`❌ [失败] 处理推广报表日期 ${dateStr} 时遇到错误: ${error.message}`);
            console.error(' -> 将跳过这个日期，继续下一个。');
        }
    }
    
    console.log('\n--- 所有推广报表下载任务已处理完毕！---');

    if (successfulDownloads.length > 0) {
        console.log(`\n--- 开始执行数据库导入，共 ${successfulDownloads.length} 个推广报表文件 ---`);
        for (const file of successfulDownloads) {
            await savePddPromotionReportToDatabase(file.path, file.date);
            // [改动 6: 推广报表导入成功后归档]
            // 【修改：改为归档到 PROMOTION_ARCHIVE_FOLDER】
            await moveFileToArchive(file.path, PROMOTION_ARCHIVE_FOLDER, path.basename(file.path)); 
        }
        console.log('\n--- 所有推广报表文件均已导入数据库 ---');
    }
}


// +++ [改动 7: 订单报表辅助函数不变] +++

// ... (groupConsecutiveDates 和 selectDateRange 函数内容不变)

/**
 * 将一组按 YYYY-MM-DD 排序的日期字符串，分组为连续的日期范围。
 * @param {Array<string>} dates - 缺失的日期字符串数组 (已排序).
 * @returns {Array<{start: string, end: string}>} - 连续日期范围数组.
 * - start: 范围的起始日期 (D_start)
 * - end: 范围的结束日期 (D_end + 1，用于查询边界)
 */
function groupConsecutiveDates(dates) {
    if (dates.length === 0) return [];

    const ranges = [];
    let currentStart = dates[0];
    let currentEnd = dates[0];

    for (let i = 1; i < dates.length; i++) {
        const prevDate = new Date(currentEnd);
        prevDate.setDate(prevDate.getDate() + 1); // 前一个日期 + 1 天
        
        const currentDate = new Date(dates[i]);
        
        // 检查当前日期是否紧接在前一个日期之后
        if (formatDate(prevDate) === dates[i]) {
            currentEnd = dates[i];
        } else {
            // 发现不连续，结束当前范围
            const endDatePlusOne = new Date(currentEnd);
            endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
            ranges.push({
                start: currentStart, 
                end: formatDate(endDatePlusOne) // D_end + 1
            });
            // 开启新范围
            currentStart = dates[i];
            currentEnd = dates[i];
        }
    }

    // 处理最后一个范围
    const endDatePlusOne = new Date(currentEnd);
    endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
    ranges.push({
        start: currentStart, 
        end: formatDate(endDatePlusOne) // D_end + 1
    });

    return ranges;
}


/**
 * 模拟点击日历选择两个日期范围
 * @param {import('playwright').Page} page 
 * @param {string} dateStrStart - YYYY-MM-DD 格式的起始日期 (D_start)
 * @param {string} dateStrEnd - YYYY-MM-DD 格式的结束日期 (D_end + 1)
 */
async function selectDateRange(page, dateStrStart, dateStrEnd) {
    // 两个日期的日期部分，用于定位日历上的数字
    const dayStart = dateStrStart.split('-')[2];
    const dayEnd = dateStrEnd.split('-')[2];
    
    // 简化处理：假设目标月份在日历的右侧面板 (第二个 tableWrapper) 可见。

    const contentWrapperLocator = page.locator('.RPR_contentPickerWrapper_5-164-0');
    await contentWrapperLocator.waitFor({ state: 'visible', timeout: 10000 }); 
    
    // 定位器：右侧日历面板 (通常是 .RPR_tableWrapper_5-164-0 的第二个)
    const rightPanelLocator = contentWrapperLocator.locator('.RPR_tableWrapper_5-164-0').nth(1);

    /**
     * 点击指定日期的逻辑
     * @param {string} dayText - 要点击的日期数字
     * @param {string} dateFullStr - 完整的 YYYY-MM-DD 日期
     */
    const clickDateInPanel = async (dayText, dateFullStr) => {
        // 查找右侧面板中非禁用且文本匹配的日期 div
        const dateLocator = rightPanelLocator
            .locator(`.RPR_tdDay_5-164-0:not(.RPR_disabled_5-164-0) > div`, { hasText: dayText })
            .first();

        try {
            await dateLocator.waitFor({ state: 'visible', timeout: 5000 });
            await dateLocator.click();
            console.log(` -> 已点击日期: ${dateFullStr} (${dayText}日)。`);
        } catch (e) {
            // 如果日期不在右侧可见，则尝试在左侧面板查找
            const leftPanelLocator = contentWrapperLocator.locator('.RPR_tableWrapper_5-164-0').nth(0);
            const fallbackLocator = leftPanelLocator
                .locator(`.RPR_tdDay_5-164-0:not(.RPR_disabled_5-164-0) > div`, { hasText: dayText })
                .first();
                
            try {
                await fallbackLocator.waitFor({ state: 'visible', timeout: 2000 });
                await fallbackLocator.click();
                console.log(` -> (Fallback) 已点击日期: ${dateFullStr} (${dayText}日)。`);
            } catch (error) {
                // 如果仍失败，可能需要翻页或日期不可用
                throw new Error(`无法点击日期 ${dateFullStr} (${dayText}日)，可能不在当前日历视图或被禁用。`);
            }
        }
        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
    };

    // 1. 点击起始日期 (D_start)
    await clickDateInPanel(dayStart, dateStrStart);
    
    // 2. 点击结束日期 (D_end + 1)
    await clickDateInPanel(dayEnd, dateStrEnd); 
}

// ======================= [订单报表下载任务 (修复下载逻辑)] =======================

/**
 * [核心逻辑] 执行订单报表下载和导入任务 (按连续日期范围查漏补缺)
 * @param {import('playwright').Page} page - Playwright Page 对象.
 */
async function pddOrderDownloadAndImportTask(page) {
    console.log(`\n--- 📦 [任务 3/3] 正在执行订单报表下载、导入及归档任务 (基于数据库查漏补缺, 回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    
    // 1. 初始化导入和归档本地已存在但未处理的文件 (按订单号查重)
    await initialOrderImportAndArchive();
    
    // 2. 查询数据库，获取缺失的日期 (按支付日期查漏)
    const datesToDownloadSet = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS);
    const sortedDatesToDownload = Array.from(datesToDownloadSet).sort(); // 排序确保分组正确
    
    if (sortedDatesToDownload.length === 0) {
        console.log(`✅ 最近 ${ORDER_CHECK_PAST_DAYS} 天的订单报表数据完整，无需下载。`);
        return;
    }

    // 3. 将缺失日期分组为连续范围 [D_start, D_end + 1]
    const dateRangesToDownload = groupConsecutiveDates(sortedDatesToDownload);
    
    console.log(`\n发现 ${sortedDatesToDownload.length} 个缺失日期，将合并为 ${dateRangesToDownload.length} 个下载范围:`);
    dateRangesToDownload.forEach(r => console.log(` -> 范围: ${r.start} - ${r.end}`));
    console.log('---');
    
    let downloadCounter = 0;

    for (const range of dateRangesToDownload) {
        const { start: dateStrStart, end: dateStrEnd } = range;
        let filePath = '';
        try {
            console.log(`\n[处理中] 订单日期范围: ${dateStrStart} 至 ${dateStrEnd}`);
            await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            console.log(' -> 成功访问订单列表页。');

            // 尝试处理可能出现的活动/提示弹窗
            try {
                const closeButton = page.locator('button:has-text("我知道了"), button[aria-label*="关闭"], [aria-label*="我知道了"]').first();
                await closeButton.waitFor({ state: 'visible', timeout: 3000 });
                await closeButton.click();
                await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            } catch (e) {
                // ...
            }

            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            
            // 步骤 A: 点击“全部” Tab
            const allTab = page.locator('li.NewQuickTab_tab-border-bottom__3QEAw:has-text("全部")');
            await allTab.waitFor({ state: 'visible', timeout: 10000 });
            await allTab.click();
            console.log(' -> 已点击订单状态“全部”。');
            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

            // 步骤 B: 点击日期输入框
            const dateInput = page.locator('input[placeholder="请选择日期"][data-testid="beast-core-rangePicker-htmlInput"]');
            await dateInput.waitFor({ state: 'visible', timeout: 30000 });
            await dateInput.click();
            console.log(' -> 已点击日期输入框。');
            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

            // 步骤 C: 点击“归零”
            const resetLink = page.locator('a:has-text("归零")').first(); 
            await resetLink.click();
            console.log(' -> 已点击“归零”。');
            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            
            // 步骤 D: 选择日期范围 (D_start 到 D_end + 1)
            console.log(` -> 准备选择日期范围: ${dateStrStart} 至 ${dateStrEnd}`);
            await selectDateRange(page, dateStrStart, dateStrEnd); 
            
            // 步骤 E: 点击确认
            const confirmButton = page.locator('.RPR_footerWrapper_5-164-0').getByRole('button', { name: '确认' });
            await confirmButton.click();
            console.log(' -> 已点击日期选择确认按钮。');
            await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS); 

            // 步骤 F: 点击“查询”
            const queryButton = page.getByRole('button', { name: '查询', exact: true });
            await queryButton.click();
            console.log(' -> 已点击查询按钮。等待数据加载...');
            await page.waitForTimeout(3000); 

            // 步骤 G: 点击“批量导出”
            const batchExportButton = page.getByRole('button', { name: '批量导出' });
            await batchExportButton.click();
            console.log(' -> 已点击“批量导出”。');
            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
            
            // 步骤 H: 点击“生成报表”并等待跳转 
            const generateReportButton = page.getByRole('button', { name: '生成报表' });

            await generateReportButton.click();
            console.log(' -> 已点击“生成报表”。等待报表生成和自动跳转 (固定等待 10 秒)...');
            
            // 【修改点 3.1：保留固定等待，依赖自动跳转】
            await page.waitForTimeout(10000); 
            
            // 步骤 I: 【删除】主动导航到报表列表页，避免中断自动跳转流程。
            /*
            console.log(` -> 主动导航到报表列表页: ${REPORT_LIST_URL}`);
            await page.goto(REPORT_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000); // 确保列表内容加载完成
            */

            // 步骤 J (原 I): 监听下载并点击最新的“下载报表”按钮
            console.log(' -> 正在查找“下载报表”按钮...');
            const downloadPromise = page.waitForEvent('download', { timeout: 120000 }); // 延长下载超时时间

            const firstReportBox = page.locator('.list .download-box').first();
            const downloadButton = firstReportBox.getByRole('button', { name: '下载报表' }); 
            
            // 【修改点 3.2：删除显式等待，依赖 click() 的自动等待或隐式等待】
            // await firstReportBox.waitFor({ state: 'visible', timeout: 30000 });
            // await downloadButton.waitFor({ state: 'visible', timeout: 10000 });

            await downloadButton.click();
            console.log(' -> 已点击最新的“下载报表”按钮。等待文件下载...');

            const download = await downloadPromise;
            const suggestedFilename = download.suggestedFilename();
            // 文件路径使用原文件名
            filePath = path.join(ORDER_DOWNLOAD_FOLDER, suggestedFilename);
            await download.saveAs(filePath);
            
            console.log(`✅ [成功] 订单报表已保存到: ${filePath}`);

            downloadCounter++;

            if (downloadCounter > 0 && downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                console.log(`\n--- 已连续下载 ${DOWNLOADS_PER_BATCH} 个订单文件，执行一次长暂停以模拟人类行为 ---`);
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
                console.log('--- 长暂停结束，继续任务 ---\n');
            } else {
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }
            
        } catch (error) {
            console.error(`❌ [失败] 处理订单日期范围 ${dateStrStart} - ${dateStrEnd} 时遇到错误: ${error.message}`);
            console.error(' -> 将跳过这个范围，继续下一个。');
        }
    }
    
    console.log('\n--- 所有订单报表下载任务已处理完毕！---');
    
    // 下载完成后，再次运行初始化导入函数来处理本次新下载的文件
    if (downloadCounter > 0) {
        console.log(`\n--- 新下载 ${downloadCounter} 个文件，再次执行导入和归档操作 ---`);
        await initialOrderImportAndArchive();
    } else {
        console.log('本次没有新下载文件，无需二次导入。');
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
        
        // 确保订单下载目录被设置为 downloadsPath，以便 Playwright 自动处理下载
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });

        // 使用 launchPersistentContext 启动一次浏览器会话
        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null,
            // 订单下载任务默认使用此路径作为下载目录
            downloadsPath: ORDER_DOWNLOAD_FOLDER 
        });
        
        page = context.pages().length ? context.pages()[0] : await context.newPage();
        console.log('✅ 用户配置加载成功！会话已恢复。');


        
        // 2. 执行推广报表下载和数据库导入任务
        await pddPromotionReportTask(page);
        
        // 3. 执行订单报表下载、导入及归档任务
        await pddOrderDownloadAndImportTask(page);

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