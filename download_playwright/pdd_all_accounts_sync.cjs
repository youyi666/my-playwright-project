// pdd_finance_v20.js - [V20 终极完全体：多账户+重连+提速+智能超度死锁]

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const Database = require('better-sqlite3');
const path = require('path');

//const STORE_NAME = '测试店铺_01'; 
// ⚠️ 请确保这里是你的主数据库绝对路径
const MAIN_DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';

// =========================================================================
// 🌟 1. 多账户驱动配置表 (Config-Driven)
// =========================================================================
const ACCOUNT_CONFIGS = [
    {
        accountName: '货款账户',
        tabSelector: null, 
        apiUrl: 'pagingQueryMallBalanceBillListForMms',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveBeginTime', end: 'exclusiveEndTime' },
        tableName: 'pdd_balance_bill',
        taskLogPrefix: 'BAL_' 
    },
    {
        accountName: '营销账户',
        tabSelector: '[data-testid="mmsRawMarketingBillQueryTpl"]', 
        apiUrl: 'queryMerchantMarketingBillList',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveStartBizAt', end: 'inclusiveEndBizAt' },
        tableName: 'pdd_marketing_balance_bill',
        taskLogPrefix: 'MKT_' 
    },
    {
        accountName: '保证金账户',
        tabSelector: 'div:has-text("保证金账户")', 
        apiUrl: 'queryMerchantDepositBillList',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveStartBizAt', end: 'inclusiveEndBizAt' },
        tableName: 'pdd_deposit_balance_bill',
        taskLogPrefix: 'DEP_' 
    }
];

// =========================================================================
// 🌟 2. 数据库初始化
// =========================================================================
function initDB() {
    const db = new Database(MAIN_DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pdd_balance_bill (
            billId TEXT PRIMARY KEY, mallId INTEGER, orderSn TEXT, amount INTEGER, createdAt INTEGER, 
            type INTEGER, classIdDesc TEXT, financeIdDesc TEXT, note TEXT, sourceBizNo TEXT, 
            billOutBizDesc TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pdd_marketing_balance_bill (
            flowId TEXT PRIMARY KEY, mallId INTEGER, orderSn TEXT, amount INTEGER, bizAt INTEGER, 
            createdAt INTEGER, note TEXT, accountingTypeDesc TEXT, billOutBizCode TEXT, 
            billOutBizDesc TEXT, flowTitle TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pdd_deposit_balance_bill (
            flowId TEXT PRIMARY KEY, mallId INTEGER, mallAcctType TEXT, bizType TEXT, flowType TEXT, 
            amount INTEGER, bizAt INTEGER, accountingTypeDesc TEXT, note TEXT, createdAt INTEGER, 
            billOutBizCode TEXT, billOutBizDesc TEXT, flowTitle TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sync_task_log_all (
            chunk_key TEXT PRIMARY KEY, account_type TEXT, startStr TEXT, endStr TEXT,
            startSec INTEGER, endSec INTEGER, status TEXT, storeName TEXT, updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    return db;
}

const formatExactTime = (sec) => {
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

function getPendingTasks(db, accountConfig, startYear, storeName) {
    const prefix = accountConfig.taskLogPrefix;
    console.log(`[${storeName}] 正在核对【${accountConfig.accountName}】同步进度...`);
    const chunks = [];
    
    let current = new Date(`${startYear}-01-01T00:00:00`);
    const now = new Date();
    const todayEndSec = Math.floor(now.getTime() / 1000);
    
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
    if (current < oneYearAgo) {
        current = oneYearAgo;
        console.log(`⚠️ [边界修正] 平台限制查询1年前冷数据，起点已自动重置为: ${formatExactTime(current.getTime()/1000)}`);
    }
    
    // 【修改点】严格查询当前店铺的日志
    const allLogs = db.prepare('SELECT * FROM sync_task_log_all WHERE account_type = ? AND storeName = ?').all(accountConfig.accountName, storeName);
    
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
            // 【修改点】新任务的 key 强行加上店铺名前缀，防止主键冲突
            if (!hasFragments) pendingTasks.push({ ...chunk, key: `${storeName}_${prefix}${chunk.startSec}_${chunk.endSec}` });
        }
    }
    
    const fragmentedTasks = allLogs.filter(log => log.status === 'PENDING' && log.account_type === accountConfig.accountName);
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
        node.style.border = '5px solid red'; node.style.boxShadow = '0 0 20px red'; node.style.backgroundColor = '#ffcccc';
    });
    console.log(`\n🔴 【等待人工操作】: ${message}`);
}

// =========================================================================
// 🌟 4. 主爬虫逻辑 (模块化改造版)
// =========================================================================
async function runMultiAccountScraper(homePage, storeName) {
    const db = initDB();
    let cashierPage = null; // 声明在外层以便在 finally 中清理

    try {
        console.log(`\n[${storeName}] 🤖 接收总控指令，接管浏览器实例突入【财务对账中心】...`);
        
        // 1. 确保当前页面在主页，作为稳定的跳转起点
        await homePage.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await homePage.waitForTimeout(2000);

        // 2. 定位并点击左侧的【对账中心】
        const cashierLink = homePage.locator('a[href*="/cashier/finance/payment-bills"]').first();
        await cashierLink.waitFor({ state: 'visible', timeout: 30000 });
        
        console.log(`🤖 环境安全！正在全自动突入【对账中心】...`);
        
        // 3. 拦截新页面的弹出，并同时触发点击（基座原有的优秀逻辑）
        const [newTab] = await Promise.all([
            homePage.context().waitForEvent('page', { timeout: 60000 }), // 注意：这里改为从 context 捕获新页面
            cashierLink.click({ force: true })
        ]);
        cashierPage = newTab;
        await cashierPage.waitForLoadState('domcontentloaded');
        await cashierPage.bringToFront();
        await cashierPage.waitForTimeout(3000);

        const updateTaskStmt = db.prepare(`
            INSERT OR REPLACE INTO sync_task_log_all (chunk_key, account_type, startStr, endStr, startSec, endSec, status, storeName)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // 外层循环：遍历 货款、营销、保证金 (基座核心逻辑原封不动)
        for (const config of ACCOUNT_CONFIGS) {
            console.log(`\n=================================================================`);
            console.log(`🎯 准备接管并同步【${config.accountName}】数据流...`);
            
            // 注意：这里将原有的 STORE_NAME 替换为了动态传入的 storeName 变量以区分店铺
            const pendingTasks = getPendingTasks(db, config, 2022, storeName);
            if (pendingTasks.length === 0) {
                console.log(`[${config.accountName}] 历史记录已是最新状态，秒跳过！`);
                continue;
            }

            let currentIterPage = 1;
            let currentChunkStart = 0;
            let currentChunkEnd = 0;
            
            const setupRoute = async (pageTarget) => {
                await pageTarget.route(`**/${config.apiUrl}*`, async route => {
                    const request = route.request();
                    if (request.method() === 'POST') {
                        try {
                            const postData = JSON.parse(request.postData() || '{}');
                            postData[config.payloadMap.page] = currentIterPage;
                            postData[config.payloadMap.size] = 100; 
                            postData[config.payloadMap.start] = currentChunkStart;
                            postData[config.payloadMap.end] = currentChunkEnd;
                            await route.continue({ postData: JSON.stringify(postData) });
                        } catch (e) { await route.continue(); }
                    } else { await route.continue(); }
                });
            };

            await setupRoute(cashierPage);

            if (config.tabSelector) {
                console.log(`🖱️ 正在自动切换至【${config.accountName}】面板...`);
                try {
                    await cashierPage.locator(config.tabSelector).last().click({ force: true, timeout: 10000 });
                    await cashierPage.waitForTimeout(2000);
                } catch (e) {
                    console.log(`⚠️ 初始切换 ${config.accountName} 失败！尝试重试...`);
                    continue; 
                }
            }

            let insertStmt;
            if (config.accountName === '货款账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_balance_bill (billId, mallId, orderSn, amount, createdAt, type, classIdDesc, financeIdDesc, note, sourceBizNo, billOutBizDesc, storeName) VALUES (@billId, @mallId, @orderSn, @amount, @createdAt, @type, @classIdDesc, @financeIdDesc, @note, @sourceBizNo, @billOutBizDesc, @storeName)`);
            } else if (config.accountName === '营销账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_marketing_balance_bill (flowId, mallId, orderSn, amount, bizAt, createdAt, note, accountingTypeDesc, billOutBizCode, billOutBizDesc, flowTitle, storeName) VALUES (@flowId, @mallId, @orderSn, @amount, @bizAt, @createdAt, @note, @accountingTypeDesc, @billOutBizCode, @billOutBizDesc, @flowTitle, @storeName)`);
            } else if (config.accountName === '保证金账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_deposit_balance_bill (flowId, mallId, mallAcctType, bizType, flowType, amount, bizAt, accountingTypeDesc, note, createdAt, billOutBizCode, billOutBizDesc, flowTitle, storeName) VALUES (@flowId, @mallId, @mallAcctType, @bizType, @flowType, @amount, @bizAt, @accountingTypeDesc, @note, @createdAt, @billOutBizCode, @billOutBizDesc, @flowTitle, @storeName)`);
            }

            let queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();

            while (pendingTasks.length > 0) {
                const task = pendingTasks.shift();
                console.log(`\n📅 ${config.accountName} 区块: ${task.startStr} 至 ${task.endStr}`);
                
                currentChunkStart = task.startSec;
                currentChunkEnd = task.endSec;
                const todayEndSec = Math.floor(new Date().getTime() / 1000);

                if (task.endSec >= todayEndSec - 86400) {
                    let maxTimeRow;
                    if (config.accountName === '货款账户') maxTimeRow = db.prepare('SELECT MAX(createdAt) as maxTime FROM pdd_balance_bill').get();
                    else if (config.accountName === '营销账户') maxTimeRow = db.prepare('SELECT MAX(bizAt) as maxTime FROM pdd_marketing_balance_bill').get();
                    else if (config.accountName === '保证金账户') maxTimeRow = db.prepare('SELECT MAX(bizAt) as maxTime FROM pdd_deposit_balance_bill').get();
                    
                    if (maxTimeRow && maxTimeRow.maxTime && maxTimeRow.maxTime > currentChunkStart) {
                        const safeStart = maxTimeRow.maxTime - 86400;
                        if (safeStart > currentChunkStart) {
                            currentChunkStart = safeStart;
                            console.log(`[🚀 增量提速] 探明水位线，裁切活跃区间，从 ${formatExactTime(currentChunkStart)} 精准接续！`);
                        }
                    }
                }

                currentIterPage = 1;
                let totalPagesForChunk = 1;
                let taskStatus = 'DONE'; 
                let chunkTotalInserted = 0;

                while (currentIterPage <= totalPagesForChunk) {
                    try {
                        const [apiResponse] = await Promise.all([
                            cashierPage.waitForResponse(res => res.url().includes(config.apiUrl) && res.status() === 200, { timeout: 30000 }),
                            queryBtnLocator.click({ force: true })
                        ]);

                        const resJson = await apiResponse.json();
                        if (!resJson.success) throw new Error(`API明确返回错误: ${resJson.errorMsg}`);

                        const dtoList = resJson.result?.billList || resJson.result?.dataList || resJson.result?.list || [];
                        
                        if (currentIterPage === 1) {
                            const totalRecords = resJson.result?.total || 0;
                            if (totalRecords >= 9500) {
                                if (currentChunkEnd - currentChunkStart <= 1) {
                                    totalPagesForChunk = 100;
                                    taskStatus = 'TRUNCATED';
                                } else {
                                    const midSec = Math.floor((currentChunkStart + currentChunkEnd) / 2);
                                    const key1 = `${storeName}_${config.taskLogPrefix}${currentChunkStart}_${midSec}`;
                                    const key2 = `${storeName}_${config.taskLogPrefix}${midSec + 1}_${currentChunkEnd}`;
                                    updateTaskStmt.run(key1, config.accountName, task.startStr, formatExactTime(midSec), currentChunkStart, midSec, 'PENDING', storeName);
                                    updateTaskStmt.run(key2, config.accountName, formatExactTime(midSec + 1), task.endStr, midSec + 1, currentChunkEnd, 'PENDING', storeName);
                                    db.prepare('DELETE FROM sync_task_log_all WHERE chunk_key = ?').run(task.key);
                                    pendingTasks.push({ key: key1, startStr: task.startStr, endStr: formatExactTime(midSec), startSec: currentChunkStart, endSec: midSec });
                                    pendingTasks.push({ key: key2, startStr: formatExactTime(midSec + 1), endStr: task.endStr, startSec: midSec + 1, endSec: currentChunkEnd });
                                    taskStatus = 'FISSION';
                                    break;
                                }
                            } else {
                                totalPagesForChunk = Math.ceil(totalRecords / 100);
                            }
                            if (totalRecords === 0) break;
                        }
                        if (dtoList.length === 0) break;

                        const actuallyInserted = db.transaction((items) => {
                            let insertedCount = 0;
                            for (const item of items) {
                                try { 
                                    item.storeName = storeName; // 动态写入店铺名
                                    item.classIdDesc = item.classIdDesc || ''; item.financeIdDesc = item.financeIdDesc || '';
                                    item.note = item.note || ''; item.sourceBizNo = item.sourceBizNo || '';
                                    item.billOutBizDesc = item.billOutBizDesc || ''; item.accountingTypeDesc = item.accountingTypeDesc || '';
                                    item.flowTitle = item.flowTitle || ''; item.billOutBizCode = item.billOutBizCode || '';
                                    item.orderSn = item.orderSn || ''; item.mallAcctType = item.mallAcctType || '';
                                    item.bizType = item.bizType || ''; item.flowType = item.flowType || '';

                                    insertedCount += insertStmt.run(item).changes;
                                } catch (e) {}
                            }
                            return insertedCount;
                        })(dtoList);
                        
                        chunkTotalInserted += actuallyInserted;
                        console.log(`[${config.accountName}] 第 ${currentIterPage}/${totalPagesForChunk} 页 | 截获: ${dtoList.length}，新增落盘: ${actuallyInserted}`);
                        
                        await cashierPage.waitForTimeout(Math.floor(Math.random() * 1500) + 1500);
                        currentIterPage++;
                    } catch (err) {
                        if (err.message.includes('1年') || err.message.includes('一年')) {
                            console.error(`\n🚫 [触发平台硬限制]: ${err.message}`);
                            console.log(`🤖 判定：此区块已被官方冷数据墙拦截。直接物理封印并跳过！`);
                            taskStatus = 'EXPIRED'; 
                            break; 
                        } else {
                            console.error(`\n❌ [会话崩溃预警] 检测到异常:`, err.message);
                            taskStatus = 'FAILED';
                            break; 
                        }
                    }
                } 
                
                // 异常自愈重连机制 (基座核心逻辑)
                if (taskStatus === 'FAILED') {
                    console.log(`⚠️ 启动【自愈重连机制】，保护当前进度...`);
                    pendingTasks.unshift(task); 
                    
                    try {
                        if (cashierPage) await cashierPage.close().catch(()=>{});
                        await homePage.bringToFront();
                        console.log(`🔄 正在刷新后台主页，重置全局 Token 活性...`);
                        await homePage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                        await homePage.waitForTimeout(5000);
                        
                        const newCashierLink = homePage.locator('a[href*="/cashier/finance/payment-bills"]').first();
                        await newCashierLink.click();
                        
                        cashierPage = await homePage.context().waitForEvent('page', { timeout: 60000 });
                        await cashierPage.waitForLoadState('domcontentloaded');
                        await cashierPage.bringToFront();
                        await cashierPage.waitForTimeout(3000);
                        
                        await setupRoute(cashierPage);
                        if (config.tabSelector) {
                            console.log(`🖱️ 会话重建完毕，重新切回【${config.accountName}】...`);
                            await cashierPage.locator(config.tabSelector).last().click({ force: true, timeout: 10000 });
                            await cashierPage.waitForTimeout(3000);
                        }
                        queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();
                        console.log(`✅ 自愈成功！重新发起冲锋！\n`);
                    } catch (reconnectErr) {
                        console.error(`🚨 自愈彻底失败，放弃当前账户重试。`);
                        break; 
                    }
                } else if (taskStatus === 'DONE' || taskStatus === 'TRUNCATED' || taskStatus === 'EXPIRED') {
                    let finalStatus = taskStatus;
                    if (taskStatus === 'EXPIRED') {
                        finalStatus = 'DONE';
                    } else if (task.endSec >= Math.floor(new Date().getTime() / 1000) - 86400 && taskStatus !== 'TRUNCATED') {
                        finalStatus = 'PENDING';
                    }
                    
                    updateTaskStmt.run(task.key, config.accountName, task.startStr, task.endStr, task.startSec, task.endSec, finalStatus, storeName);
                    console.log(`✅ 日志戳已更新为: ${finalStatus}。本区新增落盘: ${chunkTotalInserted} 条。`);
                }
            } 
            
            if (cashierPage && !cashierPage.isClosed()) {
                await cashierPage.unroute(`**/${config.apiUrl}*`).catch(()=>{});
            }
        } 

        console.log(`\n🎉🎉🎉 [${storeName}] 所有账户流水同步完毕！财务护城河已建成。`);
    } catch (e) {
        console.error(`[全局致命错误]:`, e);
    } finally {
        if (db) db.close();
        // [极度重要] 作为被调用的子模块，我们关闭自己新开的 Tab 页，但绝不关闭总控传入的 browserContext
        if (cashierPage && !cashierPage.isClosed()) {
            await cashierPage.close().catch(()=>{});
        }
    }
}

// 导出主函数供总控调用，并删除原有的直接执行代码 ( runMultiAccountScraper(); )
module.exports = { runMultiAccountScraper };
