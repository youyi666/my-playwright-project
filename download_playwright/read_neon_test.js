// read_neon_test.js - 验证云端 Neon 数据库的连通性与数据完整性

import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const DB_TABLE_NAME = 'dbs_product_details';

async function main() {
    if (!DATABASE_URL) {
        console.error('❌ 请在 .env 文件中设置 DATABASE_URL');
        process.exit(1);
    }

    console.log('➡️ 正在连接 Neon 云端数据库进行读取测试...');
    
    // 初始化 PostgreSQL 客户端，增加高延迟容忍配置
    const pgClient = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000, // 增加连接超时时间到 15 秒
        queryTimeout: 20000            // 增加查询超时时间到 20 秒
    });

    try {
        await pgClient.connect();
        console.log('   ✅ 云端数据库连接成功！\n');

        // 查询语句：只取前 5 条记录，验证核心字段
        const querySql = `
            SELECT barcode, product_name, erp_code, market_price, consumables_json 
            FROM ${DB_TABLE_NAME} 
            LIMIT 5
        `;
        
        console.log('➡️ 正在拉取前 5 条数据样本...');
        const result = await pgClient.query(querySql);

        if (result.rows.length === 0) {
            console.log('⚠️ 云端数据库目前为空，请确认之前的同步脚本是否真正执行成功。');
            return;
        }

        // 清洗一下打印的数据格式，方便在终端查看
        const tableData = result.rows.map(row => {
            let consumablesCount = 0;
            try {
                // 尝试解析耗材 JSON
                if (row.consumables_json) {
                    const consumables = JSON.parse(row.consumables_json);
                    consumablesCount = Array.isArray(consumables) ? consumables.length : 0;
                }
            } catch (e) {
                consumablesCount = '解析错误';
            }

            return {
                '69码': row.barcode,
                '产品名称': row.product_name && row.product_name.length > 15 
                            ? row.product_name.substring(0, 15) + '...' // 名字太长截断一下
                            : row.product_name,
                'ERP编码': row.erp_code,
                '建议零售价': row.market_price || '空',
                '包含耗材数量': consumablesCount
            };
        });

        // 使用 Node.js 内置的 console.table 打印漂亮的表格
        console.table(tableData);

        // 单独把第一条记录的耗材明细打印出来，验证复杂结构
        if (result.rows[0] && result.rows[0].consumables_json) {
            console.log('\n➡️ 抽取第一条记录的详细耗材 JSON 数据验证:');
            console.log(result.rows[0].consumables_json);
        }

    } catch (err) {
        console.error('\n❌ 读取测试失败，报错信息如下:', err.message);
    } finally {
        // 务必养成执行完数据库操作后关闭连接的好习惯
        await pgClient.end();
        console.log('\n--- 测试结束，数据库连接已断开 ---');
    }
}

main();