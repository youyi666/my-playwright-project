// pdd-testdown-integrated.js - 最终版：融合了提额、推广报表、订单报表下载导入数据库，以及退款数据安全更正功能

const { chromium, errors } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
// 1. 新增依赖：引入 fs 模块用于文件系统操作，readline 用于用户交互
const fsSync = require('fs');
const readline = require('readline'); 

// --- 数据库和Excel处理相关的依赖 ---
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
// 1. 用户登录配置文件夹 (两个脚本共用)
const userDataDir = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\PDD\\pdd-auth-profile';

// --- 提额任务配置 ---
const PDD_QUOTA_URL = 'https://mms.pinduoduo.com/orders/reportManage?msfrom=mms_sidenav';
const APPLY_REASON = '发货'; 

// --- 推广报表任务配置 (原有的逻辑) ---
const PROMOTION_DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\推广_商品数据\\拼多多';
const PROMOTION_TARGET_URL_TEMPLATE = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';
const PROMOTION_CHECK_PAST_DAYS = 90; // 回溯检查的天数


// --- 订单报表任务配置 [新增/修改] ---
const ORDER_DOWNLOAD_FOLDER = 'Z:\\天猫生意参谋\\订单_订单查询'; // 目标下载目录
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
const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db'; // 数据库路径
const DB_PROMOTION_TABLE_NAME = 'pdd_product_promotion'; // 推广报表表名
const DB_ORDER_TABLE_NAME = 'pddorder'; // 订单报表表名 (退款数据源)
const ORDER_PRIMARY_KEY = '订单号'; // 订单表主键
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; // 用于查漏补缺的日期字段
const pddPromoNumericColumns = ["花费(元)", "订单数", "成交金额(元)", "投产比", "点击量", "点击率(%)", "千次展现花费(元)"];


// 2. 新增配置区域：用于退款数据更正 (从 viomi-pdd1.js 迁移并调整)
// --------------------------------------------------------------------------------------
const VIOMI_TARGET_DB_TABLE_NAME = 'pinduoduo_sales_flow'; // viomi-pdd1.js 脚本中需要更新的表名

// PDD订单表 (pddorder) 中的列名 (作为退款数据源)
const SRC_COL_ORDER_STATUS = '订单状态'; 		 // 订单状态列
const SRC_COL_PRODUCT_ID = '商品id'; 		 // 商品ID列 (用于匹配分组)
const SRC_COL_QUANTITY = '商品数量_件_'; 			// 商品数量列
const SRC_COL_AMOUNT = '商家实收金额_元_'; 			 // 实付金额列 (作为退款金额)
const SRC_COL_DATE = ORDER_PAYMENT_DATE_HEADER; // 支付日期列 (已在 pddorder 表中处理)

// 数据库 pinduoduo_sales_flow 表中需要更新的列名
const DB_COL_REFUND_PAY_ORDERS = '支付订单数'; 	// 需修正的订单数 (将用非退数据覆盖)
const DB_COL_REFUND_PAY_QUANTITY = '支付商品件数'; // 需修正的商品件数 (将用非退数据覆盖)
const DB_COL_REFUND_PAY_AMOUNT = '支付金额'; 		// 需修正的金额 (将用非退数据覆盖)
const DB_COL_REFUND_PRODUCT_ID = '商品ID'; 		// 数据库中用于匹配的商品ID列名
const DB_COL_DATE = '日期'; // 数据库中的日期列名
// --------------------------------------------------------------------------------------


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

// 3. 迁移辅助函数 (viomi-pdd1.js)

/**
 * 将 Date 对象格式化为 'YYYY-MM-DD' 格式的本地日期字符串，以避免时区问题。
 * @param {Date} date - 需要格式化的日期对象。
 * @returns {string} 'YYYY-MM-DD' 格式的字符串。
 */
function getLocalDateString(date) {
    if (!(date instanceof Date) || isNaN(date)) {
        return '';
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 迁移：处理 Excel 数字格式日期到 JS Date 对象 (尽管新逻辑中不需要，但为保持兼容性保留)
 * @param {number} excelDays - Excel 格式的日期数字
 * @returns {number} JS 的时间戳
 */
function excelDateToJSDate(excelDays) {
    // Excel 日期从 1899-12-30 开始计算
    const excelEpoch = new Date(1899, 11, 30); 
    // 将天数转换为毫秒
    return excelEpoch.getTime() + excelDays * 24 * 60 * 60 * 1000;
}


/**
 * 迁移：询问用户是否同意操作
 * @param {string} question - 要询问的问题
 * @returns {Promise<boolean>} 用户是否同意
 */
function askQuestion(question) {
    // 使用 fsSync 检查 fs 模块是否已导入，这里使用 require('readline')
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            // 匹配 "是", "同意", "Y", "y" 等肯定回答
            const affirmative = ['y', 'yes', '是', '同意'];
            if (affirmative.includes(answer.trim().toLowerCase())) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}
// 迁移辅助函数结束
// --------------------------------------------------------------------------------------


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
        // 使用 fsSync.rename 代替 fs.rename，避免在异步函数中混合使用 promise 和 callback 风格
        await fsSync.rename(sourcePath, destPath, (err) => {
            if (err) throw err;
        });
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        // 由于上面使用了 fsSync.rename 的 Promise 风格，这里应该捕获异步错误
        console.error(`❌ 文件归档失败 (${sourcePath}): ${e.message}`);
    }
}

// +++ [改动位置 1: 提额任务优化] +++
// ... (pddQuotaIncreaseTask 函数内容不变) ...
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
    console.log('\n--- 🚀 [任务 1/3] 正在执行拼多多提额任务 ---');

    try {
        // --- 步骤 1: 导航到拼多多目标页面 ---
        console.log(`\n➡️ 导航到提额目标页面: ${PDD_QUOTA_URL} (等待 'domcontentloaded')`);
        await page.goto(PDD_QUOTA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); 
        await page.waitForTimeout(3000); // 等待页面内容稳定加载

        // --- 步骤 2: 执行提额操作 ---
        console.log('--- 开始执行提额操作 ---');
        
        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 核心定位器：提额弹窗中的最大提额量提示
        // 弹窗定位器 (等待弹窗可见性)
        const maxLimitTextLocator = page.locator('div[id="number"]').locator('div.Form_itemHelper_5-164-0').first();
        // 链接定位器
        const tiEButtonLocator = page.locator('div.ReportLimit_contentTip__3e3sT').getByRole('link', { name: '申请今日提额' }).first();
        
        // 优化点击逻辑：移除不稳定的 waitFor，直接使用 force: true 和延长的超时点击
        console.log('🔍 尝试使用 force: true 点击 "申请今日提额" 链接...');
        
        try {
            // 使用 force: true 和延长的超时直接点击，Playwright 会在点击前等待元素可用
            await tiEButtonLocator.click({ force: true, timeout: 10000 }); 
            
            await randomDelay(1000, 2000); 
            
            // 等待弹窗弹出，将等待时间延长到 10 秒
            await maxLimitTextLocator.waitFor({ state: 'visible', timeout: 10000 }); 
            console.log('✅ 提额对话框已成功弹出。');

        } catch (e) {
            console.error(`❌ 无法点击 "申请今日提额" 或弹窗未弹出，错误: ${e.message.split('\n')[0]}，跳过提额任务。`);
            return;
        }

        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

        // 3. 提取最大提额数字
        const maxLimitText = await maxLimitTextLocator.textContent();
        console.log(`   - 提取到的提示文本: ${maxLimitText.trim()}`);
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
// ==========================================================


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
    
    // 强制转换为字符串并清理空格 (解决 "    " 空白值问题)
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
    if (!originalHeaders.includes('支付时间') || !originalHeaders.includes(ORDER_PRIMARY_KEY) || !originalHeaders.includes(SRC_COL_PRODUCT_ID) || !originalHeaders.includes(SRC_COL_QUANTITY) || !originalHeaders.includes(SRC_COL_AMOUNT)) {
        console.warn(` -> ⚠️ 警告: 文件 [${fileName}] 缺少必要的列("支付时间", "${ORDER_PRIMARY_KEY}", "${SRC_COL_PRODUCT_ID}", "${SRC_COL_QUANTITY}" 或 "${SRC_COL_AMOUNT}")，跳过导入。`);
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
             // console.log(`   - [过滤] 行 ${index + 1} 被跳过。订单号: ${orderId || '空'}, 原始支付时间: "${paymentTime || '空'}", 格式化支付日期: ${paymentDate || '空'}`);
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
            console.log(` -> 数据表 [${DB_ORDER_TABLE_NAME}] 已创建。`);
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

            if (!isExist) {
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
                
                insertStmt.run(dataToInsert);
                insertedCount++;
            }
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
        // 使用 fs.readdir 的 Promise 版本
        const files = await fs.readdir(ORDER_DOWNLOAD_FOLDER);
        
        db = new Database(CENTRAL_DB_PATH);

        let importedCount = 0;
        let processedFileCount = 0;
        
        for (const file of files) {
            const filePath = path.join(ORDER_DOWNLOAD_FOLDER, file);
            if (path.extname(file).toLowerCase() === '.csv' || path.extname(file).toLowerCase() === '.xlsx') {
                
                console.log(` -> 发现未归档文件: ${file}`);
                
                const workbook = xlsx.readFile(filePath);
                const sheetName = workbook.SheetNames[0];
                
                // 确保读取时将数据转换为对象数组（列名作为键）
                let rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false });
                
                // 深度检查第一行是否包含主键 (需先进行键名清洗，但这里先进行基本检查)
                const firstRow = rawData.length > 0 ? rawData[0] : {};
                const hasPrimaryKey = Object.keys(firstRow).some(key => String(key).trim() === ORDER_PRIMARY_KEY);

                if (rawData.length === 0 || !hasPrimaryKey) {
                     console.log(`   - ⚠️ [文件无效] 文件 [${file}] 数据为空或缺少主键 "${ORDER_PRIMARY_KEY}"，跳过处理。`);
                     await moveFileToArchive(filePath, ORDER_ARCHIVE_FOLDER); // 数据无效也归档
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


// ======================= [推广报表下载任务 (不变)] =======================
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
 * @param {import('playwright').Page} page - Playwright Page 对象.
 */
async function pddPromotionReportTask(page) {
    console.log(`\n--- 📈 [任务 2/3] 正在执行推广报表下载和数据库导入任务 ---`);

    // 1. 获取范围内“已有”的日期
    const existingDatesSet = await getExistingPromotionDatesFromFiles(PROMOTION_DOWNLOAD_FOLDER, PROMOTION_CHECK_PAST_DAYS);

    // 2. 生成范围内“应有”的日期
    const requiredDates = [];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - PROMOTION_CHECK_PAST_DAYS);
    startDate.setHours(0, 0, 0, 0);

    let currentDate = new Date(startDate);
    while (currentDate <= yesterday) {
        requiredDates.push(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    console.log(`推广报表理论上应有 ${requiredDates.length} 天的数据 (从 ${formatDate(startDate)} 到 ${formatDate(yesterday)})。`);

    // 3. 对比，计算出“缺失”的日期
    const datesToDownload = requiredDates.filter(date => !existingDatesSet.has(date));


    if (datesToDownload.length === 0) {
        console.log(`✅ 最近 ${PROMOTION_CHECK_PAST_DAYS} 天的推广报表数据完整，无需下载。`);
        return;
    }

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
        }
        console.log('\n--- 所有推广报表文件均已导入数据库 ---');
    }
}


// +++ [改动位置 2: 订单报表辅助函数] +++

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

// ======================= [订单报表下载任务 (优化)] =======================

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
            
            // 步骤 H: 点击“生成报表”并等待跳转 (优化：不再使用 waitForURL)
            const generateReportButton = page.getByRole('button', { name: '生成报表' });

            await generateReportButton.click();
            console.log(' -> 已点击“生成报表”。等待报表生成和自动跳转 (固定等待 10 秒)...');
            
            // ⚠️ 关键修改：移除 page.waitForURL。改为固定等待时间，假设跳转成功。
            await page.waitForTimeout(10000); 
            
            // 步骤 I: 优化：主动导航到报表列表页，确保 Page Context 正确
            console.log(` -> 主动导航到报表列表页: ${REPORT_LIST_URL}`);
            await page.goto(REPORT_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000); // 确保列表内容加载完成

            // 步骤 J (原 I): 监听下载并点击最新的“下载报表”按钮
            console.log(' -> 正在查找“下载报表”按钮...');
            const downloadPromise = page.waitForEvent('download', { timeout: 120000 }); // 延长下载超时时间

            const firstReportBox = page.locator('.list .download-box').first();
            const downloadButton = firstReportBox.getByRole('button', { name: '下载报表' }); 
            
            await firstReportBox.waitFor({ state: 'visible', timeout: 30000 });
            await downloadButton.waitFor({ state: 'visible', timeout: 10000 });
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


// +++ [改动位置 3: 重写退款数据更正函数] +++
/**
 * 【重写】从 pddorder 表中读取非退款数据，按 ID + 日期 统计数据，并覆盖 pinduoduo_sales_flow 表中对应的字段。
 * 实现“去退”逻辑：统计非退数据，作为修正后的实际销售数据。
 */
async function recalculateNonRefundSales() {
    console.log('\n======================================================');
    console.log(`--- 启动非退款销售数据修正任务 (数据源: ${DB_ORDER_TABLE_NAME}, 目标表: ${VIOMI_TARGET_DB_TABLE_NAME}) ---`);
    
    let db = null;
    let nonRefundSummary = null;
    
    try {
        console.log(`-> 正在连接数据库: ${CENTRAL_DB_PATH}`);
        db = new Database(CENTRAL_DB_PATH, { fileMustExist: true });
        
        // 1. 确保 pddorder 表存在且包含关键列
        const requiredColsInOrder = [SRC_COL_ORDER_STATUS, SRC_COL_PRODUCT_ID, SRC_COL_QUANTITY, SRC_COL_AMOUNT, SRC_COL_DATE];
        
        const orderTableInfo = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all();
        const orderColumns = orderTableInfo.map(col => col.name);
        
        // 由于列名在导入时已被转义，我们需要检查转义后的列名是否存在
        const srcStatusSanitized = SRC_COL_ORDER_STATUS.replace(/[\s\.\-\/\\()]/g, '_');
        const srcProductIdSanitized = SRC_COL_PRODUCT_ID.replace(/[\s\.\-\/\\()]/g, '_');
        const srcQuantitySanitized = SRC_COL_QUANTITY.replace(/[\s\.\-\/\\()]/g, '_');
        const srcAmountSanitized = SRC_COL_AMOUNT.replace(/[\s\.\-\/\\()]/g, '_');
        const srcDateSanitized = SRC_COL_DATE.replace(/[\s\.\-\/\\()]/g, '_');
        
        const sanitizedColsInOrder = [srcStatusSanitized, srcProductIdSanitized, srcQuantitySanitized, srcAmountSanitized, srcDateSanitized];
        const missingOrderCols = sanitizedColsInOrder.filter(sanitizedCol => !orderColumns.includes(sanitizedCol));
            
        if (missingOrderCols.length > 0) {
            console.error(`❌ 错误: 数据库表 [${DB_ORDER_TABLE_NAME}] 缺少关键列。请确保订单导入已成功执行。缺失列名(转义后): ${missingOrderCols.join(', ')}。修正任务中止。`);
            return;
        }

        // 2. 【核心修改】查询 pddorder 表，筛选出 '非退款成功' 的订单数据
        const selectNonRefundQuery = `
            SELECT 
                "${srcProductIdSanitized}" AS productId,
                "${srcQuantitySanitized}" AS quantity,
                "${srcAmountSanitized}" AS amount,
                "${srcDateSanitized}" AS date
            FROM "${DB_ORDER_TABLE_NAME}"
            -- 筛选非退款订单 (即订单状态不包含 '退款成功' 的订单)
            WHERE "${srcStatusSanitized}" NOT LIKE '%退款成功%' 
              AND "${srcDateSanitized}" IS NOT NULL 
              AND "${srcProductIdSanitized}" IS NOT NULL;
        `;
        
        console.log('-> 正在查询 pddorder 表以提取非退款订单进行统计...');
        const nonRefundRows = db.prepare(selectNonRefundQuery).all();
        
        if (nonRefundRows.length === 0) {
            console.log("-> pddorder 表中未发现有效的非退款订单数据，无需更新数据库。");
            return;
        }
        
        // 3. 按 商品ID + 日期 进行分组统计 (现在统计的是非退款销售总量)
        const summaryMap = new Map();
        
        for (const row of nonRefundRows) {
            const productId = String(row.productId).trim();
            const dateString = row.date;
            
            // 确保数量和金额是数字 (并处理可能的空值)
            const quantity = parseFloat(row.quantity) || 0;
            const amount = parseFloat(row.amount) || 0;
            
            const key = `${productId}_${dateString}`;
            
            const current = summaryMap.get(key) || {
                productId: productId,
                date: dateString,
                non_refund_orders: 0, 
                non_refund_quantity: 0,
                non_refund_amount: 0
            };

            current.non_refund_orders += 1; // 每个非退订单算作一个订单
            current.non_refund_quantity += quantity;
            current.non_refund_amount += amount;
            summaryMap.set(key, current);
        }
        
        nonRefundSummary = Array.from(summaryMap.values());
        
    } catch (error) {
        console.error(`❌ 读取或处理数据库中的非退款数据时出错: ${error.message}`);
        if (db) db.close();
        return;
    } 
    // 数据库连接留给下一步更新操作

    // 4. 结果展示和用户确认
    if (nonRefundSummary.length === 0) {
        console.log("-> 没有有效数据需要更正。");
        if (db) db.close();
        return;
    }
    
    console.log(`\n📦 分析结果：共找到 ${nonRefundSummary.length} 组 '商品ID + 日期' 的非退款销售数据。`);
    console.log('------------------------------------------------------');
    
    let totalOrders = 0;
    let totalAmount = 0;
    
    // 打印前几条详细信息
    nonRefundSummary.slice(0, 10).forEach(item => {
        totalOrders += item.non_refund_orders;
        totalAmount += item.non_refund_amount;
        console.log(`| 日期: ${item.date} | ID: ${item.productId.padEnd(15)} | 订单数(非退): ${String(item.non_refund_orders).padEnd(4)} | 金额(非退): ${item.non_refund_amount.toFixed(2)} 元`);
    });
    
    if (nonRefundSummary.length > 10) {
        // 确保计算所有总数
        const remainingOrders = nonRefundSummary.slice(10).reduce((acc, item) => acc + item.non_refund_orders, 0);
        const remainingAmount = nonRefundSummary.slice(10).reduce((acc, item) => acc + item.non_refund_amount, 0);
        totalOrders += remainingOrders;
        totalAmount += remainingAmount;
        console.log(`| ... (省略 ${nonRefundSummary.length - 10} 条记录)`);
    }
    
    console.log('------------------------------------------------------');
    console.log(`总共统计到 ${totalOrders} 个非退款订单。`);
    console.log(`非退款总金额约为：${totalAmount.toFixed(2)} 元。`);
    
    // 询问用户是否同意
    const confirmation = await askQuestion(`\n⚠️ 请确认是否同意执行数据库【覆盖】操作，用这 ${totalOrders} 个非退款订单数据修正 ${VIOMI_TARGET_DB_TABLE_NAME} 表? (输入 "是" 或 "y" 继续，其他则取消): `);

    if (!confirmation) {
        console.log('✅ 用户取消操作。非退款销售修正任务中止。');
        console.log('--- 非退款销售修正任务结束 ---');
        console.log('======================================================');
        if (db) db.close();
        return;
    }

    // 5. 执行数据库更新 (匹配 ID 和 日期)，执行覆盖式更新
    try {
        console.log(`-> 正在执行对目标表 ${VIOMI_TARGET_DB_TABLE_NAME} 的【覆盖】修正操作...`);

        // 【核心修改】 SQL 语句：使用商品ID和日期进行精确匹配更新，用统计值【覆盖】原有值。
        const updateStmt = db.prepare(`
            UPDATE "${VIOMI_TARGET_DB_TABLE_NAME}"
            SET 
                "${DB_COL_REFUND_PAY_ORDERS}" = ?, 		 -- 覆盖订单数
                "${DB_COL_REFUND_PAY_QUANTITY}" = ?, 	 -- 覆盖商品件数
                "${DB_COL_REFUND_PAY_AMOUNT}" = ? 	     -- 覆盖支付金额
            WHERE 
                "${DB_COL_REFUND_PRODUCT_ID}" = ? AND "${DB_COL_DATE}" = ?
        `);
        
        const updateAll = db.transaction((summary) => {
            let updateCount = 0;
            for (const item of summary) {
                const info = updateStmt.run(
                    item.non_refund_orders,     // 1. 非退款订单数
                    item.non_refund_quantity,   // 2. 非退款商品件数
                    item.non_refund_amount,     // 3. 非退款金额
                    item.productId,             // 4. 商品ID (WHERE 条件)
                    item.date                   // 5. 日期 (WHERE 条件)
                );
                if (info.changes > 0) {
                    updateCount += info.changes; // 记录更新的行数
                }
            }
            return updateCount;
        });

        const updatedRows = updateAll(nonRefundSummary);

        console.log(`✅ 数据库修正完成! 成功【覆盖更新】了 ${updatedRows} 条 '商品ID + 日期' 记录。`);

    } catch (error) {
        console.error(`❌ 数据库修正操作失败: ${error.message}`);
    } finally {
        if (db) {
            db.close();
            console.log('-> 数据库连接已关闭。');
        }
    }
    console.log('--- 非退款销售修正任务结束 ---');
    console.log('======================================================');
}


// +++ [改动位置 4: 主入口函数] +++
async function main() {
    console.log(`\n--- 🚀 [ALL-IN-ONE] 启动拼多多综合任务脚本 ---`);

    let context;
    let page;

    try {
        // 检查用户配置目录
        console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
        try { 
            // 使用 fs.promises 访问
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

        // 1. 执行提额任务
        await pddQuotaIncreaseTask(page);
        
        // 2. 执行推广报表下载和数据库导入任务
        await pddPromotionReportTask(page);
        
        // 3. 执行订单报表下载、导入及归档任务
        await pddOrderDownloadAndImportTask(page);

    } catch (error) {
        console.error('❌ 脚本在执行过程中遇到严重错误:', error.message);
    } finally {
        if (context) {
            // 5. 【修改】确保在浏览器关闭后，执行非退款销售修正任务
            await recalculateNonRefundSales();
            
            await context.close(); 
            console.log('\n🔚 浏览器已关闭，脚本所有任务执行结束。');
        } else {
            // 如果浏览器启动失败，但需要执行非退款销售修正（前提是pddorder表中有数据）
            await recalculateNonRefundSales();
        }
    }

    console.log('\n🎉 脚本所有任务执行完毕！');
}

main();