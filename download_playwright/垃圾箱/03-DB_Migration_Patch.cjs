// 03-DB_Migration_Patch.cjs - 数据库历史数据清洗与升级补丁 (视图避让与自动修复版)-一次性的补丁文件

const Database = require('better-sqlite3');
const path = require('path');

const CENTRAL_DB_PATH = path.join(__dirname, '..', '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');
const OLD_STORE_NAME = '云米拼多多官方旗舰店';

console.log(`🚀 开始执行历史数据平滑升级补丁...`);
const db = new Database(CENTRAL_DB_PATH);

try {
    db.pragma('legacy_alter_table = ON'); 
    
    db.transaction(() => {
        console.log(`\n📦 正在修复 [pddorder] 订单表...`);
        try { db.exec(`ALTER TABLE "pddorder" ADD COLUMN "店铺名称" TEXT`); } catch(e) {}
        const orderUpdate = db.prepare(`UPDATE "pddorder" SET "店铺名称" = ? WHERE "店铺名称" IS NULL`).run(OLD_STORE_NAME);
        console.log(` ✅ 成功将 ${orderUpdate.changes} 条无归属【订单】划归给【${OLD_STORE_NAME}】`);

        console.log(`\n🛡️ 正在检查是否存在冲突视图...`);
        const viewQuery = db.prepare(`SELECT sql FROM sqlite_master WHERE type='view' AND name='v_inventory_sales_overview'`).get();
        let originalViewSql = null;
        
        if (viewQuery && viewQuery.sql) {
            originalViewSql = viewQuery.sql;
            console.log(` ⚠️ 发现旧视图，暂时卸载以避开 SQLite 语法审查...`);
            db.exec(`DROP VIEW "v_inventory_sales_overview"`);
        }

        console.log(`\n📈 正在修复 [pdd_product_promotion] 推广表，并重构主键索引...`);
        try { db.exec(`ALTER TABLE "pdd_product_promotion" ADD COLUMN "店铺名称" TEXT`); } catch(e) {}
        const promoUpdate = db.prepare(`UPDATE "pdd_product_promotion" SET "店铺名称" = ? WHERE "店铺名称" IS NULL`).run(OLD_STORE_NAME);
        console.log(` ✅ 成功将 ${promoUpdate.changes} 条无归属【推广】划归给【${OLD_STORE_NAME}】`);

        console.log(` ⚙️ 正在执行底层架构重建 (无损数据迁移)...`);
        const cols = db.prepare(`PRAGMA table_info("pdd_product_promotion")`).all();
        const colDefs = cols.map(c => `"${c.name}" ${c.type}`).join(', ');
        const colNames = cols.map(c => `"${c.name}"`).join(', ');

        db.exec(`
            CREATE TABLE "pdd_product_promotion_new" (
                ${colDefs},
                PRIMARY KEY ("统计日期", "商品ID", "店铺名称")
            )
        `);

        db.exec(`INSERT INTO "pdd_product_promotion_new" (${colNames}) SELECT ${colNames} FROM "pdd_product_promotion"`);
        db.exec(`DROP TABLE "pdd_product_promotion"`);
        db.exec(`ALTER TABLE "pdd_product_promotion_new" RENAME TO "pdd_product_promotion"`);
        console.log(` ✅ 推广表主键防冲突升级完成！`);

        if (originalViewSql) {
            console.log(`\n🛠️ 正在修复并重新安装视图 [v_inventory_sales_overview]...`);
            try {
                db.exec(originalViewSql);
            } catch (viewErr) {
                if (viewErr.message.includes('single-quotes')) {
                    // 核心修复：自动将双引号替换为单引号
                    const fixedSql = originalViewSql.replace(/"商品名称"/g, "'商品名称'");
                    db.exec(fixedSql);
                    console.log(` ✅ 已自动修复引号语法，视图重新安装成功！`);
                } else {
                    throw viewErr; 
                }
            }
        }
    })();
    
    console.log(`\n🎉 数据库清洗与升级圆满完成！`);

} catch (error) {
    console.error(`\n❌ 数据库升级失败:`, error.message);
} finally {
    db.close();
}