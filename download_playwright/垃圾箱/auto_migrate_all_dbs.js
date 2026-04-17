// auto_migrate_incremental.js - 终极重火力增量版: SQLite 到 PostgreSQL 动态迁移引擎 (修复死锁版 + 强类型清洗)
//
// 核心能力：
// 1. [继承] 自动扫描目录，动态读取 SQLite 表结构，动态建表
// 2. [继承] 拦截主键为空的脏数据，全局网络断开防爆盾
// 3. [继承] 真正的批量插入 (Bulk Insert / Batch Upsert)，矩阵级参数化构造
// 4. [继承] 引入高水位线“同步账本” (_neon_sync_ledger)，零入侵实现极速增量秒传
// 5. [继承] 抛弃 iterate 游标，改用 LIMIT 分块读取，彻底解决 SQLite connection busy 报错
// 6. [强类型清洗] 动态嗅探并清洗混入数字列的非法文本(如 "Error")，自动转化为 NULL，适配 PG 强类型校验

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const { Client } = pg;

// --- 基础配置 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SQL_DATA_DIR = path.join(__dirname, 'sql_data');
const DATABASE_URL = process.env.DATABASE_URL;
// 批量池大小：500条一发。考虑到 Postgres 单次最大参数量为 65535，表字段如果为50，500*50=25000，绝对安全。
const BATCH_SIZE = 500; 

// SQLite 类型到 PostgreSQL 类型的映射字典
function mapSqliteTypeToPg(sqliteType) {
    const type = (sqliteType || 'TEXT').toUpperCase();
    if (type.includes('INT')) return 'BIGINT';
    if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
    if (type.includes('BLOB')) return 'BYTEA';
    if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'DOUBLE PRECISION';
    if (type.includes('DEC') || type.includes('NUM')) return 'NUMERIC';
    if (type.includes('BOOL')) return 'BOOLEAN';
    if (type.includes('DATE') || type.includes('TIME')) return 'TIMESTAMP';
    return 'TEXT';
}

// 核心重火力函数：执行大批量 Upsert
async function executeBulkInsert(pgClient, tableName, columns, pkColumns, batchData) {
    if (batchData.length === 0) return;

    const colNames = columns.map(c => `"${c.name}"`).join(', ');
    const colCount = columns.length;
    
    let valueStrings = [];
    let flatValues = [];
    let paramIndex = 1; // PostgreSQL 参数占位符从 $1 开始

    // 1. 动态构造二维参数矩阵 ($1, $2), ($3, $4)...
    for (const row of batchData) {
        let rowParams = [];
        for (let j = 0; j < colCount; j++) {
            rowParams.push(`$${paramIndex++}`);
            
            let val = row[columns[j].name];
            let pgType = columns[j].type;

            // [强类型清洗装甲]
            if (pgType === 'DOUBLE PRECISION' || pgType === 'NUMERIC' || pgType === 'BIGINT') {
                if (typeof val === 'string') {
                    // 如果不是纯数字（例如混入了 "Error", "暂无数据" 等文本），或者是空字符串
                    if (isNaN(Number(val)) || val.trim() === '') {
                        val = null; // 强制洗白为 NULL，防止 Postgres 报错崩溃
                    }
                }
            }

            flatValues.push(val); // 拍平数据数组
        }
        valueStrings.push(`(${rowParams.join(', ')})`);
    }

    // 2. 组装终极 SQL 语句
    let sql = `INSERT INTO "${tableName}" (${colNames}) VALUES ${valueStrings.join(', ')}`;

    // 3. 附加冲突更新逻辑 (Upsert)
    if (pkColumns.length > 0) {
        const updateSets = columns
            .filter(c => !pkColumns.includes(c.name))
            .map(c => `"${c.name}" = EXCLUDED."${c.name}"`)
            .join(', ');
        
        if (updateSets.length > 0) {
            sql += ` ON CONFLICT ("${pkColumns.join('", "')}") DO UPDATE SET ${updateSets}`;
        } else {
            sql += ` ON CONFLICT ("${pkColumns.join('", "')}") DO NOTHING`;
        }
    }

    // 4. 一次性发射到云端
    await pgClient.query(sql, flatValues);
}

async function main() {
    if (!DATABASE_URL) {
        console.error('❌ 请在 .env 文件中设置 DATABASE_URL');
        process.exit(1);
    }

    const dbFiles = fs.readdirSync(SQL_DATA_DIR).filter(f => f.endsWith('.db'));
    if (dbFiles.length === 0) return;

    console.log(`➡️ 发现 ${dbFiles.length} 个数据库文件，准备执行增量高水位迁移...`);

    const pgClient = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 20000,
        queryTimeout: 60000, // 批量写入处理时间长，增加查询超时容忍到 60 秒
        keepAlive: true 
    });

    pgClient.on('error', err => {
        console.error('\n❌ [网络波动预警] 云端数据库底层连接意外断开:', err.message);
    });

    try {
        await pgClient.connect();
        console.log('   ✅ Neon 云端数据库连接成功！\n');

        for (const file of dbFiles) {
            const dbPath = path.join(SQL_DATA_DIR, file);
            console.log(`================================================`);
            console.log(`📂 开始处理: [${file}]`);
            
            let sqliteDb;
            try {
                sqliteDb = new Database(dbPath, { fileMustExist: true });
            } catch (err) { continue; }

            // [增量升级] 1. 初始化本地同步账本表
            sqliteDb.exec(`
                CREATE TABLE IF NOT EXISTS _neon_sync_ledger (
                    table_name TEXT PRIMARY KEY,
                    last_rowid INTEGER DEFAULT 0
                )
            `);

            // 获取除了账本表以外的所有用户表
            const tables = sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_neon_sync_ledger'`).all();
            
            for (const tableObj of tables) {
                const tableName = tableObj.name;
                console.log(`\n   📄 装载表: [${tableName}]`);

                const tableInfo = sqliteDb.prepare(`PRAGMA table_info("${tableName}")`).all();
                if (tableInfo.length === 0) continue;

                const columns = [];
                const pkColumns = [];
                for (const col of tableInfo) {
                    columns.push({ name: col.name, type: mapSqliteTypeToPg(col.type) });
                    if (col.pk > 0) pkColumns.push(col.name);
                }

                // 动态建表
                const createColsStr = columns.map(c => `"${c.name}" ${c.type}`).join(', ');
                let createTableSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${createColsStr}`;
                if (pkColumns.length > 0) createTableSql += `, PRIMARY KEY ("${pkColumns.join('", "')}")`;
                createTableSql += `);`;

                try {
                    await pgClient.query(createTableSql);
                } catch (err) {
                    console.error(`      ❌ 建表失败: ${err.message}`);
                    continue; 
                }

                // [增量升级] 2. 读取当前表的高水位线 (上次同步到的最后一行)
                const ledgerRow = sqliteDb.prepare(`SELECT last_rowid FROM _neon_sync_ledger WHERE table_name = ?`).get(tableName);
                const lastRowid = ledgerRow ? ledgerRow.last_rowid : 0;
                
                if (lastRowid > 0) {
                    console.log(`      📍 发现断点账本，上次同步至 rowid: ${lastRowid}，启动增量截断模式。`);
                }

                // [死锁修复] 测试表是否支持 rowid
                let supportsRowid = true;
                try {
                    sqliteDb.prepare(`SELECT rowid FROM "${tableName}" LIMIT 1`).get();
                } catch (e) {
                    supportsRowid = false;
                    console.error(`      ⚠️ 表 [${tableName}] 不支持隐式 rowid，将执行全量覆盖同步 (不使用账本)。`);
                }

                let totalSuccess = 0;
                let totalFail = 0;
                let filterCount = 0;

                if (supportsRowid) {
                    // --- 真正的分块读取模式 (Chunking)，完美避开 SQLite 死锁 ---
                    let currentLastRowid = lastRowid;
                    
                    while (true) {
                        // 一次性拉取 500 条数据进入内存，执行完这句后，SQLite 读取锁释放
                        const batchData = sqliteDb.prepare(`SELECT rowid AS _sync_rowid, * FROM "${tableName}" WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`).all(currentLastRowid, BATCH_SIZE);
                        
                        if (batchData.length === 0) break; // 数据已全部拉完，退出循环

                        const validBatch = [];
                        
                        for (const row of batchData) {
                            // 脏数据拦截
                            let hasNullPk = false;
                            for (const pk of pkColumns) {
                                if (row[pk] === null || row[pk] === undefined || row[pk] === '') {
                                    hasNullPk = true; break;
                                }
                            }
                            if (hasNullPk) {
                                filterCount++;
                            } else {
                                validBatch.push(row);
                            }
                        }

                        // 记录这批数据中最大的 rowid
                        currentLastRowid = batchData[batchData.length - 1]._sync_rowid;

                        if (validBatch.length > 0) {
                            try {
                                await executeBulkInsert(pgClient, tableName, columns, pkColumns, validBatch);
                                totalSuccess += validBatch.length;
                                
                                // 写入成功后，更新本地账本。此时没有读取锁，绝对不会报错
                                sqliteDb.prepare(`INSERT OR REPLACE INTO _neon_sync_ledger (table_name, last_rowid) VALUES (?, ?)`).run(tableName, currentLastRowid);
                                process.stdout.write('🚀'); 
                            } catch (err) {
                                totalFail += validBatch.length;
                                console.error(`\n      ⚠️ 批次写入云端报错: ${err.message}`);
                                console.error(`      🛑 停止当前表的同步任务，下次运行将从 rowid ${currentLastRowid} 之前重试。`);
                                break; // 云端写入失败，直接跳出该表的同步，保护账本不被错误更新
                            }
                        } else {
                            // 虽然这批全是脏数据被过滤了，但进度依然要往前推
                            sqliteDb.prepare(`INSERT OR REPLACE INTO _neon_sync_ledger (table_name, last_rowid) VALUES (?, ?)`).run(tableName, currentLastRowid);
                        }
                    }

                } else {
                    // 降级模式：如果表没有 rowid，只能使用全量读取（很少见的情况）
                    const allData = sqliteDb.prepare(`SELECT * FROM "${tableName}"`).all();
                    const validBatch = [];
                    for (const row of allData) {
                        let hasNullPk = false;
                        for (const pk of pkColumns) {
                            if (row[pk] === null || row[pk] === undefined || row[pk] === '') {
                                hasNullPk = true; break;
                            }
                        }
                        if (hasNullPk) filterCount++;
                        else validBatch.push(row);
                    }
                    
                    // 将大数组切分成小批次发送
                    for (let i = 0; i < validBatch.length; i += BATCH_SIZE) {
                        const chunk = validBatch.slice(i, i + BATCH_SIZE);
                        try {
                            await executeBulkInsert(pgClient, tableName, columns, pkColumns, chunk);
                            totalSuccess += chunk.length;
                            process.stdout.write('🚀');
                        } catch (err) {
                            totalFail += chunk.length;
                            console.error(`\n      ⚠️ 批次写入报错: ${err.message}`);
                        }
                    }
                }

                if (totalSuccess === 0 && totalFail === 0 && filterCount === 0) {
                    console.log(`      💤 无新增数据，跳过同步。`);
                } else {
                    console.log(`\n      🏁 增量迁移完毕。新增同步: ${totalSuccess} 条, 失败: ${totalFail} 条, 过滤脏数据: ${filterCount} 条`);
                }
            }

            sqliteDb.close();
            console.log(`✅ 数据库 [${file}] 处理完成。`);
        }

    } catch (e) {
        console.error('\n❌ 全局执行异常:', e);
    } finally {
        await pgClient.end();
        console.log('\n--- 战役结束，所有增量数据已对接 ---');
    }
}

main();