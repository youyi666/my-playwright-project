// TM_run_sycm_download.js--完成改造

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- 新增：数据库和Excel处理相关的依赖 ---
// 请确保您已经通过 npm 或 yarn 安装了这些模块:
// npm install better-sqlite3
// npm install xlsx
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// --- 新增：数据库和数据处理的全局常量配置 ---
// 数据库文件路径，与 main.js 保持一致
const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
// 目标数据表名称，与 main.js 保持一致
const DB_TABLE_NAME = 'sycm_product_all';
// 需要转换为数字类型的列名列表，完全复制自 main.js
const sycmNumericColumns = ["商品访客数", "商品浏览量", "平均停留时长", "商品详情页跳出率", "商品收藏人数", "商品加购件数", "商品加购人数", "下单买家数", "下单件数", "下单金额", "下单转化率", "支付买家数", "支付件数", "支付金额", "商品支付转化率", "支付新买家数", "支付老买家数", "老买家支付金额", "聚划算支付金额", "访客平均价值", "成功退款金额", "竞争力评分", "搜索引导访客数", "搜索引导支付买家数", "实付金额", "支付单价"];


// 函数：格式化日期对象为 'YYYY-MM-DD' 字符串
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 函数：从指定目录的文件名中解析并找到最新的日期
function getLatestDateFromFiles(directory) {
    console.log(`正在扫描目录 [${directory}] 以查找最新的已下载文件...`);
    if (!fs.existsSync(directory)) {
        console.log('目录不存在，将从默认起始点开始下载。');
        return null; 
    }

    const files = fs.readdirSync(directory);
    const dateRegex = /(\d{4}-\d{2}-\d{2})/;
    let latestDate = null;

    for (const file of files) {
        const match = file.match(dateRegex);
        if (match) {
            const currentDate = new Date(match[1]);
            if (!latestDate || currentDate > latestDate) {
                latestDate = currentDate;
            }
        }
    }

    if (latestDate) {
        console.log(`找到的最新文件日期为: ${formatDate(latestDate)}`);
    } else {
        console.log('未在目录中找到任何符合日期格式的文件。');
    }
    
    return latestDate;
}

// 函数：生成需要下载的日期列表
function generateDateQueue(latestDate) {
    const datesToDownload = [];
    
    const startDate = new Date();
    if (latestDate) {
        startDate.setTime(latestDate.getTime());
        startDate.setDate(startDate.getDate() + 1);
    } else {
        startDate.setDate(startDate.getDate() - 7); 
        console.log('未找到历史文件，将默认从7天前开始检查任务。');
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    let currentDate = new Date(startDate.getTime());
    while (currentDate <= yesterday) {
        datesToDownload.push(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return datesToDownload;
}

// --- 修改：封装单次下载操作，使其返回更详细的结果对象 ---
async function downloadReportForDate(page, date, downloadsDir) { // 增加 downloadsDir 参数
    console.log(`\n--- [任务开始] 正在处理日期: ${date} ---`);
    try {
        // --- 3. 导航到目标页面 ---
        const targetUrl = `https://sycm.taobao.com/cc/item_rank?dateRange=${date}%7C${date}&dateType=day`;
        await page.goto(targetUrl);
        console.log(`已成功导航到目标页面: ${targetUrl}`);

        // --- 4. 处理可能出现的新手引导 ---
        try {
            console.log('正在检查“立即查看”新手引导...');
            const viewNowButton = page.getByRole('button', { name: '立即查看' });
            const pagePromise = page.context().waitForEvent('page');
            await viewNowButton.click({ timeout: 3000 });
            const newPage = await pagePromise;
            await newPage.close();
            console.log('已关闭新标签页，新手引导已解除。');
        } catch (error) {
            console.log('未发现新手引导，继续执行...');
        }
        
        // --- 5. 定位并点击下载链接 ---
        console.log('正在查找并点击下载链接...');
        const downloadPromise = page.waitForEvent('download');
        const downloadLink = page.locator('a.sycm-traced-download-text.sycm-cc-item-rank-download');

        await downloadLink.waitFor({ state: 'visible', timeout: 10000 });
        console.log('已成功定位到下载链接。');
        await downloadLink.click();
        console.log('已成功点击下载链接。');

        // --- 6. 等待下载完成并保存文件 ---
        const download = await downloadPromise;
        console.log(`文件下载已开始，建议的文件名为: ${download.suggestedFilename()}`);

        if (!fs.existsSync(downloadsDir)){
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const savePath = path.join(downloadsDir, download.suggestedFilename());
        
        await download.saveAs(savePath);
        console.log(`文件已成功保存到: ${savePath}`);

        // --- 7. 验证文件已成功下载 ---
        if (fs.existsSync(savePath)) {
            console.log(`✅ [任务成功] 日期 ${date} 的报表下载完成！`);
            // 返回成功状态和文件保存路径，供后续数据库导入使用
            return { success: true, savePath: savePath };
        } else {
            throw new Error(`下载失败：文件未在指定路径找到 ${savePath}`);
        }
    } catch (error) {
        console.error(`❌ [任务失败] 下载日期 ${date} 的报表时发生错误:`, error.message);
        await page.screenshot({ path: `sycm_error_${date}_screenshot.png`, fullPage: true });
        fs.writeFileSync(`sycm_error_${date}_page.html`, await page.content());
        console.log('已保存该日期的错误截图和页面HTML，以便调试。');
        // 返回失败状态
        return { success: false, savePath: null };
    }
}


// --- 新增：将下载的Excel文件导入到数据库的函数 ---
// 此函数的核心逻辑完全参照 main.js 中对 "【生意参谋平台】商品_全部_" 的处理方式
async function saveXlsxToDatabase(xlsxPath) {
    console.log(`\n--- [数据库导入] 开始处理文件: ${path.basename(xlsxPath)} ---`);
    let db;
    try {
        // 连接到中央数据库
        db = new Database(CENTRAL_DB_PATH);
        
        // 读取Excel文件
        const workbook = xlsx.readFile(xlsxPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // 从第4行开始解析数据，与 main.js 设置一致 (range: 4)
        let rawData = xlsx.utils.sheet_to_json(worksheet, { range: 4, raw: false, dateNF: 'yyyy-mm-dd' });

        if (rawData.length === 0) {
            console.log(`文件 [${path.basename(xlsxPath)}] 数据为空，跳过导入。`);
            return;
        }

        // 定义一个将值转换为数字的辅助函数
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

            // 确保商品ID是字符串
            if (finalRow.hasOwnProperty('商品ID') && typeof finalRow['商品ID'] === 'number') {
                finalRow['商品ID'] = String(finalRow['商品ID']);
            }

            // 将指定的列转换为数字
            sycmNumericColumns.forEach(col => {
                if (finalRow.hasOwnProperty(col)) finalRow[col] = toNumeric(finalRow[col]);
            });
            
            // 计算 "实付金额" 和 "支付单价"
            const paidAmount = finalRow['支付金额'];
            const refundAmount = finalRow['成功退款金额'];
            finalRow['实付金额'] = (paidAmount !== null && refundAmount !== null) ? paidAmount - refundAmount : null;
            
            const paidItems = finalRow['支付件数'];
            finalRow['支付单价'] = (paidAmount !== null && paidItems !== null && paidItems > 0) ? paidAmount / paidItems : null;
            
            return finalRow;
        }).filter(row => row['商品ID'] !== '-' && row['统计日期']); // <-- 在这里添加过滤条件

        if (processedData.length === 0) {
            console.log(`文件 [${path.basename(xlsxPath)}] 处理后无有效数据，跳过。`);
            return;
        }

        const currentFileHeaders = Object.keys(processedData[0]);
        // 清理列名中的特殊字符，以便在SQL中使用
        const sanitizedHeaders = currentFileHeaders.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
        
        // 定义联合主键
        const primaryKeys = ['统计日期'.replace(/[\s\.\-\/\\()]/g, '_'), '商品ID'.replace(/[\s\.\-\/\\()]/g, '_')];

        // 辅助函数：根据列名判断其在数据库中的类型
        const getColumnType = (header) => {
            // 如果列在我们的数字列清单里，类型为 REAL，否则为 TEXT
            return sycmNumericColumns.includes(header) ? 'REAL' : 'TEXT';
        };

        // 检查表是否存在，如果不存在则创建
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
            // 如果表已存在，检查是否有新列需要添加
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

        // 构建高效的 "INSERT OR REPLACE" (UPSERT) 查询语句
        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        const insertQuery = `
            INSERT INTO "${DB_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
            VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
            ON CONFLICT(${primaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
            ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
        `;
        const insertStmt = db.prepare(insertQuery);

        // 使用事务批量插入数据，极大提高性能
        db.transaction((rows) => {
            for (const row of rows) {
                const dataToInsert = {};
                // 将JS对象的键（列名）进行清理，以匹配数据库中的列名
                const sanitizedCurrentRow = {};
                for(const key in row) {
                    sanitizedCurrentRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key];
                }

                // 确保要插入的数据对象包含表中的所有列，没有的则设为 null
                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                insertStmt.run(dataToInsert);
            }
        })(processedData);
        
        console.log(`✅ [导入成功] 文件 [${path.basename(xlsxPath)}] 的 ${processedData.length} 条数据已成功同步至数据库。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理文件 [${path.basename(xlsxPath)}] 时发生数据库错误:`, e.message);
    } finally {
        // 确保无论成功与否，数据库连接都会被关闭
        if (db) db.close();
    }
}


// --- 主函数：包裹所有操作 ---
// --- 修改：重构主函数流程，增加下载后的数据库导入步骤 ---
(async () => {
    let browser; 
    let page;
    try {
        // --- 修改：将下载目录直接指向最终的目标文件夹 ---
        const downloadsDir = "Z:\\天猫生意参谋\\商品_商品排行";
        
        // --- 1. 确定需要下载的任务队列 ---
        const latestDateInFiles = getLatestDateFromFiles(downloadsDir);
        const datesToDownload = generateDateQueue(latestDateInFiles);

        if (datesToDownload.length === 0) {
            console.log('所有报表都已是最新，无需下载。脚本执行完毕。');
            return;
        }

        console.log(`\n检测到需要下载 ${datesToDownload.length} 个报表，日期分别为:`, datesToDownload);
        console.log('--------------------------------------------------');

        // --- 2. 启动浏览器并加载登录状态 ---
        console.log('正在静默启动浏览器...');
        browser = await chromium.launch({ 
            headless: true // true 为静默运行, false 会显示浏览器窗口
        });
        
        const context = await browser.newContext({ storageState: 'C:\\Users\\Administrator\\my-playwright-project\\auth.json' });
        page = await context.newPage();
        console.log('浏览器已启动，并加载了登录状态。');

        // --- 3. 循环执行下载任务 ---
        const successfulDownloads = []; // 新建一个数组，用于存储成功下载的文件的路径
        for (const date of datesToDownload) {
            // 将下载目录作为参数传入
            const result = await downloadReportForDate(page, date, downloadsDir);
            if (result.success) {
                successfulDownloads.push(result.savePath); // 如果成功，将路径存入数组
            }
        }
        console.log('\n--- [下载阶段结束] ---');

        // --- 4. 新增：循环执行数据库导入任务 ---
        console.log('\n--- [数据库导入阶段开始] ---');
        if (successfulDownloads.length > 0) {
            console.log(`检测到 ${successfulDownloads.length} 个新文件需要导入数据库。`);
            for (const filePath of successfulDownloads) {
                // 对每一个成功下载的文件，调用数据库导入函数
                await saveXlsxToDatabase(filePath);
            }
            console.log('✅ 所有新下载的文件均已成功导入数据库。');
        } else {
            console.log('本次运行没有成功下载任何文件，无需执行数据库导入。');
        }

        console.log('\n🎉 所有下载和导入任务已执行完毕！');

    } catch (error) {
        console.error("脚本主流程发生严重错误:", error);
        if (page) {
            await page.screenshot({ path: 'sycm_main_error_screenshot.png', fullPage: true });
            fs.writeFileSync('sycm_main_error_page.html', await page.content());
            console.log('已保存错误截图和页面HTML，以便调试。');
        }
    } finally {
        if (browser) {
            await browser.close();
            console.log('浏览器已关闭。');
        }
    }
})();