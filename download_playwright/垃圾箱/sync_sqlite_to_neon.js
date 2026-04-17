// sync_sqlite_to_neon.js - 将本地 SQLite 数据单向同步到 Neon PostgreSQL 云端

import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const { Client } = pg;

// --- 基础配置 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 本地 SQLite 数据库路径 (确保路径与你爬虫脚本生成的路径一致)
const SQLITE_DB_PATH = path.join(__dirname, 'sql_data', 'ProductDataCenter.db');
const DB_TABLE_NAME = 'dbs_product_details';
const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
    if (!DATABASE_URL) {
        console.error('❌ 请在 .env 文件中设置 DATABASE_URL');
        process.exit(1);
    }

    console.log(`➡️ 步骤 1: 读取本地 SQLite 数据库...`);
    let sqliteDb;
    let localRecords = [];
    try {
        sqliteDb = new Database(SQLITE_DB_PATH, { fileMustExist: true });
        const stmt = sqliteDb.prepare(`SELECT * FROM ${DB_TABLE_NAME}`);
        localRecords = stmt.all();
        console.log(`   ✅ 成功读取本地数据: 共 ${localRecords.length} 条记录`);
        sqliteDb.close();
    } catch (err) {
        console.error(`❌ 读取本地 SQLite 失败: ${err.message}`);
        console.log(`   请确保你的爬虫已经跑过，并且生成了正确的 .db 文件。`);
        process.exit(1);
    }

    if (localRecords.length === 0) {
        console.log('⚠️ 本地数据库为空，无需同步，退出。');
        return;
    }

    console.log(`\n➡️ 步骤 2: 连接 Neon 云端数据库...`);
    const pgClient = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await pgClient.connect();
        console.log('   ✅ 云端数据库连接成功');

        // 确保云端表存在 (与原 SQLite 表结构保持一致)
        const createSql = `
            CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (
                barcode TEXT PRIMARY KEY,
                product_name TEXT,
                product_model TEXT,
                erp_code TEXT,
                sku_id TEXT,
                net_weight REAL,
                gross_weight REAL,
                dim_prod_l REAL, dim_prod_w REAL, dim_prod_h REAL,
                dim_pkg_l REAL, dim_pkg_w REAL, dim_pkg_h REAL,
                image_url TEXT,
                is_wifi TEXT,
                category_path TEXT,
                unit TEXT,
                consumables_json TEXT,
                market_price TEXT,
                tax_rate TEXT,
                purchase_entity TEXT,
                software_entity TEXT,
                update_time TEXT,
                scrape_time TEXT
            )
        `;
        await pgClient.query(createSql);
        console.log('   ✅ 云端表结构校验完成');

        console.log(`\n➡️ 步骤 3: 开始全量同步至云端...`);
        
        const insertSql = `
            INSERT INTO ${DB_TABLE_NAME} (
                barcode, product_name, product_model, erp_code, sku_id,
                net_weight, gross_weight, 
                dim_prod_l, dim_prod_w, dim_prod_h,
                dim_pkg_l, dim_pkg_w, dim_pkg_h,
                image_url, is_wifi, category_path, unit,
                consumables_json, 
                market_price, tax_rate, purchase_entity, software_entity,
                update_time, scrape_time
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                $21, $22, $23, $24
            )
            ON CONFLICT (barcode) DO UPDATE SET
                product_name = EXCLUDED.product_name,
                product_model = EXCLUDED.product_model,
                erp_code = EXCLUDED.erp_code,
                sku_id = EXCLUDED.sku_id,
                net_weight = EXCLUDED.net_weight,
                gross_weight = EXCLUDED.gross_weight,
                dim_prod_l = EXCLUDED.dim_prod_l, dim_prod_w = EXCLUDED.dim_prod_w, dim_prod_h = EXCLUDED.dim_prod_h,
                dim_pkg_l = EXCLUDED.dim_pkg_l, dim_pkg_w = EXCLUDED.dim_pkg_w, dim_pkg_h = EXCLUDED.dim_pkg_h,
                image_url = EXCLUDED.image_url,
                is_wifi = EXCLUDED.is_wifi,
                category_path = EXCLUDED.category_path,
                unit = EXCLUDED.unit,
                consumables_json = EXCLUDED.consumables_json,
                market_price = EXCLUDED.market_price,
                tax_rate = EXCLUDED.tax_rate,
                purchase_entity = EXCLUDED.purchase_entity,
                software_entity = EXCLUDED.software_entity,
                update_time = EXCLUDED.update_time,
                scrape_time = EXCLUDED.scrape_time
        `;

        let successCount = 0;
        let failCount = 0;

        // 遍历本地数据，逐条 Upsert 到云端
        for (const row of localRecords) {
            const values = [
                row.barcode, row.product_name, row.product_model, row.erp_code, row.sku_id,
                row.net_weight, row.gross_weight,
                row.dim_prod_l, row.dim_prod_w, row.dim_prod_h,
                row.dim_pkg_l, row.dim_pkg_w, row.dim_pkg_h,
                row.image_url, row.is_wifi, row.category_path, row.unit,
                row.consumables_json,
                row.market_price, row.tax_rate, row.purchase_entity, row.software_entity,
                row.update_time, row.scrape_time
            ];

            try {
                await pgClient.query(insertSql, values);
                successCount++;
                // 每同步 10 条打印一次进度，避免刷屏
                if (successCount % 10 === 0) process.stdout.write('.'); 
            } catch (err) {
                failCount++;
                console.error(`\n   ❌ 69码 [${row.barcode}] 同步失败: ${err.message}`);
            }
        }

        console.log(`\n\n🎉 同步完成! 成功: ${successCount} 条, 失败: ${failCount} 条。`);

    } catch (e) {
        console.error('❌ 云端操作异常:', e);
    } finally {
        await pgClient.end();
    }
}

main();