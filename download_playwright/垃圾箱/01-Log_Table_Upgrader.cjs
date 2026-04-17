// 01-Log_Table_Upgrader.cjs - 日志表结构与历史数据无损升级脚本
const Database = require('better-sqlite3');

// 你的统一数据库绝对路径
const DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';
const TARGET_STORE = '云米拼多多官方旗舰店';

const db = new Database(DB_PATH);

console.log(`🚀 开始对数据库日志表进行多店隔离升级...`);

try {
    db.transaction(() => {
        // 1. 给多账户流水日志表升级
        try {
            db.exec(`ALTER TABLE sync_task_log_all ADD COLUMN storeName TEXT;`);
            console.log(` ✅ sync_task_log_all 表已成功新增 storeName 字段。`);
        } catch (e) {
            console.log(` ℹ️ sync_task_log_all 表已包含 storeName，无需重复添加。`);
        }
        
        // 更新旧数据归属，并在唯一主键前拼上店铺名防止冲突
        db.exec(`UPDATE sync_task_log_all SET storeName = '${TARGET_STORE}' WHERE storeName IS NULL;`);
        db.exec(`UPDATE sync_task_log_all SET chunk_key = '${TARGET_STORE}_' || chunk_key WHERE chunk_key NOT LIKE '${TARGET_STORE}_%';`);

        // 2. 给营销结算日志表升级
        try {
            db.exec(`ALTER TABLE sync_task_log ADD COLUMN storeName TEXT;`);
            console.log(` ✅ sync_task_log 表已成功新增 storeName 字段。`);
        } catch (e) {
            console.log(` ℹ️ sync_task_log 表已包含 storeName，无需重复添加。`);
        }

        // 更新旧数据归属
        db.exec(`UPDATE sync_task_log SET storeName = '${TARGET_STORE}' WHERE storeName IS NULL;`);
        db.exec(`UPDATE sync_task_log SET chunk_key = '${TARGET_STORE}_' || chunk_key WHERE chunk_key NOT LIKE '${TARGET_STORE}_%';`);

    })();
    console.log(`\n🎉 升级圆满完成！日志表已具备多店隔离能力。`);
} catch (e) {
    console.error(`\n❌ 升级过程出错:`, e.message);
} finally {
    db.close();
}