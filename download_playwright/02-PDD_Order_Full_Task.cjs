// PDD_Order_Full_Task_Final.js - 拼多多订单报表全自动下载入库脚本-废弃不用了。
// [多店进阶版] 引入多配置轮询、防反爬策略与 API 劫持技术

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

// ======================= [全局多店配置区域] =======================
const STORE_CONFIGS = [
    { 
        storeName: '云米拼多多官方旗舰店', 
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile') 
    },
    { 
        storeName: '云米拼多多专卖店_新店',
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile-newstore')
    }
];

const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询');
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入');

// 数据库配置
const CENTRAL_DB_PATH = path.join(__dirname, '..', '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');

// 目标页面与表单配置
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0'; 
const EXPORT_RECORD_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

const ORDER_CHECK_PAST_DAYS = 90;
const DB_ORDER_TABLE_NAME = 'pddorder';
const ORDER_PRIMARY_KEY = '订单号';
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; 

const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;

// ======================= [辅助函数] =======================

// 辅助函数：将 YYYY-MM-DD 字符串转换为 Unix 时间戳（精确到秒）
function dateStrToUnix(dateStr, isEnd = false) {
    const date = new Date(dateStr);
    if (isEnd) {
        date.setHours(23, 59, 59, 999); // 当天的最后一秒
    } else {
        date.setHours(0, 0, 0, 0);      // 当天的第一秒
    }
    return Math.floor(date.getTime() / 1000);
}

async function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function countdown(seconds, message) {
    for (let i = seconds; i > 0; i--) {
        process.stdout.write(`\r -> ⏳ ${message}: 还需等待 ${i} 秒...   `);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`\n -> ⏰ 等待结束，恢复执行。`);
}

function formatPaymentDate(dateTimeStr) {
    if (!dateTimeStr) return null;
    const cleanStr = String(dateTimeStr).trim().split(/\s+/)[0];
    let match = cleanStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    match = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (match) {
        let part1 = parseInt(match[1]), part2 = parseInt(match[2]), yearStr = match[3];
        if (yearStr.length === 2) yearStr = '20' + yearStr;
        let month = part1 > 12 ? part2 : part1;
        let day = part1 > 12 ? part1 : part2;
        return `${yearStr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
}

// 从订单号前缀提取日期 (YYMMDD -> YYYY-MM-DD)
function getDateFromOrderId(orderId) {
    if (!orderId || String(orderId).length < 6) return null;
    const orderStr = String(orderId).trim();
    const prefix = orderStr.substring(0, 6); 
    if (!/^\d+$/.test(prefix)) return null;
    const year = '20' + prefix.substring(0, 2);
    const month = prefix.substring(2, 4);
    const day = prefix.substring(4, 6);
    return `${year}-${month}-${day}`;
}

// ======================= [UI 交互逻辑] =======================

// 弹窗清理逻辑 - 增强版图标捕获
async function tryClosePopups(page) {
    try {
        const closeSelectors = [
            '[data-testid="beast-core-modal-icon-close"]',
            '.beast-core-modal-close',
            'button[aria-label="Close"]',
            'button:has-text("知道了")',
            'button:has-text("关闭")',
            '.u-icon-close',
            '.beast-core-modal svg', 
            '.ant-modal-close-icon',
            'i'
        ];
        for (const selector of closeSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 检测到干扰弹窗，尝试关闭...`);
                await btn.click({ force: true });
                await btn.evaluate(node => node.dispatchEvent(new Event('click', { bubbles: true }))).catch(() => {});
                await page.waitForTimeout(500);
            }
        }
    } catch (e) {}
}

// ======================= [数据库与文件处理] =======================

let globalDb = null;
function getDbConnection() {
    if (!globalDb) {
        try {
            globalDb = new Database(CENTRAL_DB_PATH);
            globalDb.pragma('journal_mode = WAL'); 
        } catch (e) {
            console.error(`❌ 无法打开数据库: ${e.message}`);
            throw e;
        }
    }
    return globalDb;
}

async function scanAndImportLocalFiles() {
    console.log(`\n--- 📂 [初始化] 正在扫描本地未处理文件... ---`);
    try {
        try {
            await fs.access(ORDER_DOWNLOAD_FOLDER);
        } catch {
            console.log(" -> 📁 下载目录不存在，跳过扫描。");
            return;
        }

        const files = await fs.readdir(ORDER_DOWNLOAD_FOLDER);
        const targetFiles = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return (ext === '.xlsx' || ext === '.csv' || ext === '.zip') && !f.includes('Crdownload');
        });
        if (targetFiles.length === 0) {
            console.log(" -> ⚪ 本地无待处理文件。");
            return;
        }

        console.log(` -> 📦 发现 ${targetFiles.length} 个本地文件，开始导入...`);
        for (const file of targetFiles) {
            const fullPath = path.join(ORDER_DOWNLOAD_FOLDER, file);
            console.log(`    -> 处理本地文件: ${file}`);
            await importFileWithSupport(fullPath);
        }
        console.log(" -> ✅ 本地文件清理完毕。\n");
    } catch (e) {
        console.error(` -> ⚠️ 扫描本地文件出错: ${e.message}`);
    }
}

async function importFileWithSupport(filePath, storeName = '未知店铺') {
    const db = getDbConnection();
    try {
        let finalExcelPath = filePath;
        let isTempFile = false;
        if (filePath.toLowerCase().endsWith('.zip')) {
            const zip = new AdmZip(filePath);
            const entry = zip.getEntries().find(e => e.entryName.endsWith('.xlsx') || e.entryName.endsWith('.csv'));
            if (!entry) throw new Error("ZIP 无效");
            const tempDir = path.join(ORDER_DOWNLOAD_FOLDER, 'temp_' + Date.now());
            await fs.mkdir(tempDir, { recursive: true });
            zip.extractEntryTo(entry, tempDir, false, true);
            finalExcelPath = path.join(tempDir, entry.entryName);
            isTempFile = true;
        }

        const workbook = xlsx.readFile(finalExcelPath);
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { raw: false });
        
        if (rawData.length > 0) {
            const beforeCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            processOrderDataForDatabase(rawData, path.basename(filePath), db, storeName);
            const afterCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            console.log(` ✅ [${storeName}] 入库处理完成。📊 库内总数: ${beforeCount} -> ${afterCount}`);
        }
        
        await fs.mkdir(ORDER_ARCHIVE_FOLDER, { recursive: true });
        await fs.rename(filePath, path.join(ORDER_ARCHIVE_FOLDER, path.basename(filePath)));
        if (isTempFile) await fs.rm(path.dirname(finalExcelPath), { recursive: true, force: true });
    } catch (e) {
        console.error(` ❌ 入库错误: ${e.message}`);
    }
}

function processOrderDataForDatabase(rawData, fileName, db, storeName) {
    const cleaned = rawData.map(row => {
        const obj = {};
        for (const k in row) obj[String(k).trim()] = row[k];
        obj['店铺名称'] = storeName; 
        return obj;
    });
    const rows = cleaned.map(row => {
        const nr = { ...row };
        nr[ORDER_PAYMENT_DATE_HEADER] = formatPaymentDate(row['支付时间']);
        return nr[ORDER_PRIMARY_KEY] && nr[ORDER_PAYMENT_DATE_HEADER] ? nr : null;
    }).filter(r => r);
    if (rows.length === 0) return 0;
    
    const first = rows[0]; 
    const headers = Object.keys(first); 
    const pk = ORDER_PRIMARY_KEY.replace(/[\s\.\-\/\\()]/g, '_');
    const cols = headers.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));

    db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS "${DB_ORDER_TABLE_NAME}" ("${pk}" TEXT PRIMARY KEY)`);
        const exist = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(c => c.name);
        cols.forEach(c => { if(!exist.includes(c)) db.prepare(`ALTER TABLE "${DB_ORDER_TABLE_NAME}" ADD COLUMN "${c}" TEXT`).run(); });
    })();
    const finalCols = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(c => c.name);
    const stmt = db.prepare(`INSERT INTO "${DB_ORDER_TABLE_NAME}" (${finalCols.map(c=>`"${c}"`).join(',')}) VALUES (${finalCols.map(c=>`@${c}`).join(',')}) ON CONFLICT("${pk}") DO UPDATE SET ${finalCols.filter(c=>c!==pk).map(c=>`"${c}"=excluded."${c}"`).join(',')}`);
    let cnt = 0;
    db.transaction(() => {
        for (const r of rows) {
            const ins = {};
            finalCols.forEach(c => {
                const rawKey = headers.find(h => h.replace(/[\s\.\-\/\\()]/g, '_') === c);
                ins[c] = r[rawKey] !== undefined ? String(r[rawKey]) : null;
            });
            if (stmt.run(ins).changes > 0) cnt++;
        }
    })();
    return cnt;
}

// ======================= [日期查漏] =======================

async function getMissingDatesFromDatabase(daysAgo, storeName) {
    const db = getDbConnection();
    const needed = new Set();
    const today = new Date();
    for(let i=1; i<=daysAgo; i++) {
        const d = new Date();
        d.setDate(today.getDate()-i);
        needed.add(formatDate(d));
    }

    try {
        const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(DB_ORDER_TABLE_NAME);
        if(!check) return needed;

        const sql = `SELECT "${ORDER_PRIMARY_KEY}" FROM "${DB_ORDER_TABLE_NAME}" WHERE "店铺名称" = ? OR "店铺名称" IS NULL`;
        const rows = db.prepare(sql).all(storeName);
        
        const exist = new Set();
        rows.forEach(r => {
            const orderId = r[ORDER_PRIMARY_KEY];
            const dateStr = getDateFromOrderId(orderId);
            if (dateStr) exist.add(dateStr);
        });
        return new Set([...needed].filter(d => !exist.has(d)));
    } catch(e) { 
        console.error(` -> 📅 日期查漏异常: ${e.message}`);
        return needed;
    }
}

function groupConsecutiveDates(set) {
    const arr = Array.from(set).sort();
    if(!arr.length) return [];
    const ranges = [];
    let start = arr[0], end = arr[0];
    for(let i=1; i<arr.length; i++) {
        const next = new Date(end);
        next.setDate(next.getDate()+1);
        if(formatDate(next) === arr[i]) end = arr[i];
        else { ranges.push({start, end}); start = arr[i]; end = arr[i]; }
    }
    ranges.push({start, end});
    return ranges;
}

// ======================= [主流程] =======================

async function pddOrderTask(page, storeName) {
    await scanAndImportLocalFiles();
    console.log(`\n--- 📦 [任务] 启动报表同步 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    const missing = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS, storeName);
    if (!missing.size) return console.log("✅ 数据库最新。");

    const ranges = groupConsecutiveDates(missing);
    console.log(` -> 缺失 ${missing.size} 天，分 ${ranges.length} 批。`);

    for (const range of ranges) {
        let attempt = 0;
        const maxAttempts = 2; 

        while (attempt < maxAttempts) {
            attempt++;
            try {
                console.log(`\n[执行] 正在处理: ${range.start} 至 ${range.end} (第 ${attempt} 次尝试)`);
                await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await tryClosePopups(page);
                await page.waitForTimeout(3000);
                await tryClosePopups(page);

                // --- API 劫持模块 ---
                const startUnix = dateStrToUnix(range.start, false);
                const endUnix = dateStrToUnix(range.end, true);
                console.log(` -> 💉 准备劫持发包，注入底层时间范围: ${range.start} 至 ${range.end}`);

                const routeHandler = async route => {
                    const request = route.request();
                    if (request.method() === 'POST') {
                        try {
                            const postData = JSON.parse(request.postData());
                            postData.groupStartTime = startUnix;
                            postData.groupEndTime = endUnix;
                            console.log(` -> 🛡️ 拦截成功！已将底层参数修改为目标时间戳。`);
                            await route.continue({ postData: JSON.stringify(postData) });
                        } catch (e) {
                            await route.continue();
                        }
                    } else {
                        await route.continue();
                    }
                };

                await page.route('**/mars/shop/recentOrders/export/task/add', routeHandler);

                try {
                    console.log(` -> 点击批量导出...`);
                    await page.getByRole('button', { name: '批量导出' }).click();
                    await page.waitForTimeout(2000);
                    
                    console.log(` -> 点击生成报表...`);
                    await page.getByRole('button', { name: '生成报表', exact: true }).click();
                    
                    await page.waitForTimeout(2000);
                } finally {
                    // 安全回收拦截网
                    await page.unroute('**/mars/shop/recentOrders/export/task/add', routeHandler);
                    console.log(` -> 🕸️ 拦截网已安全回收。`);
                }
                // --- 劫持模块结束 ---

                const errorToast = page.locator('.ant-message-notice, .beast-core-modal-content').filter({ 
                     hasText: /频繁|间隔|稍后|导出中/ 
                }).first();

                if (await errorToast.isVisible({ timeout: 5000 })) {
                    console.log(`\n🚨 触发频率限制保护！`);
                    await countdown(310, "系统冷却中");
                    throw new Error("Frequency limit triggered - cooling down");
                }

                await page.goto(EXPORT_RECORD_URL, { waitUntil: 'domcontentloaded' });
                
                let file = null;
                console.log(' -> ⏳ 正在等待第一个“下载报表”按钮出现...');
                const firstDownloadBtn = page.locator('button:has-text("下载报表")').first();
                
                try {
                    await firstDownloadBtn.waitFor({ state: 'visible', timeout: 100000 });
                } catch (e) {
                    console.warn(' -> ⚠️ 等待超时，尝试点击“刷新”...');
                    const refreshBtn = page.getByText('刷新').or(page.getByText('查询')).first();
                    if (await refreshBtn.isVisible()) {
                        await refreshBtn.click({ force: true });
                        await page.waitForTimeout(3000);
                        await firstDownloadBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
                    }
                }

                let downloadSuccess = false;
                if (await firstDownloadBtn.isVisible()) {
                    console.log(` -> 🎯 已检测到第一个“下载报表”按钮，尝试点击下载...`);
                    try {
                        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
                        await firstDownloadBtn.click({ force: true });
                        const down = await downloadPromise;
                        file = path.join(ORDER_DOWNLOAD_FOLDER, down.suggestedFilename());
                        await down.saveAs(file);
                        console.log(` ✅ 下载成功: ${path.basename(file)}`);
                        downloadSuccess = true;
                    } catch (e) {
                        console.error(` -> ❌ 点击了第一个按钮但未触发下载:`, e.message);
                    }
                } else {
                    console.warn(` -> ⚠️ 页面上未能找到任何“下载报表”按钮。`);
                }

                if (!downloadSuccess) {
                    throw new Error("首个“下载报表”按钮未触发下载或未找到，可能报表未生成。");
                }

                if (file) await importFileWithSupport(file, storeName);
                break; // 成功完成，退出重试循环
            } catch (error) {
                console.error(`\n❌ 失败: ${error.message}`);
                if (attempt < maxAttempts) {
                    console.log(' -> 🔄 准备刷新重试...');
                    await page.waitForTimeout(3000);
                } else {
                    console.error(' -> 💀 达到最大重试次数，跳过此时间段。');
                }
            }
        }
    }
}

async function main() {
    try {
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });
        for (const config of STORE_CONFIGS) {
            console.log(`\n======================================================`);
            console.log(`🚀 开始执行店铺任务: 【${config.storeName}】`);
            console.log(`📂 使用浏览器配置: ${config.profileDir}`);
            console.log(`======================================================`);

            let context = null;
            let page = null;
            
            try {
                context = await chromium.launchPersistentContext(config.profileDir, { 
                    headless: false, 
                    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
                    viewport: null, 
                    downloadsPath: ORDER_DOWNLOAD_FOLDER 
                });
                page = context.pages()[0] || await context.newPage();
                
                await pddOrderTask(page, config.storeName); 
                
            } catch (storeError) {
                console.error(`\n❌ 店铺 【${config.storeName}】 执行过程中发生严重错误:`, storeError.message);
                if (page) {
                    await page.screenshot({ path: `error_${config.storeName}_${Date.now()}.png`, fullPage: true }).catch(()=>{});
                }
            } finally {
                if (context) await context.close();
                console.log(`🏁 店铺 【${config.storeName}】 任务结束。`);
            }
        }
    } catch (e) {
        console.error('\n❌ 全局严重错误:', e.message);
    } finally {
        if (globalDb) globalDb.close();
        console.log('所有店铺任务执行完毕。');
    }
}

main();