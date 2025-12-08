// run_download.js

const { chromium } = require('playwright');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
const DB_TABLE_NAME = 'wxt_product_promotion';
const dayjs = require('dayjs'); // 引入 dayjs 库
// 需要转换为数字类型的列名列表，复制自 main.js
const promoNumericColumns = ["点击量", "花费", "总成交金额", "总成交笔数", "投入产出比", "总收藏加购成本", "总成交成本", "宝贝收藏成本", "宝贝收藏加购成本"];


/**
 * 轮询检查报表是否生成成功
 * @param {import('playwright').Page} page - Playwright 的 Page 对象
 * @param {number} timeout - 总超时时间（毫秒）
 * @param {number} interval - 每次轮询的间隔时间（毫秒）
 */
async function pollForReportReady(page, timeout = 600000, interval = 5000) {
    console.log(`[轮询] 开始检查报表生成状态，最长等待 ${timeout / 1000} 秒...`);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        // 点击刷新按钮
        await page.getByRole('button', { name: '刷新表格' }).click();
        console.log(`[轮询] 已点击刷新，等待 ${interval / 1000} 秒后检查状态...`);
        
        // 等待一下，让数据加载
        await page.waitForTimeout(interval);

        // 定位到表格的第一行，并获取其状态文本
        // 注意: 这个选择器需要根据实际页面结构调整，这里假设状态在第4个单元格(td)
        const firstRow = page.locator('tbody tr').first();
        const statusCell = firstRow.locator('td').nth(1); // 假设状态在第二列，索引从0开始

        try {
            // 确保状态单元格可见
            await statusCell.waitFor({ state: 'visible', timeout: 5000 });
            const statusText = await statusCell.textContent();
            console.log(`[轮询] 当前最新任务状态: "${statusText}"`);

            if (statusText && statusText.includes('生成成功')) {
                console.log('[轮询] ✅ 报表生成成功！');
                return true; // 成功，跳出循环
            }
            // 如果是 "生成中" 或 "排队中"，则继续等待，不做任何事
            
        } catch (error) {
            console.log('[轮询] 无法获取最新任务状态，可能列表为空或正在加载。继续等待...');
        }
    }
    
    // =================================================================
    // ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ 【修改位置 1: 标点符号修正】 ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
    //
    // 问题：原代码末尾的结束符号是一个单引号 '，与开头的反引号 ` 不匹配，导致语法错误。
    // 修正：将末尾的单引号 ' 修正为反引号 `，以正确闭合模板字符串。
    //
    throw new Error(`[轮询] 超时 ${timeout / 1000} 秒，报表仍未生成成功。`);
    // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ 【修改位置 1: 标点符号修正】 ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
    // =================================================================
}
// --- 解压缩并处理报表 ---
async function processDownloadedReport(zipPath) {
    console.log(`\n--- [解压缩] 开始处理文件: ${path.basename(zipPath)} ---`);

    try {
        // 解压缩 .zip 文件
        const zip = new AdmZip(zipPath);
        const extractDir = path.join(path.dirname(zipPath), 'extracted');
        // =================================================================
        // ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ 【修改位置 3: 清理旧文件】 ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
        //
        // 问题：解压目录不会自动清空，导致前一天解压的旧CSV文件残留。当脚本查找CSV文件时，
        //       可能会错误地选中旧文件进行处理，使得当天的新数据无法被导入。
        // 修正：在每次解压之前，强制删除整个解压目录（如果存在），然后再重新创建它。
        //       这确保了目录中只包含本次解压产生的最新文件，从根本上解决了处理旧数据的问题。
        //
        if (fs.existsSync(extractDir)) {
            console.log(`[清理] 发现旧的解压目录，正在清理: ${extractDir}`);
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ 【修改位置 3: 清理旧文件】 ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
        // =================================================================
        if (!fs.existsSync(extractDir)) {
            fs.mkdirSync(extractDir, { recursive: true });
        }
        zip.extractAllTo(extractDir, true);
        console.log(`文件已解压到: ${extractDir}`);

        // 查找解压后的 .csv 文件
        const files = fs.readdirSync(extractDir);
        const csvFile = files.find(file => file.endsWith('.csv'));
        if (!csvFile) {
            console.error('❌ 解压目录中未找到 .csv 文件，无法继续处理。');
            return;
        }

        const csvPath = path.join(extractDir, csvFile);
        console.log(`找到解压后的 .csv 文件: ${csvPath}`);

        // --- 核心流程：调用数据库导入函数处理解压后的CSV文件 ---
        await saveAlimamaReportToDatabase(csvPath);

    } catch (error) {
        console.error(`❌ [处理失败] 在解压缩或文件查找过程中发生错误:`, error.message);
    }
}


// --- 新增：将下载的报表文件导入到数据库的函数 ---
// 此函数的核心逻辑完全参照 main.js 中对 "商品报表_" 的处理方式
async function saveAlimamaReportToDatabase(csvPath) {
    console.log(`\n--- [数据库导入] 开始处理文件: ${path.basename(csvPath)} ---`);
    let db;
    try {
        // 连接到中央数据库
        db = new Database(CENTRAL_DB_PATH);
        
        // 读取Excel文件 (xlsx库也能处理csv)
        const workbook = xlsx.readFile(csvPath, { codepage: 936 });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // --- 核心特殊处理：强制'主体ID'列为文本 ---
        // 这是为了防止xlsx库将纯数字的ID自动识别为数字格式，导致超长ID变为科学记数法而丢失精度
        // 这个操作必须在 sheet_to_json 之前完成
        const range = xlsx.utils.decode_range(worksheet['!ref']);
        let idColumnIndex = -1;
        // 1. 遍历第一行，找到 '主体ID' 所在的列索引
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellRef = xlsx.utils.encode_cell({c: C, r: range.s.r});
            const cell = worksheet[cellRef];
            if (cell && cell.v && String(cell.v).trim() === '主体ID') {
                idColumnIndex = C;
                break;
            }
        }
        // 2. 如果找到了 '主体ID' 列
        if (idColumnIndex > -1) {
            console.log(`检测到"主体ID"列，正在强制转换为文本格式以防数据失真...`);
            // 3. 遍历该列的所有单元格（从第二行数据开始）
            for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                const cellRef = xlsx.utils.encode_cell({c: idColumnIndex, r: R});
                const cell = worksheet[cellRef];
                // 4. 如果单元格存在且被识别为数字(type='n')
                if (cell && cell.t === 'n') {
                    // 5. 强制将类型改为字符串(type='s')，并将其值转为字符串
                    cell.t = 's';
                    cell.v = String(cell.v);
                    delete cell.w; // 删除格式化的文本，确保使用原始值
                }
            }
        }

        // 将工作表转换为JSON，此时'主体ID'列已全部是文本格式
        let rawData = xlsx.utils.sheet_to_json(worksheet, { raw: false, dateNF: 'yyyy-mm-dd' });

        if (rawData.length === 0) {
            console.log(`文件 [${path.basename(csvPath)}] 数据为空，跳过导入。`);
            return;
        }

        const toNumeric = (val) => {
            if (val === null || val === undefined || val === "-") return null;
            const num = parseFloat(String(val).replace(/[,%]/g, ''));
            return isNaN(num) ? null : num;
        };

        // 数据清洗和预处理
        const processedData = rawData.map(rawRow => {
            const finalRow = {};
            // 清理列名中的空格
            for (const key in rawRow) {
                finalRow[key.trim()] = rawRow[key];
            }

            // --- 核心转换：重命名列以匹配统一的数据模型 ---
            finalRow['商品ID'] = finalRow['主体ID'];
            delete finalRow['主体ID'];
            if (finalRow['日期']) {
                finalRow['统计日期'] = dayjs(finalRow['日期'], 'M/D/YY').format('YYYY-MM-DD');
            } else {
                finalRow['统计日期'] = null; // 或其他默认值
            }
            delete finalRow['日期'];

            // 将指定的列转换为数字
            promoNumericColumns.forEach(col => {
                if (finalRow.hasOwnProperty(col)) finalRow[col] = toNumeric(finalRow[col]);
            });
            
            return finalRow;
        }).filter(row => row['商品ID'] !== '-' && row['统计日期']); // <-- 在这里添加过滤条件

        if (processedData.length === 0) {
            console.log(`文件 [${path.basename(csvPath)}] 处理后无有效数据，跳过。`);
            return;
        }

        const currentFileHeaders = Object.keys(processedData[0]);
        const sanitizedHeaders = currentFileHeaders.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
        
        // 定义联合主键
        const primaryKeys = ['统计日期'.replace(/[\s\.\-\/\\()]/g, '_'), '商品ID'.replace(/[\s\.\-\/\\()]/g, '_')];

        const getColumnType = (header) => {
            return promoNumericColumns.includes(header) ? 'REAL' : 'TEXT';
        };

        const tableInfo = db.prepare(`PRAGMA table_info("${DB_TABLE_NAME}")`).all();
        if (tableInfo.length === 0) {
            db.exec(`
                CREATE TABLE "${DB_TABLE_NAME}" (
                    ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `);
            console.log(`数据表 [${DB_TABLE_NAME}] 不存在，已成功创建。`);
        } else {
            const existingColumns = tableInfo.map(col => col.name);
            const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
            if (newHeaders.length > 0) {
                db.transaction(() => {
                    for (const header of newHeaders) {
                        const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                        db.prepare(`ALTER TABLE "${DB_TABLE_NAME}" ADD COLUMN "${sanitizedHeader}" ${getColumnType(header)}`).run();
                        console.log(`向表 [${DB_TABLE_NAME}] 中添加了新列: ${sanitizedHeader}`);
                    }
                })();
            }
        }

        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        const insertQuery = `
            INSERT INTO "${DB_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
            VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
            ON CONFLICT(${primaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
            ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
        `;
        const insertStmt = db.prepare(insertQuery);

        db.transaction((rows) => {
            for (const row of rows) {
                const dataToInsert = {};
                const sanitizedCurrentRow = {};
                for(const key in row) {
                    sanitizedCurrentRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key];
                }
                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                insertStmt.run(dataToInsert);
            }
        })(processedData);
        
        console.log(`✅ [导入成功] 文件 [${path.basename(csvPath)}] 的 ${processedData.length} 条数据已成功同步至数据库。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理文件 [${path.basename(csvPath)}] 时发生数据库错误:`, e.message);
    } finally {
        if (db) db.close();
    }
}


// --- 主函数：包裹所有操作 ---
(async () => {
    let browser;
    let page;
    try {
        // --- 1. 启动浏览器并加载登录状态 ---
        console.log('正在静默启动浏览器...');
        browser = await chromium.launch({
            headless: true // 设置为 false 可以在调试时看到浏览器界面
        });

        const context = await browser.newContext({ storageState: 'C:\\Users\\Administrator\\my-playwright-project\\auth.json' });
        page = await context.newPage();
        console.log('浏览器已启动，并加载了登录状态。');

        // --- 2. 导航到目标报表页面 ---
        const reportUrl = "https://one.alimama.com/index.html?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf#!/report/item_promotion?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf&rptType=item_promotion&isRequestedQztDefaultSet=1";
        await page.goto(reportUrl);
        console.log('已成功导航到报表页面。');
        await page.waitForSelector('span[mx-click*="download"]', { timeout: 20000 });

        // --- 3. 点击“下载报表”按钮 ---
        await page.getByRole('button', { name: '下载报表' }).click();
        console.log('已成功点击“下载报表”。');

        // --- 4. 设置下载参数并提交 ---
        const dialogLocator = page.locator('div[mxv][data-spm="onebp_views_pages_report_download-dialog"]');
        await dialogLocator.waitFor({ state: 'visible', timeout: 10000 });
        console.log('下载对话框已显示。');

        const confirmButton = page.getByRole('button', { name: '确定' });
        await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
        await confirmButton.click();
        console.log('已点击“确定”，提交下载任务。服务器正在生成报表...');

        // --- 5. 跳转到下载任务列表 ---
        const downloadListUrl = "https://one.alimama.com/index.html?spm=a21dvs.28490323.cf182d077.de22e78c2.2b022cde9ZKbJf#!/report/download-list";
        await page.goto(downloadListUrl);
        console.log('已成功导航到下载任务列表。');

        // --- 6. [核心修改] 轮询等待报表生成成功 ---
        await page.waitForSelector('table', { timeout: 15000 });
        await pollForReportReady(page); // 调用轮询函数

        // --- 7. 下载文件 ---
        // 设置下载事件监听
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '刷新表格' }).click();
        console.log('已点击“刷新表格”，正在等待报表生成...');

        const dataRow = page.locator('tbody tr:has-text("生成成功")').first();
        await dataRow.waitFor({ state: 'visible' });
        console.log('最新的报表已确认生成成功。');
        
        console.log('正在查找下载按钮...');
        // 在阿里妈妈的页面中，操作按钮通常需要悬停才出现
        await dataRow.hover();
        console.log('已悬停在数据行以显示操作按钮。');
        
        // 注意：这里的 + tr 选择器可能不稳定，如果按钮就在tr内，直接用dataRow.locator更好
        const actionRow = dataRow.locator('+ tr');
        const downloadButton = actionRow.getByRole('button', { name: '下载' });

        await downloadButton.waitFor({ state: 'visible', timeout: 5000 });
        console.log('已找到下载按钮，准备点击下载...');
        await downloadButton.click();

        // --- 8. 保存文件 ---
        const download = await downloadPromise;
        const downloadedFileName = download.suggestedFilename();
        const downloadsDir = "Z:/天猫生意参谋/推广_商品数据";
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const savePath = path.join(downloadsDir, downloadedFileName);

        await download.saveAs(savePath);

        if (fs.existsSync(savePath)) {
            console.log(`✅ 文件已成功下载并保存到: ${savePath}`);
            
            // =================================================================
            // ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ 【修改位置 2: 逻辑流程修正】 ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
            //
            // 问题：原代码直接调用 saveAlimamaReportToDatabase(savePath)，但 savePath 是 .zip 文件，
            //       而数据库函数需要处理 .csv 文件，这会导致执行失败。
            // 修正：调用 processDownloadedReport(savePath) 函数。此函数会先解压 .zip 文件，
            //       找到其中的 .csv 文件，然后再调用数据库导入函数，确保流程正确。
            //
            await processDownloadedReport(savePath);
            // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ 【修改位置 2: 逻辑流程修正】 ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
            // =================================================================

        } else {
            throw new Error(`文件保存失败，路径未找到: ${savePath}`);
        }

    } catch (error) {
        console.error("脚本执行过程中发生错误:", error);
        if (page) {
            const errorImagePath = `alimama_error_screenshot.png`;
            await page.screenshot({ path: errorImagePath, fullPage: true });
            console.log(`已截取错误屏幕快照并保存至: ${errorImagePath}`);
        }
    } finally {
        if (browser) {
            await browser.close();
            console.log('浏览器已关闭。');
        }
    }
})();