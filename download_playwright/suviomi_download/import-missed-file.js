// import-missed-file.js
// 这是一个独立的脚本，专门用于将单个被遗漏的Excel文件手动导入到数据库中。
// 它复用了您原脚本中的数据库配置和导入逻辑，但只专注于完成这一项任务。

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';

// --- 配置区域 ---
// 这部分配置与您的原脚本保持一致
const DB_FILE = 'Z:\\天猫生意参谋\\TmallDataCenter.db';
const DB_TABLE_NAME = 'pinduoduo_sales_flow';

// ======================================================================
// ★★★ 您唯一需要修改的地方 ★★★
// 请将下面这行变量的值，替换为您遗漏的那个Excel文件的【完整路径】
const MISSED_EXCEL_FILE_PATH = 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\拼多多\\miss\\拼多多商品销售流量_20250927183027.xlsx';
// 比如: 'Z:\\sky.viomi.com.cn\\运营分析\\平台获取-商品销售流量\\拼多多\\拼多多商品销售流量-2025-09-23.xlsx'
// ======================================================================


/**
 * 从您的 pdd_viomi-download.js 脚本中完整复制的核心函数。
 * 作用：读取指定的Excel文件，并将其内容导入到数据库的指定表格中。
 * @param {string} filePath - 要导入的Excel文件的完整路径
 * @returns {Promise<boolean>} - 导入成功返回 true，失败返回 false
 */
async function importExcelToDb(filePath) {
    console.log(`🔄 正在准备导入文件: ${path.basename(filePath)}`);

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
        console.error(`❌ 错误：找不到文件，请检查路径是否正确: ${filePath}`);
        return false;
    }

    try {
        const db = new Database(DB_FILE);
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

        if (data.length === 0) {
            console.log('⚠️ 文件为空，无需导入。');
            db.close();
            return true;
        }

        const columns = Object.keys(data[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const columnNames = columns.map(col => `"${col}"`).join(', ');

        const insertStmt = db.prepare(`INSERT INTO ${DB_TABLE_NAME} (${columnNames}) VALUES (${placeholders})`);

        const insertMany = db.transaction((rows) => {
            for (const row of rows) {
                const values = columns.map(col => row[col]);
                const dateIndex = columns.indexOf('日期');
                
                // 日期格式转换逻辑，与原脚本完全一致
                if (dateIndex !== -1 && values[dateIndex]) {
                    if (typeof values[dateIndex] === 'number') {
                        const excelEpoch = new Date(1899, 11, 30);
                        const jsDate = new Date(excelEpoch.getTime() + values[dateIndex] * 24 * 60 * 60 * 1000);
                        values[dateIndex] = jsDate.toISOString().slice(0, 10);
                    } else {
                        values[dateIndex] = new Date(values[dateIndex]).toISOString().slice(0, 10);
                    }
                }
                insertStmt.run(...values);
            }
        });

        insertMany(data);
        console.log(`✅ 成功导入 ${data.length} 条数据到数据库。`);
        db.close();
        return true;
    } catch (error) {
        console.error(`❌ 文件导入数据库时出错: ${error}`);
        return false;
    }
}

/**
 * 主执行函数
 */
async function main() {
    console.log('--- 开始执行补数据脚本 ---');

    // 检查用户是否已修改文件路径
    if (!MISSED_EXCEL_FILE_PATH || MISSED_EXCEL_FILE_PATH.includes('这里替换成')) {
        console.error('❌ 操作中断：请先打开脚本文件，将 `MISSED_EXCEL_FILE_PATH` 变量的值设置为您要导入的Excel文件路径。');
        return;
    }

    const importSuccess = await importExcelToDb(MISSED_EXCEL_FILE_PATH);

    if (importSuccess) {
        console.log('🎉 补数据任务成功完成！');
    } else {
        console.error('❗ 补数据任务执行失败，请检查上面的错误日志。');
    }

    console.log('--- 脚本执行结束 ---');
}

// 运行主函数
main();