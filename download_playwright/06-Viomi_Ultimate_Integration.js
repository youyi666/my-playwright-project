// 05-Viomi_Ultimate_Integration.js
// 终极融合版：包含 TOP20 销售额抓取、拼多多销售流水下载/修正、中央库存同步
// 严格保留了原有 V20 版本的所有业务逻辑、UI 强力点击与中文注释

import { chromium } from 'playwright';
import path from 'path';
import * as fs from 'fs'; 
import Database from 'better-sqlite3';
import xlsx from 'xlsx';
import readline from 'readline'; 
import { fileURLToPath } from 'url'; 

// --------------------------- [ESM 兼容性修改 & 环境配置] ---------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// --- 共享数据库配置 ---
const DB_FILE = path.join(__dirname, '..', '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');

// ======================= [模块一：TOP20 专属配置] =======================
const TOP20_DOWNLOAD_DIR = path.join(__dirname, 'exc_data', 'TOP20_Sniper');
const TOP20_ARCHIVE_DIR = path.join(TOP20_DOWNLOAD_DIR, '已导入');
const TARGET_PLATFORMS = ['京东', '天猫', '拼多多', '有品']; 
const LOOKBACK_DAYS = 30; 

// ======================= [模块二：PDD 流水与库存专属配置] =======================
const PDD_DOWNLOAD_DIR = path.join(__dirname, 'exc_data', '平台获取-商品销售流量', '拼多多');
const PDD_ARCHIVE_DIR = path.join(PDD_DOWNLOAD_DIR, '已导入');
const DB_TABLE_NAME = 'pinduoduo_sales_flow'; // 目标表名

const ORDER_DB_FILE = DB_FILE; 
const ORDER_DB_TABLE = 'pddorder'; 
const COL_ORDER_STATUS = '订单状态';         
const COL_ORDER_PRODUCT_ID = '商品id';             
const COL_ORDER_QUANTITY = '商品数量_件_';         
const COL_ORDER_AMOUNT = '商家实收金额_元_';       
const COL_ORDER_PAY_TIME = '支付时间'; 

const DB_COL_REFUND_PAY_ORDERS = '支付订单数';    
const DB_COL_REFUND_PAY_QUANTITY = '支付商品件数'; 
const DB_COL_REFUND_PAY_AMOUNT = '支付金额';        
const DB_COL_REFUND_PRODUCT_ID = '商品ID';          
const DB_COL_DATE = '日期'; 

const TASKS_EXCEL_PATH = path.join(__dirname, '..', '..', '002号爬虫文件-Price_Scraper', 'tasks.xlsx');
const INVENTORY_DB_TABLE = 'viomi_central_inventory';

const ENABLE_PLATFORMS = {
    '京东': true,   
    '拼多多': true, 
    '天猫': true    
};

// ======================= [公共工具函数] =======================

function getLocalDateString(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function moveFileToArchive(sourcePath, archiveDir, newFileName = null) {
    console.log(' -> 正在执行文件归档操作...');
    try {
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
            console.log(` -> 归档目录 [${path.basename(archiveDir)}] 不存在，已创建。`);
        }
        const fileName = newFileName || path.basename(sourcePath); 
        const destPath = path.join(archiveDir, fileName);
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath); // 防止同名文件覆盖报错
        await fs.promises.rename(sourcePath, destPath); 
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        console.error(`❌ 文件归档失败 (${path.basename(sourcePath)}): ${e.message}`);
    }
}

function askQuestion(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(['y', 'yes', '是', '同意'].includes(answer.trim().toLowerCase()));
        });
    });
}

// 统一使用的强力清空下载列表函数 (取自老兵回归版的稳健逻辑)
async function clearDownloadList(page) {
    try {
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
        if (!await downloadManagerIcon.isVisible()) return;

        await downloadManagerIcon.click();
        await page.waitForTimeout(500);

        let retry = 0;
        while (retry < 20) {
            const deleteBtns = page.getByRole('button', { name: 'delete' });
            const count = await deleteBtns.count();
            if (count === 0) break;
            await deleteBtns.first().click();
            await page.waitForTimeout(300);
            retry++;
        }
        await page.keyboard.press('Escape'); 
        await page.waitForTimeout(300);
    } catch (error) {
        console.warn('      ⚠️ 清理列表轻微异常, 尝试继续...');
        await page.keyboard.press('Escape').catch(()=>{});
    }
}

// ======================= [TOP20 核心业务逻辑] =======================

function initDatabaseTop20() {
    const dbDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    
    const db = new Database(DB_FILE);
    try {
        db.prepare("SELECT barcode FROM sales_history LIMIT 1").get();
    } catch (e) {
        if (e.message.includes('no such column')) {
            console.log("   ⚠️ 检测到旧版数据库结构，正在升级表结构...");
            db.exec("DROP TABLE IF EXISTS sales_history"); 
        }
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS sales_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, record_date TEXT, platform TEXT, sku_id TEXT, 
            product_name TEXT, category TEXT, barcode TEXT, visitor_count INTEGER, page_views INTEGER, favorites INTEGER, 
            order_buyers INTEGER, order_items INTEGER, order_amount REAL, sales_volume INTEGER, sales_users INTEGER, 
            sales_amount REAL, cart_items INTEGER, cart_users INTEGER, aov REAL, conversion_rate REAL, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(record_date, platform, sku_id) ON CONFLICT REPLACE
        )
    `);
    db.close();
}

function getMissingTasksTop20() {
    console.log(`\n--- [模块一] 计算最近 ${LOOKBACK_DAYS} 天 TOP20 缺失任务 ---`);
    const db = new Database(DB_FILE);
    const existing = new Set();
    try {
        const rows = db.prepare("SELECT DISTINCT record_date, platform FROM sales_history").all();
        rows.forEach(r => existing.add(`${r.record_date}|${r.platform}`));
    } catch (e) {}
    db.close();

    const tasks = [];
    const today = new Date();
    for (let i = 1; i <= LOOKBACK_DAYS; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = getLocalDateString(d);
        for (const platform of TARGET_PLATFORMS) {
            if (!existing.has(`${dateStr}|${platform}`)) {
                tasks.push({ date: dateStr, platform: platform });
            }
        }
    }
    tasks.sort((a, b) => a.date.localeCompare(b.date) || TARGET_PLATFORMS.indexOf(a.platform) - TARGET_PLATFORMS.indexOf(b.platform));
    console.log(`   📉 待执行 TOP20 抓取任务: ${tasks.length} 个`);
    return tasks;
}

async function setFiltersAndQueryTop20(page, dateStr, platformName) {
    console.log(`      ⚙️ 设置筛选: [${dateStr}] [${platformName}]`);
    // 开始日期
    const startDatePicker = page.locator('div.ant-picker').first();
    const startDateInput = startDatePicker.locator('input');
    const startClearButton = startDatePicker.locator('span.ant-picker-clear');
    if (await startClearButton.isVisible({ timeout: 2000 })) await startClearButton.click(); 
    await startDateInput.click();
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await startDateInput.fill(dateStr);
    
    // 【UI交互优化】触发 React 底层数据绑定
    await startDateInput.dispatchEvent('input');
    
    const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
    await visiblePanelStart.locator(`td[title="${dateStr}"]`).click();
    await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

    // 结束日期
    const endDatePicker = page.locator('div.ant-picker').nth(1);
    const endDateInput = endDatePicker.locator('input');
    const endClearButton = endDatePicker.locator('span.ant-picker-clear');
    if (await endClearButton.isVisible({ timeout: 2000 })) await endClearButton.click(); 
    await endDateInput.click();
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await endDateInput.fill(dateStr);
    await endDateInput.dispatchEvent('input');
    const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
    await visiblePanelEnd.locator(`td[title="${dateStr}"]`).click();
    await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

    // 平台设置 
    const selector = page.locator('.ant-select-selector').first();
    const removeIcons = page.locator('.ant-select-selection-item-remove');
    while (await removeIcons.count() > 0) { 
        await removeIcons.first().click(); 
        await page.waitForTimeout(50);
    }
    
    await selector.click();
    await page.keyboard.type(platformName, { delay: 100 });
    await page.waitForTimeout(800); 
    const option = page.locator(`.ant-select-item-option-content:has-text("${platformName}")`).first();
    if (!await option.isVisible()) {
        console.warn(`      ❌ 无法找到平台选项: ${platformName}`);
        return false;
    }
    await option.click({ force: true });
    await page.keyboard.press('Escape'); 

    console.log(`      🖱️ 点击查询...`);
    const responsePromise = page.waitForResponse(resp => resp.url().includes('dashboard') && resp.status() === 200, { timeout: 15000 }).catch(() => null);
    await page.getByRole('button', { name: '查 询' }).first().click();
    await responsePromise; 
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000); 
    return true;
}

async function downloadTop20(page, dateStr, platformName) {
    console.log(`      🎯 提取 TOP20 数据...`);
    const widget = page.locator('.gridItem--WrCz6', { has: page.locator('text="销售额TOP20"') }).last();
    if (!await widget.isVisible()) return null;
    await widget.hover();
    await widget.locator('.anticon-download').click();
    await page.waitForTimeout(1000);
    const popover = page.locator('.ant-popover-content:visible');
    if (await popover.isVisible()) {
        await popover.locator('img, svg, button').first().click({ force: true });
    }

    console.log(`      ⏳ 等待文件生成...`);
    const downloadIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
    await downloadIcon.click();
    const firstItem = page.locator('li[class^="item--"]').first();
    await firstItem.waitFor({ state: 'visible', timeout: 180000 });
    
    const fileName = await firstItem.innerText();
    if (!fileName.includes('销售额TOP20')) {
        console.error(`      ❌ 异常：文件名为 [${fileName}]，不是目标文件！`);
        await page.keyboard.press('Escape');
        return null;
    }
    await firstItem.locator('span.ant-tag:text("成功")').waitFor({ state: 'visible', timeout: 60000 });

    const downloadPromise = page.waitForEvent('download');
    await firstItem.locator('p[class^="success--"]').click();
    const download = await downloadPromise;

    if (!fs.existsSync(TOP20_DOWNLOAD_DIR)) fs.mkdirSync(TOP20_DOWNLOAD_DIR, { recursive: true });
    const saveName = `${dateStr}_${platformName}_TOP20.xlsx`;
    const savePath = path.join(TOP20_DOWNLOAD_DIR, saveName);
    await download.saveAs(savePath);
    console.log(`      💾 已保存: ${saveName}`);
    await page.keyboard.press('Escape');
    return savePath;
}

function importTop20ToDB(filePath, dateStr, platformName) {
    const db = new Database(DB_FILE);
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    if (data.length === 0) { db.close(); return; }

    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO sales_history 
        (record_date, platform, sku_id, product_name, category, barcode, visitor_count, page_views, favorites, 
         order_buyers, order_items, order_amount, sales_volume, sales_users, sales_amount, cart_items, cart_users, aov, conversion_rate)
        VALUES (@date, @plat, @sku, @name, @cat, @bc, @uv, @pv, @fav, @ob, @oi, @oa, @sv, @su, @sa, @ci, @cu, @aov, @rate)
    `);

    const transaction = db.transaction((rows) => {
        for (const row of rows) {
            const cleanInt = (v) => parseInt(v) || 0;
            const cleanFloat = (v) => parseFloat(v) || 0.0;
            const cleanStr = (v) => String(v || '').trim();
            const record = {
                date: dateStr, plat: platformName,
                sku: cleanStr(row['平台商品id'] || row['商品ID']),
                name: cleanStr(row['商品名称'] || row['产品名称']),
                cat: cleanStr(row['类目'] || row['一级类目']),
                bc:  cleanStr(row['商品69码'] || row['69码'] || row['条形码']), 
                uv: cleanInt(row['访客数']), pv: cleanInt(row['浏览量']), fav: cleanInt(row['收藏量']),
                ob: cleanInt(row['下单买家数']), oi: cleanInt(row['下单件数']), oa: cleanFloat(row['下单金额']),
                sv: cleanInt(row['支付数量'] || row['支付件数']), su: cleanInt(row['支付用户数']), sa: cleanFloat(row['支付金额']),
                ci: cleanInt(row['加购件数']), cu: cleanInt(row['加购人数']), aov: cleanFloat(row['客单价']), rate: cleanFloat(row['支付转化率'] || row['转化率'])
            };
            if (record.sku) insertStmt.run(record);
        }
    });
    transaction(data);
    db.close();
    console.log(`      ✅ TOP20 入库 ${data.length} 条 (全字段) | 归档中...`);
    moveFileToArchive(filePath, TOP20_ARCHIVE_DIR);
}


// ======================= [PDD 流水抓取与修正 核心逻辑] =======================

function excelDateToJSDate(excelDays) {
    const excelEpoch = new Date(1899, 11, 30); 
    return excelEpoch.getTime() + excelDays * 24 * 60 * 60 * 1000;
}

function mapFilesByDateContent(directory) {
    const dateToFileMap = new Map();
    if (!fs.existsSync(directory)) return dateToFileMap;
    const allFiles = fs.readdirSync(directory).filter(file => 
        file.toLowerCase().endsWith('.xlsx') && path.resolve(path.join(directory, file)) !== path.resolve(PDD_ARCHIVE_DIR)
    );
    for (const file of allFiles) {
        const filePath = path.join(directory, file);
        try {
            const workbook = xlsx.readFile(filePath);
            if (!workbook.SheetNames.length) continue;
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const firstDataRow = xlsx.utils.sheet_to_json(worksheet)[0];
            if (!firstDataRow || !firstDataRow['日期']) continue;
            const dateValue = firstDataRow['日期'];
            let dateString = typeof dateValue === 'number' ? getLocalDateString(new Date(excelDateToJSDate(dateValue))) : getLocalDateString(new Date(dateValue));
            if (dateString) dateToFileMap.set(dateString, filePath);
        } catch (error) {}
    }
    return dateToFileMap;
}

function getAllDatesFromDB() {
    try {
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
        const db = new Database(DB_FILE, { fileMustExist: true });
        // 尝试查询，如果表不存在会报错跳到 catch
        const stmt = db.prepare(`SELECT DISTINCT "日期" FROM ${DB_TABLE_NAME}`);
        const results = stmt.all();
        db.close();
        return new Set(results.map(row => row['日期']));
    } catch (error) {
        return new Set();
    }
}

function generateDateRange(start, end) {
    const dates = [];
    let currentDate = new Date(start);
    while (currentDate <= end) {
        dates.push(getLocalDateString(currentDate)); 
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
}

async function importExcelToDbPDD(filePath) {
    console.log(`🔄 正在准备导入 PDD 文件: ${path.basename(filePath)}`);
    try {
        const db = new Database(DB_FILE); 
        const workbook = xlsx.readFile(filePath); 
        const worksheet = workbook.Sheets[workbook.SheetNames[0]]; 
        const data = xlsx.utils.sheet_to_json(worksheet);

        if (data.length === 0) { db.close(); return true; }
        const columns = Object.keys(data[0]); 
        
        const TEXT_COLUMNS = new Set(['日期', '商品ID', '商品名称', '一级类目', '二级类目', '三级类目', '抓数账号', '取数账号']);
        const getColumnType = (colName) => TEXT_COLUMNS.has(colName) ? 'TEXT' : 'REAL';
        
        const columnDefinitions = columns.map(col => `"${col}" ${getColumnType(col)}`).join(', '); 
        db.prepare(`CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (${columnDefinitions})`).run();

        const existingColumnsResult = db.prepare(`PRAGMA table_info(${DB_TABLE_NAME})`).all();
        const existingColumnNames = new Set(existingColumnsResult.map(col => col.name));
        
        for (const col of columns) {
            if (!existingColumnNames.has(col)) {
                db.prepare(`ALTER TABLE ${DB_TABLE_NAME} ADD COLUMN "${col}" ${getColumnType(col)}`).run();
            }
        }
        
        const insertColumnNames = columns.map(col => `"${col}"`).join(', '); 
        const placeholders = columns.map(() => '?').join(', '); 
        const insertStmt = db.prepare(`INSERT INTO ${DB_TABLE_NAME} (${insertColumnNames}) VALUES (${placeholders})`);
        
        const insertMany = db.transaction((rows) => {
            for (const row of rows) {
                const values = columns.map(col => row[col]); 
                const dateIndex = columns.indexOf('日期');
                if (dateIndex !== -1 && values[dateIndex]) {
                    values[dateIndex] = typeof values[dateIndex] === 'number' ? getLocalDateString(new Date(excelDateToJSDate(values[dateIndex]))) : getLocalDateString(new Date(values[dateIndex])); 
                }
                insertStmt.run(...values);
            }
        });
        insertMany(data); 
        db.close(); 
        return true;
    } catch (error) { 
        console.error(`❌ 文件导入数据库时出错: ${error}`); 
        return false; 
    }
}

async function downloadReportForDatePDD(page, reportDate) {
    console.log(`\n--- 开始下载 PDD 日期: ${reportDate} ---`);
    try {
        await clearDownloadList(page);
        console.log(`➡️ 正在为日期 [${reportDate}] 生成报表...`);
        const startDatePicker = page.locator('div.ant-picker').first();
        const startDateInput = startDatePicker.locator('input');
        const startClearButton = startDatePicker.locator('span.ant-picker-clear');
        if (await startClearButton.isVisible({ timeout: 2000 })) await startClearButton.click(); 
        await startDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await startDateInput.fill(reportDate);
        await startDateInput.dispatchEvent('input'); // 强力触发绑定
        const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
        await visiblePanelStart.locator(`td[title="${reportDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

        const endDatePicker = page.locator('div.ant-picker').nth(1);
        const endDateInput = endDatePicker.locator('input');
        const endClearButton = endDatePicker.locator('span.ant-picker-clear');
        if (await endClearButton.isVisible({ timeout: 2000 })) await endClearButton.click(); 
        await endDateInput.click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await endDateInput.fill(reportDate);
        await endDateInput.dispatchEvent('input'); // 强力触发绑定
        const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
        await visiblePanelEnd.locator(`td[title="${reportDate}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

        const reportCard = page.locator('div.container--r3tGG').filter({ hasText: '拼多多商品销售流量' });
        await page.getByRole('button', { name: '查 询' }).click();
        await reportCard.waitFor({ state: 'visible', timeout: 60000 });
        await reportCard.hover();
        
        // 强制点击内部 SVG 图标应对失效
        const downloadTriggerIcon = reportCard.getByLabel('download').nth(1).locator('svg');
        await downloadTriggerIcon.click({ force: true });
        
        console.log('⏸️ 等待 3 秒...');
        await page.waitForTimeout(3000);
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
        
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
        await downloadManagerIcon.click();
        const firstEntry = page.locator('li[class^="item--"]').first();
        await firstEntry.waitFor({ state: 'visible', timeout: 10000 });
        await firstEntry.locator('span.ant-tag:text("成功")').waitFor({ state: 'visible', timeout: 60000 });

        const finalDownloadLink = firstEntry.locator('p[class^="success--"]');
        const downloadPromise = page.waitForEvent('download');
        const popupPromise = page.waitForEvent('popup').catch(e => e);
        await finalDownloadLink.click();
        const download = await downloadPromise;
        const popup = await popupPromise;
        if (popup instanceof page.constructor && !popup.isClosed()) await popup.close();
        
        if (!fs.existsSync(PDD_DOWNLOAD_DIR)) fs.mkdirSync(PDD_DOWNLOAD_DIR, { recursive: true });
        const filePath = path.join(PDD_DOWNLOAD_DIR, download.suggestedFilename());
        await download.saveAs(filePath);
        console.log(`🎉 PDD 表格已成功下载到: ${filePath}`);
        await page.keyboard.press('Escape');
        return { success: true, savePath: filePath };

    } catch (error) {
        console.error(`❌ 下载日期 [${reportDate}] 的报告时失败:`, error);
        return { success: false, savePath: null };
    }
}

async function overwriteSalesDataWithNonRefunds() { 
    console.log('\n======================================================');
    console.log('--- 启动非退款数据覆盖任务 (数据源: DB, 安全模式：按日期和ID匹配) ---');
    let orderDb = null, salesSummary = null;
    
    try {
        orderDb = new Database(ORDER_DB_FILE, { fileMustExist: true });
        const sql = `
            SELECT "${COL_ORDER_PRODUCT_ID}" AS productId, "${COL_ORDER_PAY_TIME}" AS payTime, 
                   "${COL_ORDER_QUANTITY}" AS quantity, "${COL_ORDER_AMOUNT}" AS amount
            FROM ${ORDER_DB_TABLE}
            WHERE "${COL_ORDER_STATUS}" NOT LIKE '%退款成功%' AND "${COL_ORDER_STATUS}" NOT LIKE '%待付款%' 
              AND "${COL_ORDER_STATUS}" NOT LIKE '%已取消%' AND "${COL_ORDER_PAY_TIME}" IS NOT NULL
        `;
        const nonRefundRows = orderDb.prepare(sql).all();

        if (nonRefundRows.length === 0) {
            console.log("-> 未发现 '非退款成功' 的订单数据，无需更新。"); 
            orderDb.close(); return;
        }
        
        const summaryMap = new Map();
        for (const row of nonRefundRows) { 
            let productId = row.productId ? String(row.productId).replace(/\s+/g, '').replace(/["']/g, '').trim() : null;
            let dateString = row.payTime ? getLocalDateString(new Date(row.payTime)) : '';
            
            if (productId && dateString) {
                const key = `${productId}_${dateString}`;
                const quantity = parseFloat(row.quantity) || 0;
                const amount = parseFloat(row.amount) || 0;
                const current = summaryMap.get(key) || { productId, date: dateString, payment_orders: 0, payment_quantity: 0, payment_amount: 0 };
                current.payment_orders += 1;
                current.payment_quantity += quantity;
                current.payment_amount += amount;
                summaryMap.set(key, current);
            }
        }
        salesSummary = Array.from(summaryMap.values());
    } catch (error) {
        console.error(`❌ 处理订单数据库时出错: ${error.message}`);
        return;
    } finally {
        if (orderDb) orderDb.close();
    }

    if (salesSummary.length === 0) return;
    
    let totalPaymentOrders = salesSummary.reduce((sum, item) => sum + item.payment_orders, 0);
    let totalPaymentAmount = salesSummary.reduce((sum, item) => sum + item.payment_amount, 0);

    console.log(`📦 总计 ${totalPaymentOrders} 个非退款订单，金额 ${totalPaymentAmount.toFixed(2)} 元，需要覆盖修正。`);
    const confirmation = await askQuestion('\n⚠️ 请确认是否同意执行数据库覆盖修正操作 (输入 "y" 继续): ');
    if (!confirmation) { console.log('✅ 用户取消操作。'); return; }

    let targetDb = null; 
    try {
        targetDb = new Database(DB_FILE, { fileMustExist: true });
        const updateStmt = targetDb.prepare(`
            UPDATE ${DB_TABLE_NAME} SET "${DB_COL_REFUND_PAY_ORDERS}" = ?, "${DB_COL_REFUND_PAY_QUANTITY}" = ?, "${DB_COL_REFUND_PAY_AMOUNT}" = ?
            WHERE "${DB_COL_REFUND_PRODUCT_ID}" = ? AND "${DB_COL_DATE}" = ?
        `);
        const updateAll = targetDb.transaction((summary) => {
            let updateCount = 0;
            for (const item of summary) {
                const info = updateStmt.run(item.payment_orders, item.payment_quantity, item.payment_amount, item.productId, item.date);
                if (info.changes > 0) updateCount += 1;
            }
            return updateCount;
        });
        const updatedRows = updateAll(salesSummary);
        console.log(`✅ 数据库覆盖修正完成! 成功更新了 ${updatedRows} 条记录。`);
    } catch (error) {
        console.error(`❌ 数据库覆盖修正操作失败: ${error.message}`);
    } finally {
        if (targetDb) targetDb.close();
    }
}

// ======================= [中央库存 SSO 同步逻辑] =======================

async function syncCentralInventory(context, page) {
    console.log('\n======================================================');
    console.log('--- [模块三] 中央库存查询任务 (门户SSO跳转模式) ---');
    
    if (!fs.existsSync(TASKS_EXCEL_PATH)) return console.error(`❌ 任务文件不存在: ${TASKS_EXCEL_PATH}`);

    const workbook = xlsx.readFile(TASKS_EXCEL_PATH);
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    const uniqueCodes = [...new Set(rows.filter(row => {
            const platform = row['Platform'] ? String(row['Platform']).trim() : '';
            const tValue = row['[T]']; 
            return platform === '拼多多' && (tValue == 1 || String(tValue).trim() === '1');
        }).map(row => String(row['ProductID']).trim()).filter(code => code && code.length > 5))];

    if (uniqueCodes.length === 0) return console.log('ℹ️ 未找到符合条件 (拼多多 & [T]=1) 的商品 69 码。');

    console.log('➡️ 正在访问云米超级管理系统 (su.viomi.com.cn)...');
    await page.goto('https://su.viomi.com.cn/super/#/home');
    
    if (page.url().includes('login') || page.url().includes('passport')) {
        try {
            await page.waitForSelector('input[type="text"], input[placeholder*="账号"]', { timeout: 1000 });
            const inputs = await page.locator('input:visible').all();
            if (inputs.length >= 2) {
                await inputs[0].fill(VIOMI_USERNAME);
                await inputs[1].fill(VIOMI_PASSWORD);
                await page.locator('button:has-text("登录"), div:has-text("登录")').last().click();
                await page.waitForLoadState('networkidle');
            }
        } catch (e) {}
    }
    
    const inventoryBtn = page.locator('div.outer').filter({ hasText: '中央库存' });
    try {
        await inventoryBtn.waitFor({ state: 'visible', timeout: 15000 });
    } catch(e) {
        return console.error('❌ 未找到“中央库存”按钮，请确认权限。');
    }

    const [newPage] = await Promise.all([ context.waitForEvent('page'), inventoryBtn.click() ]);
    await newPage.waitForLoadState('networkidle');

    if (newPage.url().includes('login') || newPage.url().includes('passport')) {
        console.log('\n🔴 警告：检测到 SSO 跳转失败，需人工输入验证码！');
        await askQuestion('👉 登录成功并进入【中央库存查询页】后，按回车键继续...');
    }
    
    try {
        await newPage.getByText('库存管理', { exact: true }).click();
        await newPage.getByRole('menuitem', { name: '库存查询' }).click();
        await newPage.waitForLoadState('networkidle');
    } catch (e) {
        if (!newPage.url().includes('warehouse/index.html')) {
            await newPage.goto('https://su.viomi.com.cn/warehouse/index.html#/warehouse');
            await newPage.waitForLoadState('networkidle');
        }
    }

    const db = new Database(DB_FILE);
    db.prepare(`
        CREATE TABLE IF NOT EXISTS ${INVENTORY_DB_TABLE} (
            查询日期 TEXT, 商品69码 TEXT, 仓库名称 TEXT, 可用库存 INTEGER, 占用库存 INTEGER, 
            冻结库存 INTEGER, 在途库存 INTEGER, 实物库存 INTEGER, 总库存 INTEGER, PRIMARY KEY (查询日期, 商品69码, 仓库名称)
        )
    `).run();

    const todayStr = getLocalDateString(new Date());
    const insertStmt = db.prepare(`INSERT OR REPLACE INTO ${INVENTORY_DB_TABLE} (查询日期, 商品69码, 仓库名称, 可用库存, 占用库存, 冻结库存, 在途库存, 实物库存, 总库存) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const code of uniqueCodes) {
        try {
            console.log(`➡️ 查询库存: ${code}`);
            await newPage.fill('input[placeholder*="商品69码"]', code);
            await newPage.locator('button').filter({ hasText: '搜 索' }).first().click();
            await newPage.waitForTimeout(1500); 

            const currentProductData = await newPage.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper .el-table__body tr.el-table__row'));
                return rows.map(row => {
                    const cells = row.querySelectorAll('td');
                    const getText = (idx) => cells[idx]?.innerText?.trim() || '0';
                    return [ cells[0]?.innerText?.trim() || '', parseInt(getText(1)) || 0, parseInt(getText(2)) || 0, parseInt(getText(3)) || 0, parseInt(getText(4)) || 0, parseInt(getText(5)) || 0, parseInt(getText(6)) || 0 ];
                }).filter(item => item[0] !== '生产调试共享仓（请勿动）');
            });

            if (currentProductData.length === 0) continue;
            db.transaction((dataList) => { for (const data of dataList) insertStmt.run(todayStr, code, ...data); })(currentProductData);
        } catch (err) {
            console.error(`   ❌ 查询出错: ${err.message}`);
        }
    }
    await newPage.close();
    db.close();
}


// ======================= [终极主程序入口] =======================

async function main() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) { console.error('❌ 错误：请先设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。'); process.exit(1); }
    
    console.log('--- 🚀 综合集成自动化脚本启动 ---');
    initDatabaseTop20();

    // 计算缺失任务
    const top20Tasks = getMissingTasksTop20();
    
    const requiredPDDDates = generateDateRange(new Date('2025-01-01'), new Date(new Date().setDate(new Date().getDate() - 1)));
    const existingPDDDates = getAllDatesFromDB();
    const missingPDDDates = requiredPDDDates.filter(date => !existingPDDDates.has(date));
    const localPDDMap = mapFilesByDateContent(PDD_DOWNLOAD_DIR);
    
    const pddImportOnly = [];
    const pddDownloadTasks = [];
    if (missingPDDDates.length > 0) {
        for (const date of missingPDDDates) {
            if (localPDDMap.has(date)) pddImportOnly.push(localPDDMap.get(date));
            else pddDownloadTasks.push(date);
        }
    }

    // 启动防反爬浏览器
    const browser = await chromium.launch({ 
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'] // 隐藏 navigator.webdriver 特征
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // [1] 全局登录 Sky BI
        console.log('\n--- 🔑 统一登录 Sky BI ---');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=857');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForLoadState('networkidle', { timeout: 60000 });

        // [2] 执行 TOP20 抓取
        if (top20Tasks.length > 0) {
            console.log('\n================ 执行 TOP20 任务 ================');
            for (const task of top20Tasks) {
                console.log(`\n🔹 [${task.date}] [${task.platform}] 任务开始...`);
                await page.reload({ waitUntil: 'networkidle' });
                await clearDownloadList(page);
                const filterOk = await setFiltersAndQueryTop20(page, task.date, task.platform);
                if (filterOk) {
                    const filePath = await downloadTop20(page, task.date, task.platform);
                    if (filePath) importTop20ToDB(filePath, task.date, task.platform);
                }
            }
        }

        // [3] 执行 PDD 流水下载与导入
        console.log('\n================ 执行 PDD 流水与修正任务 ================');
        // 先处理仅导入的任务
        for (const filePath of pddImportOnly) {
            if (await importExcelToDbPDD(filePath)) await moveFileToArchive(filePath, PDD_ARCHIVE_DIR);
        }
        
        // 再处理需要下载的任务
        if (pddDownloadTasks.length > 0) {
            await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=833');
            await page.waitForLoadState('networkidle');
            for (const dateString of pddDownloadTasks) {
                const result = await downloadReportForDatePDD(page, dateString);
                if (result.success && result.savePath) {
                    if (await importExcelToDbPDD(result.savePath)) await moveFileToArchive(result.savePath, PDD_ARCHIVE_DIR);
                }
            }
        }

        // [4] 执行 PDD 订单数据覆盖修正 (无论有无下载均执行)
        await overwriteSalesDataWithNonRefunds();

        // [5] 执行中央库存 SSO 抓取
        console.log('\n================ 执行 中央库存 SSO 抓取 ================');
        if (Object.values(ENABLE_PLATFORMS).some(s => s)) {
            await syncCentralInventory(context, page);
        }

    } catch (e) {
        console.error('❌ 脚本在浏览器主任务中执行出错:', e);
        // 保存错误截图防崩溃
        await page.screenshot({ path: `error_log_${Date.now()}.png` }).catch(()=>{});
    } finally {
        await browser.close();
        console.log('🏁 浏览器已关闭，全套流程执行结束。');
    }
}

main();