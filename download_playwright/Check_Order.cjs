// Check_Order.cjs - 数据库单号查询工具
const Database = require('better-sqlite3');
const path = require('path');

// 数据库路径 (根据你的V25脚本配置)
const dbPath = path.join(__dirname, 'sql_data', 'TmallDataCenter.db');
const db = new Database(dbPath, { readonly: true });

// 🔴 请在这里填入你要查询的订单号 🔴
const targetOrderId = '260126-626975075902052'; 

try {
    const row = db.prepare(`SELECT * FROM "pddorder" WHERE "订单号" = ?`).get(targetOrderId);
    
    if (row) {
        console.log(`\n✅ 找到了！该订单已存在于数据库中：`);
        console.log(`----------------------------------------`);
        console.log(`订单号: ${row['订单号']}`);
        console.log(`支付时间: ${row['支付时间']}`);
        console.log(`支付日期: ${row['支付日期']}`);
        console.log(`商品标题: ${row['商品标题']}`);
        console.log(`----------------------------------------`);
        console.log(`结论：这就是为什么新增为 0，因为它早就已经在库里了。`);
    } else {
        console.log(`\n❌ 数据库里没找到订单号 [${targetOrderId}]`);
        console.log(`结论：如果表格里有这个单，那可能是因为这一行没有“支付时间”被脚本过滤掉了。请检查 Excel。`);
    }
} catch (e) {
    console.error('查询出错:', e.message);
} finally {
    db.close();
}