// migrate_all_data.js - [数据+日志全量迁移脚本]

const Database = require('better-sqlite3');
const path = require('path');

// ======================= [路径配置区] =======================
const TEMP_DB_PATH = path.join(__dirname, 'test_pdd_expense.db');
const MAIN_DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';
// ==========================================================

function migrateAll() {
    console.log(`[同步系统] 正在连接主数据库...`);
    let mainDb;
    
    try {
        mainDb = new Database(MAIN_DB_PATH);
        
        // 1. 确保主库中存在【数据表】和【日志表】
        mainDb.exec(`
            CREATE TABLE IF NOT EXISTS pdd_marketing_expense (
                outSn TEXT PRIMARY KEY, bizType INTEGER, cate2 TEXT, settleId INTEGER, 
                billType INTEGER, goodsId INTEGER, goodsName TEXT, goodsAmount INTEGER, 
                costPrice INTEGER, subsidyAmount INTEGER, expenseBatchSn TEXT, 
                payType INTEGER, payTime INTEGER, note TEXT, storeName TEXT, 
                insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sync_task_log (
                chunk_key TEXT PRIMARY KEY, startStr TEXT, endStr TEXT,
                startSec INTEGER, endSec INTEGER, status TEXT,
                updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. 挂载临时库
        mainDb.exec(`ATTACH DATABASE '${TEMP_DB_PATH}' AS temp_db`);

        // 3. 执行迁移
        console.log(`[同步系统] 正在合并数据与任务日志...`);
        
        mainDb.transaction(() => {
            // 迁移订单数据 (INSERT OR IGNORE: 已有的订单不重复覆盖)
            const dataRes = mainDb.prepare(`
                INSERT OR IGNORE INTO main.pdd_marketing_expense 
                SELECT * FROM temp_db.pdd_marketing_expense
            `).run();

            // 迁移任务日志 (INSERT OR REPLACE: 以最新的爬取状态为准)
            const logRes = mainDb.prepare(`
                INSERT OR REPLACE INTO main.sync_task_log 
                SELECT * FROM temp_db.sync_task_log
            `).run();

            console.log(`-----------------------------------------`);
            console.log(`✅ 订单数据迁移完成，新增: ${dataRes.changes} 条`);
            console.log(`✅ 任务日志迁移完成，更新: ${logRes.changes} 条`);
            console.log(`-----------------------------------------`);
        })();

        // 4. 卸载
        mainDb.exec(`DETACH DATABASE temp_db`);
        console.log(`[同步系统] 搬运成功！主数据库已完全继承所有进度。`);

    } catch (e) {
        console.error(`[同步系统] ❌ 失败:`, e.message);
    } finally {
        if (mainDb) mainDb.close();
    }
}

migrateAll();