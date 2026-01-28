// PDD_Order_Full_Task_Final.js - 拼多多订单报表全自动下载入库脚本
// [2026-01-27 V25 诊断修复版] 
// 核心修复：增加数据库路径打印、前后行数对比、单例数据库连接

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

// ======================= [全局配置区域] =======================
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询');
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入');
const CENTRAL_DB_PATH = path.join(__dirname, 'sql_data', 'TmallDataCenter.db');

const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0'; 
const EXPORT_RECORD_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

const ORDER_CHECK_PAST_DAYS = 90;
const DB_ORDER_TABLE_NAME = 'pddorder'; 
const ORDER_PRIMARY_KEY = '订单号';
const ORDER_PAYMENT_DATE_HEADER = '支付日期'; 

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

function formatPaymentDate(dateTimeStr) {
    if (!dateTimeStr) return null;
    const cleanStr = String(dateTimeStr).trim();
    const dateMatch = cleanStr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (dateMatch) {
        return `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }
    return null;
}

// ======================= [UI 交互逻辑] =======================

async function selectDateRange(page, dateStrStart, dateStrEnd) {
    const dayStart = parseInt(dateStrStart.split('-')[2], 10).toString();
    const dayEnd = parseInt(dateStrEnd.split('-')[2], 10).toString();
    const portal = page.locator('[data-testid="beast-core-portal"]');

    const clickRobust = async (targetDay, type) => {
        const candidates = portal.locator('td').filter({ hasText: new RegExp(`^${targetDay}$`) });
        const count = await candidates.count();
        let clickedAny = false;
        for (let i = 0; i < count; i++) {
            try {
                const el = candidates.nth(i);
                if (await el.isVisible()) {
                    await el.click({ timeout: 2000, force: true });
                    clickedAny = true;
                    await page.waitForTimeout(300); 
                    break;
                }
            } catch (e) {}
        }
        if (!clickedAny) throw new Error(`无法在日历中点击 ${type}: ${targetDay}`);
    };

    console.log(` -> 正在点击日期: ${dayStart} 至 ${dayEnd}`);
    await clickRobust(dayStart, "起始日期");
    await randomDelay(300, 500);
    await clickRobust(dayEnd, "结束日期");
    await randomDelay(300, 500);

    const confirmBtn = portal.locator('button').filter({ hasText: /^确认$/ });
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
    }
}

// ======================= [数据库与文件处理 (诊断增强版)] =======================

// 统一的 DB 实例，避免频繁开关
let globalDb = null;

function getDbConnection() {
    if (!globalDb) {
        console.log(`\n🛠️ [数据库连接] 正在连接数据库...`);
        console.log(`   -> 绝对路径: ${path.resolve(CENTRAL_DB_PATH)}`); // 关键诊断信息
        
        try {
            // 确保目录存在
            const dir = path.dirname(CENTRAL_DB_PATH);
            // 这里我们不使用 fs.mkdir (同步API在 node 中较繁琐), 假设目录由脚本最开始创建
            
            globalDb = new Database(CENTRAL_DB_PATH);
            // 开启 WAL 模式提高并发性能
            globalDb.pragma('journal_mode = WAL'); 
        } catch (e) {
            console.error(`❌ 无法打开数据库: ${e.message}`);
            throw e;
        }
    }
    return globalDb;
}

async function importFileWithSupport(filePath) {
    const db = getDbConnection();
    try {
        let finalExcelPath = filePath;
        let isTempFile = false;

        if (filePath.toLowerCase().endsWith('.zip')) {
            console.log(` -> 📦 解压 ZIP...`);
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
            // 诊断：获取处理前的总数
            let beforeCount = 0;
            try {
                const row = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get();
                if (row) beforeCount = row.c;
            } catch (e) {} // 表可能不存在

            const opsCount = processOrderDataForDatabase(rawData, path.basename(filePath), db);
            
            // 诊断：获取处理后的总数
            let afterCount = 0;
            try {
                afterCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get().c;
            } catch (e) {}

            const realAdded = afterCount - beforeCount;
            console.log(` ✅ 入库操作完成: 包含更新/插入共 ${opsCount} 条。`);
            console.log(`    📊 [诊断] 表内总数: ${beforeCount} -> ${afterCount} (实际新增: ${realAdded} 条)`);
            
            if (realAdded === 0 && opsCount > 0) {
                console.log(`    ⚠️ 提示: 总数未增加，说明这 ${opsCount} 条数据是覆盖了旧数据 (订单号重复)。`);
            }
        }
        
        await fs.mkdir(ORDER_ARCHIVE_FOLDER, { recursive: true });
        await fs.rename(filePath, path.join(ORDER_ARCHIVE_FOLDER, path.basename(filePath)));
        if (isTempFile) await fs.rm(path.dirname(finalExcelPath), { recursive: true, force: true });
    } catch (e) {
        console.error(` ❌ 入库错误: ${e.message}`);
    }
    // 注意：不再关闭 db，保持单例连接直到脚本结束
}

function processOrderDataForDatabase(rawData, fileName, db) {
    const cleaned = rawData.map(row => {
        const obj = {};
        for (const k in row) obj[String(k).trim()] = row[k];
        return obj;
    });
    const first = cleaned[0];
    if (!first) return 0;
    
    const headers = [...Object.keys(first), ORDER_PAYMENT_DATE_HEADER];
    const rows = cleaned.map(row => {
        const nr = { ...row };
        nr[ORDER_PAYMENT_DATE_HEADER] = formatPaymentDate(row['支付时间']);
        return nr[ORDER_PRIMARY_KEY] && nr[ORDER_PAYMENT_DATE_HEADER] ? nr : null;
    }).filter(r => r);

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
                const k = headers.find(h => h.replace(/[\s\.\-\/\\()]/g, '_') === c);
                ins[c] = r[k] !== undefined ? String(r[k]) : null;
            });
            if (stmt.run(ins).changes > 0) cnt++;
        }
    })();
    return cnt;
}

// ======================= [日期查漏] =======================

async function getMissingDatesFromDatabase(daysAgo) {
    const db = getDbConnection();
    const needed = new Set();
    const today = new Date();
    for(let i=1; i<=daysAgo; i++) {
        const d = new Date(); d.setDate(today.getDate()-i);
        needed.add(formatDate(d));
    }
    try {
        const col = ORDER_PAYMENT_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(DB_ORDER_TABLE_NAME);
        if(!check) return needed;
        const rows = db.prepare(`SELECT DISTINCT "${col}" FROM "${DB_ORDER_TABLE_NAME}" WHERE "${col}" >= ?`).all(formatDate(new Date(today.setDate(today.getDate()-daysAgo))));
        const exist = new Set(rows.map(r=>r[col]));
        return new Set([...needed].filter(d=>!exist.has(d)));
    } catch(e) { return needed; }
}

function groupConsecutiveDates(set) {
    const arr = Array.from(set).sort();
    if(!arr.length) return [];
    const ranges = [];
    let start = arr[0], end = arr[0];
    for(let i=1; i<arr.length; i++) {
        const next = new Date(end); next.setDate(next.getDate()+1);
        if(formatDate(next) === arr[i]) end = arr[i];
        else { ranges.push({start, end}); start = arr[i]; end = arr[i]; }
    }
    ranges.push({start, end});
    return ranges;
}

// ======================= [主流程] =======================

async function pddOrderTask(page) {
    console.log(`\n--- 📦 [任务] 启动报表同步 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    const missing = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS);
    if (!missing.size) return console.log("✅ 数据库最新。");

    const ranges = groupConsecutiveDates(missing);
    console.log(` -> 缺失 ${missing.size} 天，分 ${ranges.length} 批。`);

    for (const range of ranges) {
        console.log(`\n[执行] 正在处理: ${range.start} 至 ${range.end}`);
        
        await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try {
            const closeIcon = page.locator('[data-testid="beast-core-modal-icon-close"]');
            if (await closeIcon.isVisible({ timeout: 5000 })) {
                await closeIcon.click();
                await randomDelay(500, 1000);
            }
        } catch (e) {}
        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

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
        if (!isPickerOpen) throw new Error('❌ 严重错误：无法打开日期选择器。');
        await randomDelay(500, 1000);

        const resetLink = page.locator('text=归零').first(); 
        if (await resetLink.isVisible()) {
            console.log(' -> 点击归零...');
            await resetLink.click({ force: true });
            await randomDelay(700, 1000); 
            if (!await datePickerPortal.isVisible()) {
                console.log(' -> 归零后日历关闭，正在重新打开...');
                await dateInput.click({ force: true });
                await datePickerPortal.waitFor({ state: 'visible', timeout: 5000 });
            }
        }

        await selectDateRange(page, range.start, range.end);
        await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
        
        await page.getByRole('button', { name: '查询', exact: true }).click();
        await page.waitForTimeout(3000);
        await page.getByRole('button', { name: '批量导出' }).click();
        await page.waitForTimeout(2000);
        await page.getByRole('button', { name: '生成报表' }).click();

        await page.goto(EXPORT_RECORD_URL, { waitUntil: 'domcontentloaded' });
        
        let file = null;
        for (let i = 0; i < 30; i++) {
            const box = page.locator('div.download-box').first();
            const btn = box.locator('button').filter({ hasText: '下载报表' });
            
            if (await btn.count() > 0) {
                console.log(` -> [${i+1}/30] 🎯 点击下载...`);
                await btn.evaluate(n => n.style.border = '5px solid red');
                try {
                    const prom = page.waitForEvent('download', { timeout: 45000 });
                    await btn.click({ force: true });
                    const down = await prom;
                    file = path.join(ORDER_DOWNLOAD_FOLDER, down.suggestedFilename());
                    await down.saveAs(file);
                    console.log(` ✅ 下载成功: ${path.basename(file)}`);
                    break;
                } catch (e) { console.error(` ⚠️ 下载异常: ${e.message}`); }
            } else {
                const txt = await box.innerText().catch(()=>'');
                process.stdout.write(`\r -> [${i+1}/30] ⏳ ${txt.includes('生成中')?'生成中':'列表检查'}...`);
                const ref = page.getByText('刷新').last();
                if (await ref.isVisible()) await ref.click({ force: true });
                await page.waitForTimeout(5000);
            }
        }
        if (file) await importFileWithSupport(file);
        await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
    }
}

async function main() {
    console.log(`\n--- 🚀 [PDD Full Task V25] 启动 ---`);
    let context, page;
    try {
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });
        
        // 显式创建数据库目录确保路径有效
        await fs.mkdir(path.dirname(CENTRAL_DB_PATH), { recursive: true });

        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null, 
            downloadsPath: ORDER_DOWNLOAD_FOLDER 
        });
        page = context.pages()[0] || await context.newPage();
        await pddOrderTask(page);
    } catch (e) {
        console.error('\n❌ 错误:', e.message);
    } finally {
        if (context) {
            console.log('\n🔚 结束，关闭浏览器...');
            if (page) await page.waitForTimeout(3000);
            await context.close();
        }
        // 最后关闭数据库连接
        if (globalDb) {
            console.log(' -> 关闭数据库连接');
            globalDb.close();
        }
    }
}

main();