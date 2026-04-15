// pdd_expense_test_V16.js - [深层秒级裂变 + 物理极限防死锁版]

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const Database = require('better-sqlite3');
const path = require('path');

const STORE_NAME = '测试店铺_01';
// ✅ 修改后的写法（绝对路径，直指你的主数据中心）
const TEST_DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';
const USER_DATA_DIR = path.join(__dirname, 'PDD', 'pdd-auth-profile');

function initDB() {
    const db = new Database(TEST_DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pdd_marketing_expense (
            outSn TEXT PRIMARY KEY, bizType INTEGER, cate2 TEXT, settleId INTEGER, 
            billType INTEGER, goodsId INTEGER, goodsName TEXT, goodsAmount INTEGER, 
            costPrice INTEGER, subsidyAmount INTEGER, expenseBatchSn TEXT, 
            payType INTEGER, payTime INTEGER, note TEXT, storeName TEXT, 
            insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_task_log (
            chunk_key TEXT PRIMARY KEY, startStr TEXT, endStr TEXT,
            startSec INTEGER, endSec INTEGER, status TEXT,
            updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

// 🌟【核心修复1】：时间精度下探到秒，保证裂变生成的 Key 绝对唯一
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

function getPendingTasks(db, startYear) {
    console.log(`[${STORE_NAME}] 正在核对任务检查点日志（向下兼容模式）...`);
    const chunks = [];
    let current = new Date(`${startYear}-01-01T00:00:00`);
    const now = new Date();
    const todayEndSec = Math.floor(now.getTime() / 1000);
    
    // 1. 将数据库中所有的历史检查点全部拉入内存
    const allLogs = db.prepare('SELECT * FROM sync_task_log').all();

    while (current < now) {
        let nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        let endOfCurrentMonth = new Date(nextMonth.getTime() - 1000); 
        if (endOfCurrentMonth > now) endOfCurrentMonth = now;
        
        const startSec = Math.floor(current.getTime() / 1000);
        const endSec = Math.floor(endOfCurrentMonth.getTime() / 1000);
        chunks.push({
            startStr: formatExactTime(startSec),
            endStr: formatExactTime(endSec),
            startSec: startSec,
            endSec: endSec
        });
        current = nextMonth;
    }

    const pendingTasks = [];

    // 2. 智能重组逻辑
    for (const chunk of chunks.reverse()) {
        // 通过时间戳范围寻找精确匹配，无视旧版本的字符串 key
        const exactMatch = allLogs.find(log => log.startSec === chunk.startSec && log.endSec === chunk.endSec);
        
        if (exactMatch) {
            // 找到了。如果是未完成，或者是当月的数据（需要随时更新），加入队列。
            // 强行沿用旧的 chunk_key，以保证待会能顺利覆盖状态！
            if ((exactMatch.status !== 'DONE' && exactMatch.status !== 'TRUNCATED') || chunk.endSec >= todayEndSec - 86400) {
                pendingTasks.push({ ...chunk, key: exactMatch.chunk_key });
            }
        } else {
            // 没找到精确匹配的大块。
            // 检查：这个月是不是被“细胞裂变”给拆碎了？（即有没有子碎片的起止时间落在这个大月内）
            const hasFragments = allLogs.some(log => log.startSec >= chunk.startSec && log.endSec <= chunk.endSec);
            
            if (!hasFragments) {
                // 如果连碎片都没有，说明这是一个彻头彻尾的空白月，加入队列！
                pendingTasks.push({ ...chunk, key: `${chunk.startSec}_${chunk.endSec}` });
            }
            // 如果有碎片，这里什么都不做。因为未完成的碎片会在下一步被专门捞出来。
        }
    }
    
    // 3. 把数据库里所有因为裂变产生、且卡在 PENDING 状态的碎片任务专门捞出来
    const fragmentedTasks = allLogs.filter(log => log.status === 'PENDING');
    for (const frag of fragmentedTasks) {
        if (!pendingTasks.some(t => t.key === frag.chunk_key)) {
            pendingTasks.push({
                startStr: frag.startStr, endStr: frag.endStr,
                startSec: frag.startSec, endSec: frag.endSec,
                key: frag.chunk_key
            });
        }
    }

    console.log(`[${STORE_NAME}] 智能核对完毕，精准剔除已完成区域。当前待执行区块: ${pendingTasks.length} 个。`);
    
    // 按时间起点倒序排列，优先抓最近的或最近遗漏的
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

async function runUltimateScraper() {
    const db = initDB();
    const pendingTasks = getPendingTasks(db, 2022); 
    
    if (pendingTasks.length === 0) {
        console.log(`[${STORE_NAME}] 所有历史数据已同步完毕！`);
        db.close();
        return;
    }

    let globalTotalFetched = 0;
    let globalTotalInserted = 0;
    let browserContext;

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

        console.log(`[${STORE_NAME}] 跳转至【结算订单】...`);
        await cashierPage.locator('text="营销活动结算"').first().click();
        await cashierPage.waitForTimeout(1000);
        await cashierPage.locator('text="结算订单"').first().click();
        await cashierPage.waitForTimeout(3000); 

        let currentIterPage = 1;
        let currentChunkStart = 0;
        let currentChunkEnd = 0;

        await cashierPage.route('**/queryExpenseOrderList*', async route => {
            const request = route.request();
            if (request.method() === 'POST') {
                try {
                    const postData = JSON.parse(request.postData() || '{}');
                    postData.page = currentIterPage;
                    postData.size = 100; 
                    postData.payTimeStart = currentChunkStart;
                    postData.payTimeEnd = currentChunkEnd;
                    await route.continue({ postData: JSON.stringify(postData) });
                } catch (e) {
                    await route.continue();
                }
            } else {
                await route.continue();
            }
        });

        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO pdd_marketing_expense (
                outSn, bizType, cate2, settleId, billType, goodsId, goodsName, 
                goodsAmount, costPrice, subsidyAmount, expenseBatchSn, payType, payTime, note, storeName
            ) VALUES (
                @outSn, @bizType, @cate2, @settleId, @billType, @goodsId, @goodsName, 
                @amount, @costPrice, @subsidyAmount, @expenseBatchSn, @payType, @payTime, @note, @storeName
            )
        `);
        
        const updateTaskStmt = db.prepare(`
            INSERT OR REPLACE INTO sync_task_log (chunk_key, startStr, endStr, startSec, endSec, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();
        console.log(`\n[${STORE_NAME}] 🤖 脚本启动，随时应对爆单阻击...`);

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
                            res.url().includes('queryExpenseOrderList') && 
                            res.request().method() === 'POST' && res.status() === 200,
                            { timeout: 30000 }
                        ),
                        queryBtnLocator.click({ force: true })
                    ]);

                    const resJson = await apiResponse.json();
                    if (!resJson.success) throw new Error(`API报错: ${resJson.errorMsg}`);

                    const dtoList = resJson.result?.dtoList || resJson.result?.list || [];
                    
                    if (currentIterPage === 1) {
                        const totalRecords = resJson.result?.total || 0;
                        
                        if (totalRecords >= 9500) {
                            // 🌟【核心修复3】：物理极限兜底防御
                            if (currentChunkEnd - currentChunkStart <= 1) {
                                console.log(`[${STORE_NAME}] 🛑 触碰物理极限！同一秒内爆出 ${totalRecords} 单，时间无法再分！`);
                                console.log(`[${STORE_NAME}] ⚠️ 将强行拉取前 10000 条，放弃尾部数据以保全程序运行...`);
                                totalPagesForChunk = 100; // 封顶 100 页
                                taskStatus = 'TRUNCATED';
                            } else {
                                console.log(`[${STORE_NAME}] 🚨 逼近死亡红线(${totalRecords}条)！正在向小时/分钟级深度裂变...`);
                                const midSec = Math.floor((currentChunkStart + currentChunkEnd) / 2);
                                
                                const key1 = `${currentChunkStart}_${midSec}`;
                                const key2 = `${midSec + 1}_${currentChunkEnd}`;
                                const str1End = formatExactTime(midSec);
                                const str2Start = formatExactTime(midSec + 1);
                                
                                // 分配两块新拼图，并在数据库落案
                                updateTaskStmt.run(key1, task.startStr, str1End, currentChunkStart, midSec, 'PENDING');
                                updateTaskStmt.run(key2, str2Start, task.endStr, midSec + 1, currentChunkEnd, 'PENDING');
                                
                                // 销毁当前臃肿的大块任务
                                db.prepare('DELETE FROM sync_task_log WHERE chunk_key = ?').run(task.key);
                                
                                // 重新塞入队伍
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
                                item.note = item.note || ''; 
                                item.amount = item.goodsAmount || item.amount || 0; 
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

        console.log(`\n🎉🎉🎉 [${STORE_NAME}] 所有数据已无懈可击地全部同步！`);
        console.log(`📊 【最终运行报告】总截获: ${globalTotalFetched} 条 | 总新增: ${globalTotalInserted} 条`);

    } catch (e) {
        console.error(`[${STORE_NAME}] 发生全局错误:`, e);
    } finally {
        if (db) db.close();
        if (browserContext) await browserContext.close();
    }
}

runUltimateScraper();