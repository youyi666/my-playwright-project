// viomi-download-script.js - 最终修正版 V9 (核心逻辑更新：自动适配 Excel 列变化，并从 pddorder 数据库表读取非退款数据，覆盖修正每日销售统计)
//
// 核心逻辑：
// 1. 检查从2025-01-01到昨天的全部日期，与数据库中已有日期进行比对，找出所有缺失的日期。
// 2. 扫描下载文件夹中的所有Excel文件，通过文件内容日期建立映射。
// 3. 执行“仅导入”和“下载并导入”的日常数据导入任务。
//    【重要改动：在导入时，如果目标表不存在，将自动创建；如果表存在但缺少 Excel 中的列，将自动使用 ALTER TABLE 追加缺失的列。列类型设置为 '日期', '商品名称', '类目' 和 '账号' 字段为 TEXT，其他数字字段为 REAL (小数)。】
// 4. 【新增安全覆盖流程】在所有导入完成后，读取指定的订单数据库表，按 [商品ID] + [日期] 汇总非“退款成功”的订单数据，询问用户确认后，精确覆盖数据库中的每日支付数据。

import { chromium } from 'playwright';
import path from 'path';
import * as fs from 'fs'; // [改动 1.1] 修改：使用 * as fs 引入，确保能够访问 fs.promises
import Database from 'better-sqlite3';
import xlsx from 'xlsx';
// 🚀 新增：引入 readline 模块用于在命令行中询问用户
import readline from 'readline'; 
import { fileURLToPath } from 'url'; // [改动 1.2] 新增：ESM 兼容

// --------------------------- [ESM 兼容性修改 - 开始] ---------------------------
// [改动 1.3] 定义 __filename 和 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --------------------------- [ESM 兼容性修改 - 结束] ---------------------------


// --- 配置区域 ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// [改动 2.1: 下载目录 - 相对路径]
// 原始: const DOWNLOAD_DIRECTORY = 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\拼多多';
const DOWNLOAD_DIRECTORY = path.join(__dirname, 'exc_data', '平台获取-商品销售流量', '拼多多');

// [改动 2.2: 目标 DB 路径 - 相对路径]
// 原始: const DB_FILE = 'Z:\\天猫生意参谋\\TmallDataCenter.db'; // 目标表所在的数据库文件
const DB_FILE = path.join(__dirname, 'sql_data', 'TmallDataCenter.db'); // 目标表所在的数据库文件
const DB_TABLE_NAME = 'pinduoduo_sales_flow'; // 目标表名

// [改动 4.1: 新增归档目录配置]
const ARCHIVE_DIRECTORY = path.join(DOWNLOAD_DIRECTORY, '已导入');

// 🚀 【订单数据源配置区域】用于非退款数据覆盖修正 -------------------------------------
// [改动 2.3: 订单 DB 路径 - 相对路径]
// 原始: const ORDER_DB_FILE = 'Z:\\天猫生意参谋\\TmallDataCenter.db'; // 订单数据库文件 (与 DB_FILE 相同)
const ORDER_DB_FILE = path.join(__dirname, 'sql_data', 'TmallDataCenter.db'); // 订单数据库文件 (与 DB_FILE 相同)
const ORDER_DB_TABLE = 'pddorder'; // 订单表名 (您的新数据源)

// 订单表 pddorder 中的列名 (请根据实际情况核对和修改!)
const COL_ORDER_STATUS = '订单状态';         // 订单状态列
const COL_ORDER_PRODUCT_ID = '商品id';             // 商品ID列 (用于匹配分组)
const COL_ORDER_QUANTITY = '商品数量_件_';         // 商品数量列
const COL_ORDER_AMOUNT = '商家实收金额_元_';       // 商家实收金额列
const COL_ORDER_PAY_TIME = '支付时间'; // <--- 关键：数据库中用于确定日期的列名 (TEXT格式)

// 数据库 pinduoduo_sales_flow 表中需要更新的列名 (请根据实际情况核对和修改!)
const DB_COL_REFUND_PAY_ORDERS = '支付订单数';    // 需覆盖为非退款订单数
const DB_COL_REFUND_PAY_QUANTITY = '支付商品件数'; // 需覆盖为非退款商品件数
const DB_COL_REFUND_PAY_AMOUNT = '支付金额';        // 需覆盖为非退款支付金额
const DB_COL_REFUND_PRODUCT_ID = '商品ID';          // 数据库中用于匹配的商品ID列名
const DB_COL_DATE = '日期'; // <--- 关键：数据库中的日期列名
// --------------------------------------------------------------------------------------


// --- 函数定义区域 ---

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

// [改动 3: 新增归档函数] 移动文件到归档目录
/**
 * 移动文件到归档目录
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
 * 🚀【已移除】处理 Excel 数字格式日期到 JS Date 对象的函数 (因数据源改为 DB，不再需要)
 * 仅保留一个简单的空函数作为占位或兼容（但在此版本中不应被调用）。
 */
function excelDateToJSDate(excelDays) {
    // 逻辑已不再使用，此版本仅处理 DB 中的 TEXT 格式日期
    const excelEpoch = new Date(1899, 11, 30); 
    return excelEpoch.getTime() + excelDays * 24 * 60 * 60 * 1000;
}


/**
 * 扫描指定目录下的所有 .xlsx 文件，读取其内容，并根据第一行数据的“日期”列建立一个映射。
 * (逻辑不变，但需注意内部仍依赖 excelDateToJSDate 来处理下载的 Excel 文件中的日期)
 */
function mapFilesByDateContent(directory) {
    const dateToFileMap = new Map();
    console.log(`\n🔍 正在扫描目录 [${directory}] 中的文件内容...`);

    if (!fs.existsSync(directory)) {
        console.log(`⚠️ 目录不存在，无法扫描本地文件。`);
        return dateToFileMap;
    }
    
    // [改动 5.1: 排除归档目录中的文件]
    const allFiles = fs.readdirSync(directory).filter(file => 
        file.toLowerCase().endsWith('.xlsx') && path.resolve(path.join(directory, file)) !== path.resolve(ARCHIVE_DIRECTORY)
    );
    console.log(`📂 发现 ${allFiles.length} 个 .xlsx 文件（排除归档目录），开始逐一解析...`);

    for (const file of allFiles) {
        const filePath = path.join(directory, file);
        try {
            const workbook = xlsx.readFile(filePath);
            if (!workbook.SheetNames.length) {
                console.log(`   - 🟡 文件 [${file}] 为空或格式不正确，已跳过。`);
                continue;
            }

            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            
            const header = xlsx.utils.sheet_to_json(worksheet, { header: 1, range: 0 })[0] || [];
            const firstDataRow = xlsx.utils.sheet_to_json(worksheet)[0];

            if (!firstDataRow) {
                console.log(`   - 🟡 文件 [${file}] 没有数据行，已跳过。`);
                continue;
            }

            const dateColumnName = '日期';
            if (!header.includes(dateColumnName) || !firstDataRow[dateColumnName]) {
                 console.log(`   - 🟡 文件 [${file}] 中未找到有效的'日期'列或值，已跳过。`);
                continue;
            }

            const dateValue = firstDataRow[dateColumnName];
            let dateString = '';

            // --- 日期值标准化逻辑 (与 importExcelToDb 保持一致) ---
            if (typeof dateValue === 'number') {
                const jsDate = new Date(excelDateToJSDate(dateValue));
                dateString = getLocalDateString(jsDate);
            } else {
                const jsDate = new Date(dateValue);
                dateString = getLocalDateString(jsDate);
            }
            // --- 日期值标准化逻辑 结束 ---

            if (dateString) {
                if (dateToFileMap.has(dateString)) {
                    console.log(`   - ⚠️ 发现内容日期为 [${dateString}] 的重复文件: [${file}]。将使用后者覆盖。`);
                }
                dateToFileMap.set(dateString, filePath);
                 console.log(`   - ✅ 文件 [${file}] 的内容日期解析为: [${dateString}]`);
            } else {
                 console.log(`   - 🔴 文件 [${file}] 中的日期值无法解析，已跳过。`);
            }

        } catch (error) {
            console.error(`   - ❌ 读取或解析文件 [${file}] 时出错: ${error.message}`);
        }
    }
    console.log(`\n🗺️ 文件内容扫描完成，共建立 ${dateToFileMap.size} 个有效日期映射。`);
    return dateToFileMap;
}


/**
 * 从数据库中获取所有已存在的日期
 */
function getAllDatesFromDB() {
    try {
        // 确保数据库目录存在
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
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
 */
function generateDateRange(start, end) {
    const dates = [];
    let currentDate = new Date(start);
    while (currentDate <= end) {
        dates.push(getLocalDateString(currentDate)); 
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
}


/**
 * 负责将 Excel 文件数据导入到 SQLite 数据库。
 * (已修改：增加自动建表和【自动追加缺失列】的功能，并精确设置 TEXT 列)
 * @param {string} filePath - Excel文件路径
 * @returns {Promise<boolean>} 导入是否成功
 */
async function importExcelToDb(filePath) {
    console.log(`🔄 正在准备导入文件: ${path.basename(filePath)}`);
    try {
        const db = new Database(DB_FILE); 
        const workbook = xlsx.readFile(filePath); 
        const sheetName = workbook.SheetNames[0]; 
        const worksheet = workbook.Sheets[sheetName]; 
        const data = xlsx.utils.sheet_to_json(worksheet);

        if (data.length === 0) { 
            console.log('⚠️ 文件为空，无需导入。'); 
            db.close(); 
            return true; 
        }

        const columns = Object.keys(data[0]); 
        
        // --------------------------- [改动 11: 重新定义 TEXT 列列表 - 开始] ---------------------------
        
        // 定义必须设置为 TEXT 类型的列名集合，以保证文本/标识符不被错误地当作数字处理
        const TEXT_COLUMNS = new Set([
            '日期',          // 日期
            '商品ID',        // 商品ID (商品ID通常是字符串，也需要TEXT)
            '商品名称',      // 文本/标识符
            '一级类目',      // 文本/标识符
            '二级类目',      // 文本/标识符
            '三级类目',      // 文本/标识符
            '抓数账号',      // 文本/标识符 (旧列名)
            '取数账号'       // 文本/标识符 (新列名)
        ]);

        // 辅助函数：根据列名判断应使用的 SQLite 数据类型 
        const getColumnType = (colName) => {
            if (TEXT_COLUMNS.has(colName)) {
                return 'TEXT'; // 文本类型 (例如日期、名称、账号)
            }
            return 'REAL'; // 其他所有列默认为 REAL (浮点小数，用于所有数字和金额，符合 type number 要求)
        };
        
        // 1. 生成列定义并确保表存在 (使用当前 Excel 文件的所有列)
        const columnDefinitions = columns.map(col => `"${col}" ${getColumnType(col)}`).join(', '); 
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (
                ${columnDefinitions}
            )
        `;
        db.prepare(createTableSql).run();
        console.log(`  -> 数据库表 [${DB_TABLE_NAME}] 已确保存在。`);

        // 2. 检查并追加缺失的列 (解决列变化问题，如 '抓数账号' 变为 '取数账号')
        // PRAGMA table_info 查询现有列的详细信息
        const existingColumnsResult = db.prepare(`PRAGMA table_info(${DB_TABLE_NAME})`).all();
        // 提取数据库中所有列的名称
        const existingColumnNames = new Set(existingColumnsResult.map(col => col.name));
        
        let columnsAdded = 0;

        for (const col of columns) {
            // 检查 Excel 文件中的列是否在数据库中存在 (注意：数据库列名不带双引号)
            if (!existingColumnNames.has(col)) {
                const columnType = getColumnType(col);
                // 使用 ALTER TABLE ADD COLUMN 追加缺失的列
                const alterTableSql = `ALTER TABLE ${DB_TABLE_NAME} ADD COLUMN "${col}" ${columnType}`;
                db.prepare(alterTableSql).run();
                console.log(`  -> 成功追加缺失的列: "${col}" (${columnType})。`);
                columnsAdded++;
            }
        }
        
        if (columnsAdded > 0) {
             console.log(`  -> 数据库结构更新完成，共追加 ${columnsAdded} 个新列。`);
        } else {
             console.log(`  -> 数据库结构与当前 Excel 文件匹配，无需追加新列。`);
        }
        
        // --------------------------- [改动 11: 重新定义 TEXT 列列表 - 结束] ---------------------------
        
        
        // 3. 准备和执行插入操作 (使用当前 Excel 的所有列)
        const insertColumnNames = columns.map(col => `"${col}"`).join(', '); 
        const placeholders = columns.map(() => '?').join(', '); 
        
        const insertStmt = db.prepare(`INSERT INTO ${DB_TABLE_NAME} (${insertColumnNames}) VALUES (${placeholders})`);
        
        const insertMany = db.transaction((rows) => {
            for (const row of rows) {
                const values = columns.map(col => row[col]); 
                const dateIndex = columns.indexOf('日期');
                
                // 日期转换逻辑保持不变
                if (dateIndex !== -1 && values[dateIndex]) {
                    if (typeof values[dateIndex] === 'number') {
                        const jsDate = new Date(excelDateToJSDate(values[dateIndex])); 
                        values[dateIndex] = getLocalDateString(jsDate); 
                    } else { 
                        values[dateIndex] = getLocalDateString(new Date(values[dateIndex])); 
                    }
                }
                
                insertStmt.run(...values);
            }
        });

        insertMany(data); 
        console.log(`✅ 成功导入 ${data.length} 条数据到数据库。`); 
        db.close(); 
        return true;
    } catch (error) { 
        console.error(`❌ 文件导入数据库时出错: ${error}`); 
        return false; 
    }
}

/**
 * 🚀 新增：询问用户是否同意操作
 * @param {string} question - 要询问的问题
 * @returns {Promise<boolean>} 用户是否同意
 */
function askQuestion(question) {
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


// 🚀 【重写核心函数】用于从 DB 读取非退款数据并按 ID 和日期 安全覆盖修正数据库 --------------------------
/**
 * 读取订单数据库表，按 ID + 日期 统计非“退款成功”的订单数据，并安全地覆盖修正数据库中对应每日销售数据。
 * @param {string} orderDbPath - 订单数据库文件的路径。
 * @param {string} orderTableName - 订单表名。
 * @param {string} targetDbPath - 目标数据库文件的路径。
 * @param {string} targetTableName - 目标表名。
 */
async function overwriteSalesDataWithNonRefunds(orderDbPath, orderTableName, targetDbPath, targetTableName) { 
    
    // [改动 6: 修复作用域错误，确保常量在函数内可用]
    const CONSTANTS = {
        COL_ORDER_PRODUCT_ID, COL_ORDER_PAY_TIME, COL_ORDER_QUANTITY, COL_ORDER_AMOUNT, COL_ORDER_STATUS,
        DB_COL_REFUND_PAY_ORDERS, DB_COL_REFUND_PAY_QUANTITY, DB_COL_REFUND_PAY_AMOUNT, 
        DB_COL_REFUND_PRODUCT_ID, DB_COL_DATE
    };
    
    console.log('\n======================================================');
    console.log('--- 启动非退款数据覆盖任务 (数据源: DB, 安全模式：按日期和ID匹配) ---');
    console.log(`-> 正在连接订单数据库: ${orderDbPath} 表: ${orderTableName}`);

    let orderDb = null;
    let salesSummary = null;
    
    try {
        // 1. 连接订单数据库并查询非退款订单
        orderDb = new Database(orderDbPath, { fileMustExist: true });

        // SQL 查询：排除订单状态包含 '退款成功' 的记录
        const sql = `
            SELECT 
                "${CONSTANTS.COL_ORDER_PRODUCT_ID}" AS productId, 
                "${CONSTANTS.COL_ORDER_PAY_TIME}" AS payTime, 
                "${CONSTANTS.COL_ORDER_QUANTITY}" AS quantity, 
                "${CONSTANTS.COL_ORDER_AMOUNT}" AS amount
            FROM ${orderTableName}
            WHERE 
                "${CONSTANTS.COL_ORDER_STATUS}" NOT LIKE '%退款成功%' 
                AND "${CONSTANTS.COL_ORDER_STATUS}" NOT LIKE '%待付款%' 
                AND "${CONSTANTS.COL_ORDER_STATUS}" NOT LIKE '%已取消%'
                AND "${CONSTANTS.COL_ORDER_PAY_TIME}" IS NOT NULL
        `;

        const nonRefundRows = orderDb.prepare(sql).all();

        if (nonRefundRows.length === 0) {
            console.log("-> 未发现 '非退款成功' 的订单数据，无需更新数据库。"); 
            orderDb.close();
            return;
        }
        
        console.log(`-> 成功查询到 ${nonRefundRows.length} 条非退款订单记录。`);

        // 2. 按 商品ID + 日期 进行分组统计
        const summaryMap = new Map();
        
        for (const row of nonRefundRows) { 
            
            // 增强的商品ID清理逻辑：处理双引号、制表符和多余空格
            let productId = row.productId;
            if (productId !== null && productId !== undefined) {
                 productId = String(productId).replace(/\s+/g, '').replace(/["']/g, '').trim();
            }
            
            // 提取支付时间并转换为 YYYY-MM-DD 格式 (假设 DB 存储为 YYYY-MM-DD HH:MM:SS 或类似的 TEXT 格式)
            let dateString = '';
            const dateValue = row.payTime;
            if (dateValue) {
                // 订单表中的支付时间是 TEXT 格式，直接解析
                const jsDate = new Date(dateValue); 
                dateString = getLocalDateString(jsDate);
            }
            
            // 确保 ID 和日期都干净且存在
            if (productId && dateString) {
                const key = `${productId}_${dateString}`;
                // 确保数量和金额是数字 (DB 中可能存为 TEXT，需转换)
                const quantity = parseFloat(row.quantity) || 0;
                const amount = parseFloat(row.amount) || 0;
                
                const current = summaryMap.get(key) || {
                    productId: productId,
                    date: dateString,
                    payment_orders: 0,
                    payment_quantity: 0,
                    payment_amount: 0
                };

                current.payment_orders += 1;
                current.payment_quantity += quantity;
                current.payment_amount += amount;
                summaryMap.set(key, current);
            }
        }
        
        salesSummary = Array.from(summaryMap.values());
        
    } catch (error) {
        // [改动 6.1: 增强错误提示]
        console.error(`❌ 读取或处理订单数据库时出错: ${error.message}. 请检查配置文件中订单表列名是否与数据库匹配。`);
        return;
    } finally {
        if (orderDb) {
            orderDb.close();
            console.log('-> 订单数据库连接已关闭。');
        }
    }

    // 3. 结果展示和用户确认
    if (salesSummary.length === 0) {
        console.log("-> 没有有效数据需要更正。");
        return;
    }
    
    // [改动 7: 修正总数计算逻辑，确保计算整个 summary]
    let totalPaymentOrders = salesSummary.reduce((sum, item) => sum + item.payment_orders, 0);
    let totalPaymentAmount = salesSummary.reduce((sum, item) => sum + item.payment_amount, 0);

    console.log(`\n📦 分析结果：共找到 ${salesSummary.length} 组 '商品ID + 日期' 的非退款数据。`);
    console.log('------------------------------------------------------');
    
    // 打印前几条详细信息
    // [改动 7.1: 仅用于打印前 10 条，不用于累加]
    salesSummary.slice(0, 10).forEach(item => {
        // 原始代码在此处有累加，但已在上文被 reduce 取代，此处不再需要累加
        console.log(`| 日期: ${item.date} | ID: ${item.productId.padEnd(15)} | 订单数(非退): ${String(item.payment_orders).padEnd(4)} | 金额(非退): ${item.payment_amount.toFixed(2)} 元`);
    });
    
    if (salesSummary.length > 10) {
        console.log(`| ... (省略 ${salesSummary.length - 10} 条记录)`);
    }
    
    console.log('------------------------------------------------------');
    console.log(`总共统计到 ${totalPaymentOrders} 个非退款订单需要覆盖修正。`); // 使用了修正后的总数
    console.log(`非退款总金额约为：${totalPaymentAmount.toFixed(2)} 元。`); // 使用了修正后的总金额
    
    // 询问用户是否同意
    const confirmation = await askQuestion('\n⚠️ 请确认是否同意执行数据库覆盖修正操作 (输入 "是" 或 "y" 继续，其他则取消): ');

    if (!confirmation) {
        console.log('✅ 用户取消操作。数据覆盖修正任务中止。');
        console.log('--- 数据覆盖修正任务结束 ---');
        console.log('======================================================');
        return;
    }

    // 4. 执行数据库更新 (匹配 ID 和 日期，并进行覆盖操作)
    let targetDb = null; // 👈 目标数据库连接
    try {
        console.log(`-> 正在连接目标数据库: ${targetDbPath}`);
        targetDb = new Database(targetDbPath, { fileMustExist: true });

        // SQL 语句：使用商品ID和日期进行精确匹配更新 (覆盖)
        const updateStmt = targetDb.prepare(`
            UPDATE ${targetTableName}
            SET 
                "${CONSTANTS.DB_COL_REFUND_PAY_ORDERS}" = ?, 
                "${CONSTANTS.DB_COL_REFUND_PAY_QUANTITY}" = ?, 
                "${CONSTANTS.DB_COL_REFUND_PAY_AMOUNT}" = ?
            WHERE 
                "${CONSTANTS.DB_COL_REFUND_PRODUCT_ID}" = ? AND "${CONSTANTS.DB_COL_DATE}" = ?
        `);
        
        const updateAll = targetDb.transaction((summary) => {
            let updateCount = 0;
            for (const item of summary) {
                const info = updateStmt.run(
                    item.payment_orders,       // 1. 支付订单数 (非退)
                    item.payment_quantity,     // 2. 支付商品件数 (非退)
                    item.payment_amount,       // 3. 支付金额 (非退)
                    item.productId,           // 4. 商品ID (WHERE 条件)
                    item.date                 // 5. 日期 (WHERE 条件)
                );
                if (info.changes > 0) {
                    updateCount += 1;
                }
            }
            return updateCount;
        });

        const updatedRows = updateAll(salesSummary);

        console.log(`✅ 数据库覆盖修正完成! 成功更新了 ${updatedRows} 条 '商品ID + 日期' 记录。`);

    } catch (error) {
        console.error(`❌ 数据库覆盖修正操作失败: ${error.message}`);
    } finally {
        if (targetDb) {
            targetDb.close();
            console.log('-> 目标数据库连接已关闭。');
        }
    }
    console.log('--- 数据覆盖修正任务结束 ---');
    console.log('======================================================');
}
// --------------------------------------------------------------------------------------


async function clearDownloadList(page) {
// ... (下载流程函数保持不变)
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
// ... (下载流程函数保持不变)
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
    // 检查环境变量
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) { console.error('错误：请先设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。'); process.exit(1); }
    
    console.log('--- 任务初始化：正在检查数据完整性 ---');
    
    // 日常数据导入逻辑开始
    const startDate = new Date('2025-01-01');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const requiredDates = generateDateRange(startDate, yesterday);
    console.log(`🗓️ 需要检查的日期范围: ${requiredDates[0]} 到 ${requiredDates[requiredDates.length - 1]}`);

    const existingDatesInDb = getAllDatesFromDB();

    const missingDates = requiredDates.filter(date => !existingDatesInDb.has(date));

    // 路径 A: 无需执行下载任务
    if (missingDates.length === 0) {
        console.log('👍 数据库中的数据已是最新且完整，无需执行日常下载任务。');
        
        // 📌 改动位置 A: 如果日常下载流程跳过，直接执行数据覆盖修正
        await overwriteSalesDataWithNonRefunds(ORDER_DB_FILE, ORDER_DB_TABLE, DB_FILE, DB_TABLE_NAME); 
        // -------------------------------------------------------------
        
        console.log('脚本执行完毕。');
        return;
    }
    console.log(`\n❗️ 在数据库中发现 ${missingDates.length} 个缺失的日期: [${missingDates.join(', ')}]`);

    // 检查本地文件内容，建立日期映射
    const localFileDateMap = mapFilesByDateContent(DOWNLOAD_DIRECTORY);
    
    const tasksToImportOnly = [];
    const tasksToDownload = [];

    for (const date of missingDates) {
        if (localFileDateMap.has(date)) {
            tasksToImportOnly.push(localFileDateMap.get(date));
        } else {
            tasksToDownload.push(date);
        }
    }

    // --- 任务分配与执行 ---
    
    if (tasksToImportOnly.length > 0) {
        console.log(`\n--- 步骤 A: 执行仅导入任务 (${tasksToImportOnly.length} 个) ---`);
        console.log(`   - 待导入文件: [${tasksToImportOnly.map(p => path.basename(p)).join(', ')}]`);
        for (const filePath of tasksToImportOnly) {
            const importSuccess = await importExcelToDb(filePath);
            
            // [改动 5.2: 仅导入任务成功后执行归档]
            if (importSuccess) {
                await moveFileToArchive(filePath, ARCHIVE_DIRECTORY);
            } else {
                console.warn(`⚠️ 文件 [${path.basename(filePath)}] 导入数据库失败，跳过归档。`);
            }
        }
        console.log('✅ 所有仅导入任务已完成。');
    } else {
        console.log('\nℹ️ 没有在本地发现内容日期匹配的、可直接导入的文件。');
    }

    // 路径 B: 无需启动浏览器（全部通过本地文件补齐）
    if (tasksToDownload.length === 0) {
        console.log('\n👍 所有缺失数据均已通过本地文件补齐，无需下载。');
        
        // 📌 改动位置 B: 如果日常下载流程在此时跳过，执行数据覆盖修正
        await overwriteSalesDataWithNonRefunds(ORDER_DB_FILE, ORDER_DB_TABLE, DB_FILE, DB_TABLE_NAME);
        // -------------------------------------------------------------
        
        console.log('脚本执行完毕。');
        return;
    }

    // 路径 C: 需要启动浏览器执行下载任务
    console.log(`\n--- 步骤 B: 执行下载并导入任务 (${tasksToDownload.length} 个) ---`);
    console.log(`   - 待下载日期: [${tasksToDownload.join(', ')}]`);

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
                const importSuccess = await importExcelToDb(downloadResult.savePath);
                
                // [改动 5.3: 下载并导入任务成功后执行归档]
                if (importSuccess) {
                     await moveFileToArchive(downloadResult.savePath, ARCHIVE_DIRECTORY);
                } else {
                     console.warn(`⚠️ 文件 [${path.basename(downloadResult.savePath)}] 导入数据库失败，跳过归档。`);
                }
                
            } else {
                console.error(`❗ 日期 [${dateString}] 的任务处理失败，将继续下一个任务...`);
            }
        }
        console.log('\n✅ 所有下载任务执行完毕。');

    } catch (error) {
        console.error('❌ 脚本在主流程中执行出错:', error);
    } finally {
        await browser.close();
        console.log('🔚 浏览器已关闭。');
        
        // 📌 改动位置 C: 确保在浏览器关闭后，执行数据覆盖修正
        await overwriteSalesDataWithNonRefunds(ORDER_DB_FILE, ORDER_DB_TABLE, DB_FILE, DB_TABLE_NAME);
        // -------------------------------------------------------------
        
        console.log('脚本执行结束。');
    }
}

// 运行主函数
main();