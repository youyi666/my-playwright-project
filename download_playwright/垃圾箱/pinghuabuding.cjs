// upgrade_log.js - [进度日志平滑升级补丁]
// 环境条件: Node.js 16+ 且已安装 better-sqlite3 依赖
// 功能: 将旧版单账户的任务日志，平滑迁移到 V18 版的多账户统一任务日志表，避免重复抓取

const Database = require('better-sqlite3');
const MAIN_DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';

function upgradeTaskLogs() {
    console.log(`[升级系统] 正在连接主数据库...`);
    let db;
    try {
        db = new Database(MAIN_DB_PATH);
        
        // 确保新表存在 (基座代码的平滑保障)
        db.exec(`
            CREATE TABLE IF NOT EXISTS sync_task_log_all (
                chunk_key TEXT PRIMARY KEY, account_type TEXT, startStr TEXT, endStr TEXT,
                startSec INTEGER, endSec INTEGER, status TEXT, updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 执行底层迁移逻辑：将旧版的进度连同 '货款账户' 的标签，一起转移到新表，并给 chunk_key 加上 'BAL_' 前缀
        console.log(`[升级系统] 正在将旧版进度迁移至新一代调度中枢...`);
        const info = db.prepare(`
            INSERT OR IGNORE INTO sync_task_log_all (chunk_key, account_type, startStr, endStr, startSec, endSec, status)
            SELECT 'BAL_' || chunk_key, '货款账户', startStr, endStr, startSec, endSec, status
            FROM sync_task_log_balance
        `).run();

        console.log(`\n🎉🎉🎉 [升级系统] 进度继承圆满成功！`);
        console.log(`📊 共计完美转移了 ${info.changes} 个历史时间区块的记忆。`);
        console.log(`💡 你现在可以安全且极速地运行 V18 终极基座脚本了！`);

    } catch (e) {
        console.error(`❌ 升级时发生异常:`, e.message);
    } finally {
        if (db) db.close();
    }
}

upgradeTaskLogs();