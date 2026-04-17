// 00-DB_Data_Cleaner.cjs - 数据库底层 storeName 字段无损清洗工具

const Database = require('better-sqlite3');

// 你的统一数据库绝对路径
const DB_PATH = 'D:/WorkSpace/00_Shared_Database数据库/TmallDataCenter.db';
const OLD_STORE_NAME = '测试店铺_01';
const NEW_STORE_NAME = '云米拼多多官方旗舰店';

const db = new Database(DB_PATH);

// 后面两个基座脚本（多账户财务、营销结算）涉及的 4 张数据核心表
const targetTables = [
    'pdd_balance_bill',
    'pdd_marketing_balance_bill',
    'pdd_deposit_balance_bill',
    'pdd_marketing_expense'
];

console.log(`\n🚀 开始清洗数据库，将 [${OLD_STORE_NAME}] 整体迁移至 [${NEW_STORE_NAME}]...`);

// 开启事务，保障数据安全性
const runClean = db.transaction(() => {
    let totalUpdated = 0;
    
    for (const table of targetTables) {
        try {
            // 严谨校验：检查当前表是否已经在数据库中创建
            const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
            
            if (tableExists) {
                // 执行精准修改
                const stmt = db.prepare(`UPDATE ${table} SET storeName = ? WHERE storeName = ?`);
                const info = stmt.run(NEW_STORE_NAME, OLD_STORE_NAME);
                console.log(` ✅ 表 [${table}] 极速更新完成: 成功修正 ${info.changes} 条明细。`);
                totalUpdated += info.changes;
            } else {
                console.log(` ⚠️ 表 [${table}] 尚未生成数据，自动跳过。`);
            }
        } catch (e) {
            console.error(` ❌ 表 [${table}] 操作异常: ${e.message}`);
        }
    }
    return totalUpdated;
});

try {
    const grandTotal = runClean();
    console.log(`\n🎉 数据清洗完毕！全库共计修正了 ${grandTotal} 条底层记录，完美衔接生产环境。`);
} catch (e) {
    console.error(`\n❌ 清洗任务崩溃:`, e);
} finally {
    db.close();
}