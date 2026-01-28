// 05-Debug_Missing_Dates.cjs - 诊断日期查漏逻辑
const Database = require('better-sqlite3');
const path = require('path');

// 数据库路径
const DB_PATH = path.join(__dirname, 'sql_data', 'TmallDataCenter.db');
const TABLE_NAME = 'pddorder';
const CHECK_DAYS = 5; // 仅检查最近5天，方便查看

function formatDate(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${m}-${d}`;
}

console.log(`\n🔍 --- 数据库日期诊断 ---`);
console.log(`数据库路径: ${DB_PATH}`);

try {
    const db = new Database(DB_PATH, { readonly: true });
    
    // 1. 打印所有存在的日期
    console.log(`\n[1] 正在查询数据库中最近的所有支付日期...`);
    const rows = db.prepare(`SELECT DISTINCT "支付日期", count(*) as count FROM "${TABLE_NAME}" GROUP BY "支付日期" ORDER BY "支付日期" DESC LIMIT 10`).all();
    
    if (rows.length === 0) {
        console.log("   ❌ 数据库为空，或没有 '支付日期' 数据。");
    } else {
        console.table(rows);
    }

    // 2. 模拟脚本的查漏逻辑
    console.log(`\n[2] 模拟最近 ${CHECK_DAYS} 天的查漏结果:`);
    const today = new Date();
    
    for (let i = 1; i <= CHECK_DAYS; i++) {
        const d = new Date(); 
        d.setDate(today.getDate() - i);
        const dateStr = formatDate(d);
        
        // 脚本原本的判断逻辑
        const exists = rows.some(r => r['支付日期'] === dateStr);
        
        if (exists) {
            const count = rows.find(r => r['支付日期'] === dateStr).count;
            console.log(`   📅 ${dateStr}: ❌ [判定为已存在] (库内已有 ${count} 条记录) -> 脚本跳过`);
        } else {
            console.log(`   📅 ${dateStr}: ✅ [判定为缺失] -> 脚本会下载`);
        }
    }

    db.close();

} catch (e) {
    console.error(`❌ 错误: ${e.message}`);
}