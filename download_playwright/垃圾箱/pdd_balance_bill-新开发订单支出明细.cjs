// pdd_balance_bill.js - [资金账单收支明细 - 裂变全自动版]

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const Database = require('better-sqlite3');
const path = require('path');

const STORE_NAME = '测试店铺_01'; // 记得改成你实际的店铺名
// 绝对路径：直接指向你的大盘主数据库
const MAIN_DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';

// --- [核心工具] 数据库与任务表初始化 ---
function initDB() {
    const db = new Database(MAIN_DB_PATH);
    
    // 1. 创建资金账单专属数据表
    db.exec(`
        CREATE TABLE IF NOT EXISTS pdd_balance_bill (
            billId TEXT PRIMARY KEY, 
            mallId INTEGER, 
            orderSn TEXT, 
            amount INTEGER, 
            createdAt INTEGER, 
            type INTEGER, 
            classIdDesc TEXT, 
            financeIdDesc TEXT, 
            note TEXT, 
            sourceBizNo TEXT, 
            billOutBizDesc TEXT, 
            storeName TEXT,
            insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 2. 创建资金账单专属的任务检查点表 (加了 _balance 后缀，防止跟之前的任务冲突)
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_task_log_balance (
            chunk_key TEXT PRIMARY KEY, startStr TEXT, endStr TEXT,
            startSec INTEGER, endSec INTEGER, status TEXT,
            updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

const formatExactTime = (sec) => {
    const d = new Date(sec * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
};

// --- [任务分发引擎] ---
// --- [任务分发器：增加 365 天最高历史边界限制] ---
function getPendingTasks(db, accountConfig, startYear) {
    const prefix = accountConfig.taskLogPrefix;
    console.log(`[${STORE_NAME}] 核对【${accountConfig.accountName}】同步进度...`);
    const chunks = [];
    
    let current = new Date(`${startYear}-01-01T00:00:00`);
    const now = new Date();
    const todayEndSec = Math.floor(now.getTime() / 1000);
    
    // 🌟 [增量修正]：强制将时间跨度控制在一年（365天）以内，规避平台冷数据报错
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
    if (current < oneYearAgo) {
        current = oneYearAgo;
        console.log(`⚠️ [边界修正] 平台接口禁止查询1年前数据，起点已自动重置为: ${formatExactTime(current.getTime()/1000)}`);
    }
    
    const allLogs = db.prepare('SELECT * FROM sync_task_log_all WHERE account_type = ?').all(accountConfig.accountName);

    while (current < now) {
        let nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        let endOfCurrentMonth = new Date(nextMonth.getTime() - 1000); 
        if (endOfCurrentMonth > now) endOfCurrentMonth = now;
        
        const startSec = Math.floor(current.getTime() / 1000);
        const endSec = Math.floor(endOfCurrentMonth.getTime() / 1000);
        chunks.push({ startStr: formatExactTime(startSec), endStr: formatExactTime(endSec), startSec, endSec });
        current = nextMonth;
    }

    const pendingTasks = [];
    for (const chunk of chunks.reverse()) {
        const exactMatch = allLogs.find(log => log.startSec === chunk.startSec && log.endSec === chunk.endSec);
        if (exactMatch) {
            if ((exactMatch.status !== 'DONE' && exactMatch.status !== 'TRUNCATED') || chunk.endSec >= todayEndSec - 86400) {
                pendingTasks.push({ ...chunk, key: exactMatch.chunk_key });
            }
        } else {
            const hasFragments = allLogs.some(log => log.startSec >= chunk.startSec && log.endSec <= chunk.endSec);
            if (!hasFragments) pendingTasks.push({ ...chunk, key: `${prefix}${chunk.startSec}_${chunk.endSec}` });
        }
    }
    
    const fragmentedTasks = allLogs.filter(log => log.status === 'PENDING');
    for (const frag of fragmentedTasks) {
        if (!pendingTasks.some(t => t.key === frag.chunk_key)) {
            pendingTasks.push({ startStr: frag.startStr, endStr: frag.endStr, startSec: frag.startSec, endSec: frag.endSec, key: frag.chunk_key });
        }
    }
    return pendingTasks.sort((a, b) => b.startSec - a.startSec);
}

async function highlightElement(locator, message) {
    await locator.waitFor({ state: 'attached', timeout: 30000 });
    await locator.evaluate(node => {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.style.border = '5px solid red';
        node.style.boxShadow = '0 0 20px red';
        node.style.backgroundColor = '#ffcccc';
    });
    console.log(`\n🔴 【等待人工操作】: ${message}`);
}

async function runBalanceScraper() {
    const db = initDB();
    const pendingTasks = getPendingTasks(db, 2022); 
    
    if (pendingTasks.length === 0) {
        console.log(`[${STORE_NAME}] 所有资金账单历史数据已同步完毕！`);
        db.close();
        return;
    }

    let globalTotalFetched = 0;
    let globalTotalInserted = 0;
    let browserContext;
    const USER_DATA_DIR = path.join(__dirname, 'PDD', 'pdd-auth-profile');

    try {
        console.log(`[${STORE_NAME}] 启动浏览器...`);
        browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: false, viewport: { width: 1366, height: 768 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        let page = browserContext.pages()[0] || await browserContext.newPage();
        await page.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        if (page.url().includes('login')) {
            console.log(`[${STORE_NAME}] ⚠️ 等待扫码登录...`);
            await page.waitForURL('**/home', { timeout: 300000 });
        }

        const cashierLink = page.locator('a[href*="/cashier/finance/payment-bills"]').first();
        await highlightElement(cashierLink, '请在左侧点击【对账中心】！');
        
        const cashierPage = await browserContext.waitForEvent('page', { timeout: 120000 });
        await cashierPage.waitForLoadState('domcontentloaded');
        await cashierPage.bringToFront();

        // 【注意】因为你说对账中心默认进入的就是这个接口的页面，所以这里不需要再去点击其他 Tab 了！
        console.log(`[${STORE_NAME}] 已进入对账中心默认视图，准备接管查询引擎...`);
        await cashierPage.waitForTimeout(3000); 

        // ================= [拦截器与数据库准备] =================
        let currentIterPage = 1;
        let currentChunkStart = 0;
        let currentChunkEnd = 0;

        await cashierPage.route('**/pagingQueryMallBalanceBillListForMms*', async route => {
            const request = route.request();
            if (request.method() === 'POST') {
                try {
                    const postData = JSON.parse(request.postData() || '{}');
                    
                    // ✅ 完美匹配真实请求的 Payload
                    postData.pageNum = currentIterPage;
                    postData.pageSize = 100; 
                    postData.inclusiveBeginTime = currentChunkStart;
                    postData.exclusiveEndTime = currentChunkEnd;

                    await route.continue({ postData: JSON.stringify(postData) });
                } catch (e) {
                    await route.continue();
                }
            } else {
                await route.continue();
            }
        });

        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO pdd_balance_bill (
                billId, mallId, orderSn, amount, createdAt, type, 
                classIdDesc, financeIdDesc, note, sourceBizNo, billOutBizDesc, storeName
            ) VALUES (
                @billId, @mallId, @orderSn, @amount, @createdAt, @type, 
                @classIdDesc, @financeIdDesc, @note, @sourceBizNo, @billOutBizDesc, @storeName
            )
        `);
        
        const updateTaskStmt = db.prepare(`
            INSERT OR REPLACE INTO sync_task_log_balance (chunk_key, startStr, endStr, startSec, endSec, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // ================= [任务循环与动态裂变] =================
        const queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();
        console.log(`\n[${STORE_NAME}] 🤖 资金账单引擎启动，随时应对爆单阻击...`);

        while (pendingTasks.length > 0) {
            const task = pendingTasks.shift(); 
            console.log(`\n=================================================`);
            console.log(`📅 执行区块任务: ${task.startStr} 至 ${task.endStr}`);
            
            currentChunkStart = task.startSec;
            currentChunkEnd = task.endSec;
            currentIterPage = 1;
            let totalPagesForChunk = 1;
            let chunkTotalFetched = 0;
            let chunkTotalInserted = 0;
            let taskStatus = 'DONE'; 

            while (currentIterPage <= totalPagesForChunk) {
                try {
                    const [apiResponse] = await Promise.all([
                        cashierPage.waitForResponse(res => 
                            res.url().includes('pagingQueryMallBalanceBillListForMms') && 
                            res.request().method() === 'POST' && res.status() === 200,
                            { timeout: 30000 }
                        ),
                        queryBtnLocator.click({ force: true })
                    ]);

                    const resJson = await apiResponse.json();
                    if (!resJson.success) throw new Error(`API报错: ${resJson.errorMsg}`);

                    // 兼容拼多多不同 API 返回列表的命名习惯
                    const dtoList = resJson.result?.billList || resJson.result?.dtoList || resJson.result?.list || [];
                    
                    if (currentIterPage === 1) {
                        const totalRecords = resJson.result?.total || 0;
                        
                        if (totalRecords >= 9500) {
                            if (currentChunkEnd - currentChunkStart <= 1) {
                                console.log(`[${STORE_NAME}] 🛑 触碰物理极限！同一秒内爆出 ${totalRecords} 单！`);
                                totalPagesForChunk = 100;
                                taskStatus = 'TRUNCATED';
                            } else {
                                console.log(`[${STORE_NAME}] 🚨 逼近死亡红线(${totalRecords}条)！正在向小时/分钟级深度裂变...`);
                                const midSec = Math.floor((currentChunkStart + currentChunkEnd) / 2);
                                
                                const key1 = `${currentChunkStart}_${midSec}`;
                                const key2 = `${midSec + 1}_${currentChunkEnd}`;
                                const str1End = formatExactTime(midSec);
                                const str2Start = formatExactTime(midSec + 1);
                                
                                updateTaskStmt.run(key1, task.startStr, str1End, currentChunkStart, midSec, 'PENDING');
                                updateTaskStmt.run(key2, str2Start, task.endStr, midSec + 1, currentChunkEnd, 'PENDING');
                                
                                db.prepare('DELETE FROM sync_task_log_balance WHERE chunk_key = ?').run(task.key);
                                
                                pendingTasks.push({ key: key1, startStr: task.startStr, endStr: str1End, startSec: currentChunkStart, endSec: midSec });
                                pendingTasks.push({ key: key2, startStr: str2Start, endStr: task.endStr, startSec: midSec + 1, endSec: currentChunkEnd });

                                console.log(`[${STORE_NAME}] ✂️ 裂变完成！已拆分为两个小碎片。`);
                                taskStatus = 'FISSION';
                                break; 
                            }
                        } else {
                            totalPagesForChunk = Math.ceil(totalRecords / 100);
                            console.log(`[${STORE_NAME}] 安全区间，共计: ${totalRecords} 条，需翻页: ${totalPagesForChunk} 次。`);
                        }
                        if (totalRecords === 0) break; 
                    }

                    if (dtoList.length === 0) break;

                    const transaction = db.transaction((items) => {
                        let insertedCount = 0;
                        for (const item of items) {
                            try { 
                                item.storeName = STORE_NAME; 
                                // 处理可能为空的字段，防止插入报错
                                item.classIdDesc = item.classIdDesc || '';
                                item.financeIdDesc = item.financeIdDesc || '';
                                item.note = item.note || '';
                                item.sourceBizNo = item.sourceBizNo || '';
                                item.billOutBizDesc = item.billOutBizDesc || '';

                                const info = insertStmt.run(item);
                                insertedCount += info.changes; 
                            } catch (e) {}
                        }
                        return insertedCount;
                    });
                    
                    const actuallyInserted = transaction(dtoList);
                    chunkTotalFetched += dtoList.length;
                    chunkTotalInserted += actuallyInserted;
                    globalTotalFetched += dtoList.length;
                    globalTotalInserted += actuallyInserted;

                    console.log(`[${STORE_NAME}] 第 ${currentIterPage}/${totalPagesForChunk} 页 | 截获: ${dtoList.length}，新增: ${actuallyInserted}`);
                    
                    await cashierPage.waitForTimeout(Math.floor(Math.random() * 1500) + 1500);
                    currentIterPage++;

                } catch (err) {
                    console.error(`[${STORE_NAME}] ❌ 异常中断:`, err.message);
                    taskStatus = 'FAILED';
                    break; 
                }
            }
            
            if (taskStatus === 'DONE' || taskStatus === 'TRUNCATED') {
                const todayEndSec = Math.floor(new Date().getTime() / 1000);
                const finalStatus = (task.endSec >= todayEndSec - 86400 && taskStatus !== 'TRUNCATED') ? 'PENDING' : taskStatus;
                updateTaskStmt.run(task.key, task.startStr, task.endStr, task.startSec, task.endSec, finalStatus);
                console.log(`✅ 日志戳已更新为: ${finalStatus}。本区新增落盘: ${chunkTotalInserted} 条。`);
            } else if (taskStatus === 'FAILED') {
                console.log(`⚠️ 区块任务失败，将在后续重试。`);
            }
        }

        console.log(`\n🎉🎉🎉 [${STORE_NAME}] 资金账单同步完毕！`);
        console.log(`📊 【最终运行报告】总截获: ${globalTotalFetched} 条 | 总新增: ${globalTotalInserted} 条`);

    } catch (e) {
        console.error(`[${STORE_NAME}] 发生全局错误:`, e);
    } finally {
        if (db) db.close();
        if (browserContext) await browserContext.close();
    }
}

runBalanceScraper();