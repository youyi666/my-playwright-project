// PDD_Order_Full_Task_Final.js - 拼多多订单报表全自动下载入库脚本
// [2026-01-29 V39 终极全能版]
// 核心修复：
// 1. 弹窗干扰 -> 任务级自动重试 (maxAttempts=2)
// 2. 归零失败 -> 引入 ensureCalendarOpen + 显式等待 + 状态二次确认
// 3. 频率限制 -> 增强型 Toast 捕获 + 倒计时冷却
// 4. 数据脏读 -> 数据库查漏改为解析“订单号”推算日期

// PDD_Order_Full_Task_Final.js - 拼多多订单报表全自动下载入库脚本
// [多店进阶版] 引入多配置轮询与防反爬策略

// --- [增量模块 1: 引入防爬虫增强版 Playwright] ---
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

// ======================= [全局多店配置区域] =======================
// [增量模块 2: 多店参数矩阵]
// 你可以在这里无限增加新店铺，每个店铺必须有独立的 profile 文件夹来隔离登录态
const STORE_CONFIGS = [
    { 
        storeName: '云米拼多多官方旗舰店', // 建议与原单店的名称对应
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile') // 沿用老配置文件夹，免得重新登录
    },
    { 
        storeName: '云米拼多多专卖店_新店', // 新店铺名称
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile-newstore') // 全新的独立缓存文件夹
    }
];

const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询');
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入');
// ... (下方的 CENTRAL_DB_PATH 等基座代码保持不动)

// 2. 数据库配置 (动态路径平滑迭代)
// 逻辑说明：向上跳 3 级到达 WorkSpace 根目录，然后进入共享数据库文件夹
const CENTRAL_DB_PATH = path.join(
    __dirname, 
    '..', '..', '..', 
    '00_Shared_Database数据库', 
    'TmallDataCenter.db'
);

// 3. 目标页面与表单配置
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0'; 
const EXPORT_RECORD_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

const ORDER_CHECK_PAST_DAYS = 90;
const DB_ORDER_TABLE_NAME = 'pddorder'; 
const ORDER_PRIMARY_KEY = '订单号';
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; 

// 4. 行为模拟配置
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const HUMAN_LIKE_DELAY_MIN_MS = 500;
const HUMAN_LIKE_DELAY_MAX_MS = 1500;

// ======================= [辅助函数] =======================

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

function addOneDay(dateStr) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + 1);
    return formatDate(date);
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

// [核心修复4] 从订单号前缀提取日期 (YYMMDD -> YYYY-MM-DD)
// 用于解决数据库查漏时的跨天支付脏数据问题
function getDateFromOrderId(orderId) {
    if (!orderId || String(orderId).length < 6) return null;
    const orderStr = String(orderId).trim();
    const prefix = orderStr.substring(0, 6); 
    
    // 简单校验是否为数字
    if (!/^\d+$/.test(prefix)) return null;

    const year = '20' + prefix.substring(0, 2);
    const month = prefix.substring(2, 4);
    const day = prefix.substring(4, 6);
    return `${year}-${month}-${day}`;
}

// ======================= [UI 交互逻辑] =======================

// [核心修复1] 弹窗清理逻辑
async function tryClosePopups(page) {
    try {
        const closeSelectors = [
            '[data-testid="beast-core-modal-icon-close"]',
            '.beast-core-modal-close',
            'button[aria-label="Close"]',
            'button:has-text("知道了")',
            'button:has-text("关闭")',
            '.u-icon-close' // 补充常见的关闭图标类名
        ];
        for (const selector of closeSelectors) {
            // 只检测可见的
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 检测到干扰弹窗，尝试关闭...`);
                await btn.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
    } catch (e) {}
}

// [核心修复2] 强力开门函数：解决“点击日期输入框被吞”的问题
async function ensureCalendarOpen(page) {
    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');

    // 如果已经开了，直接返回
    if (await calendarContainer.isVisible()) return;

    // 最多重试 3 次，间隔递增
    for (let i = 1; i <= 3; i++) {
        try {
            await dateInput.click({ force: true }); 
            // 等待弹窗出现
            await calendarContainer.waitFor({ state: 'visible', timeout: 2000 });
            return;
        } catch (e) {
            console.warn(`   -> ⚠️ 点击被吞 (尝试 ${i}/3)，重试中...`);
            await page.waitForTimeout(1000); // 冷却一下
        }
    }
    throw new Error("UI死锁：尝试 3 次均无法打开日历面板");
}

async function performReset(page) {
    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    
    // 1. 确保日历打开
    await ensureCalendarOpen(page);

    // 寻找归零按钮
    let resetLink = calendarContainer.locator('text=归零').or(calendarContainer.locator('a, span').filter({ hasText: '归零' })).first();
    
    // 2. 激活逻辑：如果没看到归零，先点个有效日期激活它
    if (!await resetLink.isVisible()) {
        try {
            const anyDate = calendarContainer.locator('td:not(.disabled):not(.prev-month):not(.next-month)').first();
            if (await anyDate.count() > 0) {
                await anyDate.click({ force: true });
                await page.waitForTimeout(500); 
                // 点击日期后日历可能关闭，必须重新强力打开
                await ensureCalendarOpen(page);
            }
        } catch (e) {}
    }

    // 3. 执行归零
    if (await resetLink.isVisible()) {
        console.log(' -> 🎯 执行归零...');
        await resetLink.evaluate(el => el.click()); 
        
        // [核心修复2] 归零后显式等待动画
        await page.waitForTimeout(1000); 
        
        // 归零后日历可能自动关闭，再次强力打开，为后续选日期做准备
        await ensureCalendarOpen(page);
    }
}

async function selectDateRange(page, dateStrStart, dateStrEnd) {
    // 结束日期+1天逻辑
    const uiDateStrEnd = addOneDay(dateStrEnd);
    const dayStart = parseInt(dateStrStart.split('-')[2], 10).toString();
    const dayEnd = parseInt(uiDateStrEnd.split('-')[2], 10).toString();

    console.log(` -> [日期选择] 逻辑范围: ${dateStrStart}至${dateStrEnd} | UI操作: ${dayStart}号 和 ${dayEnd}号`);

    // 1. 确保日历打开
    await ensureCalendarOpen(page);
    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');

    // 智能点击函数
    const clickSmart = async (targetDay) => {
        const regex = new RegExp(`^\\s*${targetDay}\\s*$`);
        // 过滤文本匹配的td
        const candidates = calendarContainer.locator('td').filter({ hasText: regex });
        const count = await candidates.count();

        let clickSuccess = false;
        
        // [核心修复2] 优先遍历有效日期 (排除灰显、上月、下月)
        // 倒序遍历（从后往前），通常能选到当前月份的日期
        for (let i = count - 1; i >= 0; i--) {
            const el = candidates.nth(i);
            if (!await el.isVisible()) continue;
            
            const className = await el.getAttribute('class') || '';
            const textContent = await el.innerText();
            
            // 精确匹配数字
            if (textContent.trim() !== targetDay) continue;
            
            // 排除无效日期
            if (className.includes('disabled') || 
                className.includes('prev-month') || 
                className.includes('next-month') || 
                className.includes('gray')) {
                continue;
            }

            try {
                await el.click({ timeout: 1000, force: true });
                clickSuccess = true;
                await page.waitForTimeout(300); // 动作间隔
                break; 
            } catch (e) {}
        }

        // 兜底：如果上面没点到，盲点最后一个候选（通常是本月）
        if (!clickSuccess && count > 0) {
            try { 
                await candidates.last().click({ timeout: 2000, force: true }); 
            } catch (e) { throw new Error(`无法点击日期: ${targetDay}`); }
        }
    };

    await clickSmart(dayStart);
    await randomDelay(600, 1000);
    await clickSmart(dayEnd);
    await randomDelay(500, 800);

    const confirmBtn = calendarContainer.locator('button').filter({ hasText: /^确认$/ })
        .or(calendarContainer.getByRole('button', { name: '确认' }));
    if (await confirmBtn.isVisible()) await confirmBtn.click();
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
// [新增功能] 启动时扫描并导入本地遗留文件
async function scanAndImportLocalFiles() {
    console.log(`\n--- 📂 [初始化] 正在扫描本地未处理文件... ---`);
    try {
        // 检查文件夹是否存在
        try {
            await fs.access(ORDER_DOWNLOAD_FOLDER);
        } catch {
            console.log(" -> 📁 下载目录不存在，跳过扫描。");
            return;
        }

        const files = await fs.readdir(ORDER_DOWNLOAD_FOLDER);
        // 过滤出 .xlsx, .csv, .zip 且不包含 '已导入' 文件夹自身
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
            await importFileWithSupport(fullPath); // 复用现有的入库函数 
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
        // 处理 ZIP
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
            // 核心变动：将 storeName 传给处理函数
            processOrderDataForDatabase(rawData, path.basename(filePath), db, storeName);
            const afterCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            console.log(` ✅ [${storeName}] 入库处理完成。📊 库内总数: ${beforeCount} -> ${afterCount}`);
        }
        
        // 归档
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
        // 核心注入：给每一行数据强行加上店铺标识
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

// [核心修复4] 基于订单号的查漏逻辑
async function getMissingDatesFromDatabase(daysAgo, storeName) {
    const db = getDbConnection();
    const needed = new Set();
    const today = new Date();
    // 生成最近 N 天的日期列表
    for(let i=1; i<=daysAgo; i++) {
        const d = new Date();
        d.setDate(today.getDate()-i);
        needed.add(formatDate(d));
    }

    try {
        const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(DB_ORDER_TABLE_NAME);
        if(!check) return needed;

        // 只查订单号列，效率更高
        const sql = `SELECT "${ORDER_PRIMARY_KEY}" FROM "${DB_ORDER_TABLE_NAME}" WHERE "店铺名称" = ? OR "店铺名称" IS NULL`;
        const rows = db.prepare(sql).all(storeName);
        
        const exist = new Set();
        rows.forEach(r => {
            const orderId = r[ORDER_PRIMARY_KEY];
            // 核心：解析订单号得到日期
            const dateStr = getDateFromOrderId(orderId);
            if (dateStr) exist.add(dateStr);
        });

        // 差集运算
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
    // 1. 先把本地有的文件吃进去
    await scanAndImportLocalFiles(); 

    // 2. 吃完本地文件后，再去数据库算还需要查哪天
    // 这样如果本地文件补全了数据，就不会重复去网页下载了
    console.log(`\n--- 📦 [任务] 启动报表同步 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    const missing = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS, storeName);
    if (!missing.size) return console.log("✅ 数据库最新。");

    const ranges = groupConsecutiveDates(missing);
    console.log(` -> 缺失 ${missing.size} 天，分 ${ranges.length} 批。`);

    // 遍历每一个缺失的时间段
    for (const range of ranges) {
        let attempt = 0;
        const maxAttempts = 2; // [核心修复1] 任务级重试

        while (attempt < maxAttempts) {
            attempt++;
            try {
                console.log(`\n[执行] 正在处理: ${range.start} 至 ${range.end} (第 ${attempt} 次尝试)`);
                
                await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // [核心修复1] 主动清理首屏弹窗
                await tryClosePopups(page);
                await page.waitForTimeout(3000);
                // [核心修复2] 归零与日期选择
                await performReset(page);
                await page.waitForTimeout(5000);
                await selectDateRange(page, range.start, range.end);
                
                await page.getByRole('button', { name: '查询', exact: true }).click();
                console.log(` -> 点击查询，等待结果加载...`);
                await page.waitForTimeout(3000);
                await page.getByRole('button', { name: '批量导出' }).click();
                console.log(` -> 点击批量导出...`);
                await page.waitForTimeout(2000);
                console.log(` -> 点击生成报表...`);
                await page.getByRole('button', { name: '生成报表', exact: true }).click();

                // [核心修复3] 增强型频率限制检测
                // 检测是否有 Toast 或 Modal 提示“频繁”
                const errorToast = page.locator('.ant-message-notice, .beast-core-modal-content').filter({ 
                     hasText: /频繁|间隔|稍后|导出中/ 
                }).first();
                
                // 给它一点时间出现
                if (await errorToast.isVisible({ timeout: 5000 })) {
                    console.log(`\n🚨 触发频率限制保护！`);
                    // 进入 5分10秒 冷却
                    await countdown(310, "系统冷却中");
                    // 抛出错误以触发 while 循环的 retry，重新执行当前 range
                    throw new Error("Frequency limit triggered - cooling down");
                }

                await page.goto(EXPORT_RECORD_URL, { waitUntil: 'domcontentloaded' });
                
                // ----------------------------------------------------
                // 下载逻辑：智能等待 + 仅下载首个生成的报表
                // ----------------------------------------------------
                let file = null;
                console.log(' -> ⏳ 正在等待第一个“下载报表”按钮出现...');
                
                // 提前定义定位器，精准锁定页面上的第一个包含“下载报表”文本的按钮
                const firstDownloadBtn = page.locator('button:has-text("下载报表")').first();

                try {
                    // 严格等待第一个按钮在 DOM 中变为可见状态
                    await firstDownloadBtn.waitFor({ state: 'visible', timeout: 100000 });
                } catch (e) {
                    console.warn(' -> ⚠️ 等待超时，尝试点击“刷新”...');
                    const refreshBtn = page.getByText('刷新').or(page.getByText('查询')).first();
                    if (await refreshBtn.isVisible()) {
                        await refreshBtn.click({ force: true });
                        await page.waitForTimeout(3000);
                        // 刷新后再次尝试短暂等待按钮出现
                        await firstDownloadBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
                    }
                }

                let downloadSuccess = false;

                // 判断第一个按钮是否真的存在并且可见
                if (await firstDownloadBtn.isVisible()) {
                    console.log(` -> 🎯 已检测到第一个“下载报表”按钮，尝试点击下载...`);
                    try {
                        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
                        // 配合 force: true 强力点击，防止被浮层遮挡
                        await firstDownloadBtn.click({ force: true });
                        const down = await downloadPromise;
                        file = path.join(ORDER_DOWNLOAD_FOLDER, down.suggestedFilename());
                        await down.saveAs(file);
                        console.log(` ✅ 下载成功: ${path.basename(file)}`);
                        downloadSuccess = true;
                    } catch (e) {
                        console.error(` -> ❌ 点击了第一个按钮但未触发下载:`, e.message);
                        // 如果有需要截图记录错误，可以取消下方注释
                        // await page.screenshot({ path: `error_download_click_${Date.now()}.png`, fullPage: true });
                    }
                } else {
                    console.warn(` -> ⚠️ 页面上未能找到任何“下载报表”按钮。`);
                }

                // 如果未下载成功，说明由于之前的频率限制导致报表根本没生成，
                // 或者生成失败了。抛出错误，重试当前任务。
                if (!downloadSuccess) {
                    throw new Error("首个“下载报表”按钮未触发下载或未找到，可能报表未生成。");
                }

                if (file) await importFileWithSupport(file);
                
                // 成功完成，退出重试循环，处理下一个 range
                break;

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
        
        // 遍历所有配置的店铺
        for (const config of STORE_CONFIGS) {
            console.log(`\n======================================================`);
            console.log(`🚀 开始执行店铺任务: 【${config.storeName}】`);
            console.log(`📂 使用浏览器配置: ${config.profileDir}`);
            console.log(`======================================================`);

            let context = null;
            let page = null;
            
            try {
                // 为每个店铺启动独立的持久化上下文
                context = await chromium.launchPersistentContext(config.profileDir, { 
                    headless: false, 
                    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
                    viewport: null, 
                    downloadsPath: ORDER_DOWNLOAD_FOLDER 
                });
                page = context.pages()[0] || await context.newPage();
                
                // 将 config.storeName 传递给任务函数，以便后续查漏和入库使用
                await pddOrderTask(page, config.storeName); 
                
            } catch (storeError) {
                console.error(`\n❌ 店铺 【${config.storeName}】 执行过程中发生严重错误:`, storeError.message);
                // 截图保存错误状态以备排查
                if (page) {
                    await page.screenshot({ path: `error_${config.storeName}_${Date.now()}.png`, fullPage: true }).catch(()=>{});
                }
            } finally {
                // 必须关闭当前店铺的浏览器，才能安全进入下一个店铺
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