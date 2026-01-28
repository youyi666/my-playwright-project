// PDD_Order_Full_Task_Final.js - 拼多多订单报表全自动下载入库脚本
// [2026-01-27 V35 鲁棒增强版] 
// 核心升级：
// 1. 增加任务级重试机制 (应对首屏弹窗干扰，失败自动重试一次)
// 2. 增加导出频率限制检测 (如果遇到5分钟限制，自动倒计时等待并重试)
// 3. 保留 V34 所有已验证的日期选择与数据库修复逻辑

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

function addOneDay(dateStr) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + 1);
    return formatDate(date);
}

// 倒计时工具函数
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

// ======================= [UI 交互逻辑] =======================

// 增强弹窗关闭逻辑
async function tryClosePopups(page) {
    try {
        // 常见的弹窗关闭按钮选择器
        const closeSelectors = [
            '[data-testid="beast-core-modal-icon-close"]',
            '.beast-core-modal-close',
            'button[aria-label="Close"]',
            // 有时候会有全屏遮罩的“知道了”按钮
            'button:has-text("知道了")',
            'button:has-text("关闭")'
        ];

        for (const selector of closeSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 检测到干扰弹窗，尝试关闭...`);
                await btn.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
    } catch (e) {
        // 忽略弹窗处理错误
    }
}

async function performReset(page) {
    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    const dateInput = page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]');
    
    // 1. 打开日历
    if (!await calendarContainer.isVisible()) {
        await dateInput.click({ force: true });
        try { await calendarContainer.waitFor({ state: 'visible', timeout: 3000 }); } catch (e) {}
    }

    // 2. 检查是否有“归零”
    let resetLink = calendarContainer.locator('text=归零').or(calendarContainer.locator('a, span').filter({ hasText: '归零' })).first(); 
    
    // 3. 【关键逻辑】如果没找到归零按钮，说明输入框是空的
    // 我们先随便点一个日期（比如“今天”或者列表里的第一个数字），强行让“归零”出现
    if (!await resetLink.isVisible()) {
        console.log(' -> ℹ️ 未发现归零按钮(可能为空)，正在尝试点击任意日期以激活...');
        try {
            // 随便点一个可见的 td
            const anyDate = calendarContainer.locator('td:not(.disabled)').first();
            if (await anyDate.count() > 0) {
                await anyDate.click({ force: true });
                await page.waitForTimeout(500); 
                // 点完日期后，日历可能会关，或者“归零”会出现。
                // 如果日历关了，重新点开
                if (!await calendarContainer.isVisible()) {
                    await dateInput.click({ force: true });
                    await calendarContainer.waitFor({ state: 'visible', timeout: 3000 });
                }
            }
        } catch (e) {
            console.log(' -> 激活点击失败，跳过...');
        }
    }

    // 4. 再次寻找并点击归零
    if (await resetLink.isVisible()) {
        console.log(' -> 🎯 发现归零按钮，执行清除...');
        await resetLink.evaluate(el => el.click()); 
        await page.waitForTimeout(1000); 

        // 5. 归零后确保日历是打开状态（因为后面要选正确日期）
        if (!await calendarContainer.isVisible()) {
            console.log(' -> 归零后日历关闭，重新打开...');
            await dateInput.click({ force: true });
            await calendarContainer.waitFor({ state: 'visible', timeout: 5000 });
        }
    } else {
        console.log(' -> ⚠️ 尝试激活后仍未发现归零按钮，假定已是干净状态。');
    }
}

async function selectDateRange(page, dateStrStart, dateStrEnd) {
    const uiDateStrEnd = addOneDay(dateStrEnd);
    const dayStart = parseInt(dateStrStart.split('-')[2], 10).toString();
    const dayEnd = parseInt(uiDateStrEnd.split('-')[2], 10).toString();

    console.log(` -> [日期选择] 逻辑范围: ${dateStrStart}至${dateStrEnd} | UI操作: ${dayStart}号 和 ${dayEnd}号`);

    const calendarContainer = page.locator('[data-testid="beast-core-portal"]');
    
    if (!await calendarContainer.isVisible()) {
        await page.locator('input[data-testid="beast-core-rangePicker-htmlInput"]').click({ force: true });
        await calendarContainer.waitFor({ state: 'visible', timeout: 3000 });
    }

    const clickSmart = async (targetDay, type) => {
        const regex = new RegExp(`^\\s*${targetDay}\\s*$`);
        const candidates = calendarContainer.locator('td').filter({ hasText: regex });
        const count = await candidates.count();

        let clickSuccess = false;
        for (let i = 0; i < count; i++) {
            const el = candidates.nth(i);
            if (!await el.isVisible()) continue;
            
            const className = await el.getAttribute('class') || '';
            const textContent = await el.innerText();
            if (textContent.trim() !== targetDay) continue;
            if (className.includes('disabled') || className.includes('prev-month') || className.includes('next-month') || className.includes('gray')) continue;

            try {
                await el.click({ timeout: 1000, force: true });
                clickSuccess = true;
                await page.waitForTimeout(300); 
                break; 
            } catch (e) {}
        }
        if (!clickSuccess) {
            try { await candidates.last().click({ timeout: 2000, force: true }); } 
            catch (e) { throw new Error(`无法点击: ${targetDay}`); }
        }
    };

    await clickSmart(dayStart, "起始日期");
    await randomDelay(600, 1000); 
    await clickSmart(dayEnd, "结束日期");
    await randomDelay(500, 800);

    const confirmBtn = calendarContainer.locator('button').filter({ hasText: /^确认$/ })
        .or(calendarContainer.getByRole('button', { name: '确认' }));
    if (await confirmBtn.isVisible()) await confirmBtn.click();
}

// ======================= [数据库与文件处理] =======================

let globalDb = null;
function getDbConnection() {
    if (!globalDb) {
        console.log(`\n🛠️ [数据库连接] 路径: ${path.resolve(CENTRAL_DB_PATH)}`);
        try {
            fs.mkdir(path.dirname(CENTRAL_DB_PATH), { recursive: true }).catch(()=>{});
            globalDb = new Database(CENTRAL_DB_PATH);
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
            const beforeCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            const opsCount = processOrderDataForDatabase(rawData, path.basename(filePath), db);
            const afterCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            const realAdded = afterCount - beforeCount;

            console.log(` ✅ 入库处理完成: 有效数据 ${opsCount} 条。`);
            console.log(`    📊 [统计] 库内总数: ${beforeCount} -> ${afterCount} (实际新增: ${realAdded} 条)`);
        }
        
        await fs.mkdir(ORDER_ARCHIVE_FOLDER, { recursive: true });
        await fs.rename(filePath, path.join(ORDER_ARCHIVE_FOLDER, path.basename(filePath)));
        if (isTempFile) await fs.rm(path.dirname(finalExcelPath), { recursive: true, force: true });
    } catch (e) {
        console.error(` ❌ 入库错误: ${e.message}`);
    }
}

function processOrderDataForDatabase(rawData, fileName, db) {
    const cleaned = rawData.map(row => {
        const obj = {};
        for (const k in row) obj[String(k).trim()] = row[k];
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

// ======================= [主流程 (V35 重构)] =======================

async function pddOrderTask(page) {
    console.log(`\n--- 📦 [任务] 启动报表同步 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    const missing = await getMissingDatesFromDatabase(ORDER_CHECK_PAST_DAYS);
    if (!missing.size) return console.log("✅ 数据库最新。");

    const ranges = groupConsecutiveDates(missing);
    console.log(` -> 缺失 ${missing.size} 天，分 ${ranges.length} 批。`);

    // ----------------- V35: 任务级重试循环 -----------------
    for (const range of ranges) {
        let attempt = 0;
        const maxAttempts = 2; // 允许失败重试一次

        while (attempt < maxAttempts) {
            attempt++;
            try {
                console.log(`\n[执行] 正在处理: ${range.start} 至 ${range.end} (第 ${attempt} 次尝试)`);
                
                await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // V35: 主动尝试清理首屏弹窗
                await tryClosePopups(page);
                await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);

                // 1. 归零 & 选日期
                await performReset(page);
                await selectDateRange(page, range.start, range.end);
                
                // 2. 导出申请流程
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
                await page.getByRole('button', { name: '查询', exact: true }).click();
                await page.waitForTimeout(3000);
                await page.getByRole('button', { name: '批量导出' }).click();
                await page.waitForTimeout(2000);
                await page.getByRole('button', { name: '生成报表' }).click();

                // ----------------- V35: 5分钟频率限制检测 -----------------
                // 点击生成后，立即检测是否有报错提示
                // 常见提示: "操作过于频繁", "两次导出需间隔", "请稍后"
                try {
                    const errorToast = page.locator('.ant-message-notice, .beast-core-modal-content').filter({ 
                        hasText: /频繁|间隔|稍后|导出中/ 
                    }).first();
                    
                    if (await errorToast.isVisible({ timeout: 4000 })) {
                        const errorText = await errorToast.innerText();
                        console.log(`\n🚨 检测到频率限制警告: [${errorText}]`);
                        console.log(` -> 🛑 触发保护机制，进入 5 分钟冷却倒计时...`);
                        
                        // 倒计时 310 秒 (5分10秒)
                        await countdown(310, "频率冷却中");
                        
                        console.log(` -> ♻️ 冷却结束，重新尝试当前任务...`);
                        throw new Error("Frequency limit triggered - retrying after wait"); // 抛出错误以触发重试
                    }
                } catch (e) {
                    if (e.message.includes("Frequency")) throw e; // 向上抛出以触发 while 循环重试
                    // 没检测到错误，说明正常，继续
                }
                // --------------------------------------------------------

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

                // 成功完成，跳出重试循环，处理下一个 range
                break; 

            } catch (error) {
                console.error(`\n❌ [尝试 ${attempt}/${maxAttempts} 失败] 原因: ${error.message}`);
                
                if (attempt >= maxAttempts) {
                    console.error(`   💀 达到最大重试次数，跳过此日期段: ${range.start}`);
                } else {
                    console.log(`   🔄 准备重新加载页面并重试...`);
                    await page.waitForTimeout(3000); // 缓冲一下再刷新
                }
            }
        }
    }
}

async function main() {
    console.log(`\n--- 🚀 [PDD Full Task V35 鲁棒增强版] 启动 ---`);
    let context, page;
    try {
        await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true });
        await fs.mkdir(path.dirname(CENTRAL_DB_PATH), { recursive: true }).catch(()=>{});

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
        if (globalDb) globalDb.close();
    }
}

main();