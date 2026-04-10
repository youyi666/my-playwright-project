// 03-DB_Migration_Patch.cjs - 数据库历史数据清洗与升级补丁

const Database = require('better-sqlite3');
const path = require('path');

// 1. 确保路径指向你的真实数据库位置
const CENTRAL_DB_PATH = path.join(__dirname, '..', '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');

// 2. 划归老数据的归属店铺（请确保这里的名字和你在 STORE_CONFIGS 里配置的老店名字【一字不差】）
// 如果你的主脚本里叫 '云米电器官方旗舰店'，这里请对应修改。
const OLD_STORE_NAME = '云米拼多多官方旗舰店';

console.log(`🚀 开始执行历史数据平滑升级补丁...`);
const db = new Database(CENTRAL_DB_PATH);

try {
    // 开启事务，确保哪怕中途报错，数据也不会损坏（要么全成功，要么全回滚）
    db.transaction(() => {
        
        // ==========================================
        // 模块一：修复订单表 (pddorder)
        // ==========================================
        console.log(`\n📦 正在修复 [pddorder] 订单表...`);
        // 尝试添加字段（如果新脚本还没来得及加的话）
        try { db.exec(`ALTER TABLE "pddorder" ADD COLUMN "店铺名称" TEXT`); } catch(e) {}
        
        // 给历史空数据打上店铺标签
        const orderUpdate = db.prepare(`UPDATE "pddorder" SET "店铺名称" = ? WHERE "店铺名称" IS NULL`).run(OLD_STORE_NAME);
        console.log(` ✅ 成功将 ${orderUpdate.changes} 条无归属的【订单】数据，划归给【${OLD_STORE_NAME}】`);

        // ==========================================
        // 模块二：修复推广表 (pdd_product_promotion) 并升级主键
        // ==========================================
        console.log(`\n📈 正在修复 [pdd_product_promotion] 推广表，并重构主键索引...`);
        try { db.exec(`ALTER TABLE "pdd_product_promotion" ADD COLUMN "店铺名称" TEXT`); } catch(e) {}
        
        // 给历史空数据打上店铺标签
        const promoUpdate = db.prepare(`UPDATE "pdd_product_promotion" SET "店铺名称" = ? WHERE "店铺名称" IS NULL`).run(OLD_STORE_NAME);
        console.log(` ✅ 成功将 ${promoUpdate.changes} 条无归属的【推广】数据，划归给【${OLD_STORE_NAME}】`);

        // 【核心操作：SQLite 重构表结构以更新联合主键】
        console.log(` ⚙️ 正在执行底层架构重建 (无损数据迁移)...`);
        
        // 1. 抓取原表的所有列结构
        const cols = db.prepare(`PRAGMA table_info("pdd_product_promotion")`).all();
        const colDefs = cols.map(c => `"${c.name}" ${c.type}`).join(', ');
        const colNames = cols.map(c => `"${c.name}"`).join(', ');

        // 2. 创建一张带有全新三联合主键的临时表
        db.exec(`
            CREATE TABLE "pdd_product_promotion_new" (
                ${colDefs},
                PRIMARY KEY ("统计日期", "商品ID", "店铺名称")
            )
        `);

        // 3. 将老数据完美灌入新表
        db.exec(`INSERT INTO "pdd_product_promotion_new" (${colNames}) SELECT ${colNames} FROM "pdd_product_promotion"`);

        // 4. 删除旧壳，新表上位
        db.exec(`DROP TABLE "pdd_product_promotion"`);
        db.exec(`ALTER TABLE "pdd_product_promotion_new" RENAME TO "pdd_product_promotion"`);
        
        console.log(` ✅ 推广表主键防冲突升级完成！`);
    })();
    
    console.log(`\n🎉 数据库清洗与升级圆满完成！`);
    console.log(`-> 现在你可以安心运行主脚本了，它会自动识别历史数据，不再盲目执行 90 天下载。`);

} catch (error) {
    console.error(`\n❌ 数据库升级失败:`, error.message);
} finally {
    db.close();
}