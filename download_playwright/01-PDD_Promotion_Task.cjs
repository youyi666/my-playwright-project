// 01-PDD_Promotion_Task.js - 专注于拼多多推广报表下载与入库

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
// 1. 用户登录配置文件夹 (共用) - 强烈建议保留本地 User Data Dir 以复用登录状态
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');

// 2. 推广报表任务配置
const PROMOTION_DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '推广_商品数据', '拼多多');
const PROMOTION_ARCHIVE_FOLDER = path.join(PROMOTION_DOWNLOAD_FOLDER, '已导入');

// 注意提示：下方的 {DATE} 属于静态参数，在您后续的页面跳转或抓取逻辑中，需要替换为动态获取的日期字符串，防止代码失效
const PROMOTION_TARGET_URL_TEMPLATE = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';
const PROMOTION_CHECK_PAST_DAYS = 90; // 回溯检查的天数

// 3. 行为模拟配置
const DOWNLOADS_PER_BATCH = 15;
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const LONG_DELAY_MIN_MS = 35000;
const LONG_DELAY_MAX_MS = 65000;

// 4. 数据库配置
// 逻辑修正：从 download_playwright 向上跳 3 级到达 WorkSpace 根目录，再进入数据库文件夹
const CENTRAL_DB_PATH = path.join(
    __dirname, 
    '..', '..', '..', 
    '00_Shared_Database数据库', 
    'TmallDataCenter.db'
);

const DB_PROMOTION_TABLE_NAME = 'pdd_product_promotion'; // 推广报表表名
const PROMOTION_DATE_HEADER = '统计日期'; // 用于查漏补缺的日期字段
const pddPromoNumericColumns = ["花费(元)", "订单数", "成交金额(元)", "投产比", "点击量", "点击率(%)", "千次展现花费(元)"];

// 打印最终解析出的绝对路径，运行脚本时你可以第一眼就看到路径对不对
console.log(`[系统日志] 数据库预定路径已解析为: ${CENTRAL_DB_PATH}`);

// ======================= [辅助函数] =======================

function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(` -> 模拟操作，随机等待 ${delay / 1000} 秒...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function moveFileToArchive(sourcePath, archiveDir, newFileName = null) {
    try {
        await fs.mkdir(archiveDir, { recursive: true });
        const fileName = newFileName || path.basename(sourcePath); 
        const destPath = path.join(archiveDir, fileName);
        await fs.rename(sourcePath, destPath);
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        console.error(`❌ 文件归档失败 (${path.basename(sourcePath)}): ${e.message}`);
    }
}

// ======================= [数据库逻辑 - 推广报表] =======================

async function savePddPromotionReportToDatabase(csvPath, dateStr) {
    console.log(`\n--- [数据库导入] 开始处理推广报表文件: ${path.basename(csvPath)} ---`);
    let db;
    try {
        db = new Database(CENTRAL_DB_PATH);
        
        const workbook = xlsx.readFile(csvPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        let rawData = xlsx.utils.sheet_to_json(worksheet, { raw: false });

        if (rawData.length === 0) {
            console.log(`文件 [${path.basename(csvPath)}] 数据为空，跳过导入。`);
            return;
        }

        const toNumeric = (val) => {
            if (val === null || val === undefined || val === "-") return null;
            const num = parseFloat(String(val).replace(/[,%]/g, ''));
            return isNaN(num) ? null : num;
        };

        const processedData = rawData.map(row => {
            const finalRow = {};
            for (const key in row) {
                finalRow[key.trim()] = row[key];
            }
            finalRow['统计日期'] = dateStr;
            pddPromoNumericColumns.forEach(col => {
               if (finalRow.hasOwnProperty(col)) {
                   if (col === '点击率(%)') {
                       finalRow[col] = toNumeric(finalRow[col]) / 100;
                   } else {
                       finalRow[col] = toNumeric(finalRow[col]);
                   }
                }
            });
            return finalRow;
        }).filter(row => row['商品ID'] !== '-' && row['统计日期']);

        const currentFileHeaders = Object.keys(processedData[0]);
        const primaryKeys = ['统计日期', '商品ID'].map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));

        const getColumnType = (header) => {
            return pddPromoNumericColumns.includes(header) ? 'REAL' : 'TEXT';
        };

        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        if (tableInfo.length === 0) {
            db.exec(`
                CREATE TABLE "${DB_PROMOTION_TABLE_NAME}" (
                    ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `);
            console.log(`数据表 [${DB_PROMOTION_TABLE_NAME}] 不存在，已成功创建。`);
        } else {
            const existingColumns = tableInfo.map(col => col.name);
            const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
            if (newHeaders.length > 0) {
                db.transaction(() => {
                    for (const header of newHeaders) {
                        const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                        db.prepare(`ALTER TABLE "${DB_PROMOTION_TABLE_NAME}" ADD COLUMN "${sanitizedHeader}" ${getColumnType(header)}`).run();
                    }
                })();
            }
        }

        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        
        const insertQuery = `
            INSERT INTO "${DB_PROMOTION_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
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
        console.log(`✅ [导入成功] 推广报表文件 [${path.basename(csvPath)}] 的 ${processedData.length} 条数据已成功同步至数据库。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理推广报表文件 [${path.basename(csvPath)}] 时发生数据库错误:`, e.message);
    } finally {
        if (db) db.close();
    }
}

async function getMissingPromotionDatesFromDatabase(daysAgo) {
    console.log(`\n🔍 正在查询数据库 [${DB_PROMOTION_TABLE_NAME}] 查找最近 ${daysAgo} 天缺失的推广报表日期...`);
    let db;
    const existingDates = new Set();
    const requiredDates = new Set();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    let currentDate = new Date(startDate);
    while (currentDate < today) {
        requiredDates.add(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (requiredDates.size === 0) return new Set();

    try {
        db = new Database(CENTRAL_DB_PATH, { readonly: true });
        const promotionDateSanitized = PROMOTION_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        
        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        const columnExists = tableInfo.some(col => col.name === promotionDateSanitized);
        
        if (!columnExists) {
            console.warn(` ⚠️ 警告: 数据库表 [${DB_PROMOTION_TABLE_NAME}] 中缺少 [${PROMOTION_DATE_HEADER}] 字段，将重新下载所有日期以确保数据完整！`);
            return requiredDates;
        }

        const minDate = formatDate(startDate);
        const query = `
            SELECT DISTINCT "${promotionDateSanitized}" 
            FROM "${DB_PROMOTION_TABLE_NAME}" 
            WHERE "${promotionDateSanitized}" >= ?;
        `;
        const rows = db.prepare(query).all(minDate);
        
        for (const row of rows) {
            const dateStr = row[promotionDateSanitized];
            if (dateStr && requiredDates.has(dateStr)) {
                existingDates.add(dateStr);
            }
        }
        
    } catch (e) {
        console.error(`❌ [数据库查漏失败]: ${e.message}`);
        console.warn(' ⚠️ 由于数据库查询失败，将重新下载所有日期以确保数据完整！');
        return requiredDates;
    } finally {
        if (db) db.close();
    }

    const datesToDownload = Array.from(requiredDates).filter(date => !existingDates.has(date));
    const missingDatesSet = new Set(datesToDownload);

    console.log(` -> 数据库中已找到 ${existingDates.size} 个日期的数据。`);
    console.log(` -> 发现 ${missingDatesSet.size} 个缺失日期。`);
    
    return missingDatesSet;
}

async function getExistingPromotionDatesFromFiles(directory, daysAgo) {
    console.log(`正在扫描目录 [${directory}] 以查找最近 ${daysAgo} 天内已下载的推广报表文件...`);
    const existingDates = new Set();
    const dateRegex = /pdd_promotion_report_(\d{4}-\d{2}-\d{2})\.csv/;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);

    try {
        await fs.mkdir(directory, { recursive: true });
        const files = await fs.readdir(directory);
        for (const file of files) {
            const filePath = path.join(directory, file);
            if (path.resolve(filePath).startsWith(path.resolve(PROMOTION_ARCHIVE_FOLDER))) {
                continue;
            }
            
            const match = file.match(dateRegex);
            if (match) {
                const fileDateStr = match[1];
                const fileDate = new Date(fileDateStr);
                fileDate.setHours(0, 0, 0, 0);
                if (fileDate >= startDate && fileDate < today) {
                    existingDates.add(fileDateStr);
                }
            }
        }
        console.log(`扫描完成，在指定范围内共找到 ${existingDates.size} 个已存在的推广报表日期。`);
        return existingDates;
    } catch (error) {
        console.error(`扫描目录时发生错误: ${error.message}`);
        return existingDates;
    }
}

// ======================= [任务主流程] =======================

async function pddPromotionReportTask(page) {
    console.log(`\n--- 📈 [任务] 正在执行推广报表下载和数据库导入任务 (基于数据库查漏) ---`);
    // 1. 检查数据库，获取缺失的日期 (数据库优先原则)
    const datesMissingInDB = await getMissingPromotionDatesFromDatabase(PROMOTION_CHECK_PAST_DAYS);
    let datesToDownload = Array.from(datesMissingInDB).sort();
    
    if (datesToDownload.length === 0) {
        console.log(`✅ 最近 ${PROMOTION_CHECK_PAST_DAYS} 天的推广报表数据已在数据库中完整，无需操作。`);
        return;
    }
    
    // 2. 在数据库存在缺失的情况下，检查本地下载目录
    console.log('\n--- [文件查漏] 检查下载目录中是否有未导入的文件需要优先处理 ---');
    const existingDatesSet = await getExistingPromotionDatesFromFiles(PROMOTION_DOWNLOAD_FOLDER, PROMOTION_CHECK_PAST_DAYS);
    
    const datesToActuallyDownload = datesToDownload.filter(date => !existingDatesSet.has(date));
    if (datesToActuallyDownload.length === 0) {
        console.log(`✅ 所有数据库中缺失的日期，对应的文件在本地下载目录中都已存在，无需重复下载。`);
        console.log(' -> 脚本将跳过下载。请确保本地文件已通过其他方式处理或归档。');
        // 注意：这里我们不做返回，因为虽然不需要下载，但可能需要导入
        // 但根据原逻辑，这里返回了。如果是为了导入未归档文件，建议单独处理。
        // 原脚本此处是 return 的，为了遵循守恒原则，保持 return。
        // 实际上文件扫描是为了避免“重复下载”，如果文件已存在，说明上次下载成功但导入失败或未导入。
        // 原脚本逻辑此处中断，需确认是否要执行导入。这里保持原样：return。
        return;
    }
    
    datesToDownload = datesToActuallyDownload; 

    console.log(`\n发现 ${datesToDownload.length} 个需要下载的推广报表日期:`);
    console.log(datesToDownload.join(', '));
    console.log('---');

    let downloadCounter = 0;
    const successfulDownloads = [];

    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[处理中] 推广报表日期: ${dateStr}`);
            const targetUrl = PROMOTION_TARGET_URL_TEMPLATE.replace(/{DATE}/g, dateStr);

            console.log(` -> 导航到: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            console.log(' -> 页面加载完成，正在查找下载按钮...');

            const downloadButton = page.getByRole('button', { name: '下载' }).nth(1);
            await downloadButton.waitFor({ state: 'visible', timeout: 30000 });

            console.log(' -> 找到按钮，准备点击并捕获下载...');
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                downloadButton.click(),
            ]);
            const fileName = `pdd_promotion_report_${dateStr}.csv`;
            const filePath = path.join(PROMOTION_DOWNLOAD_FOLDER, fileName);

            await download.saveAs(filePath);
            console.log(`✅ [成功] 推广报表已保存到: ${filePath}`);
            successfulDownloads.push({ path: filePath, date: dateStr });

            downloadCounter++;

            if (downloadCounter > 0 && downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                console.log(`\n--- 已连续下载 ${DOWNLOADS_PER_BATCH} 个文件，执行一次长暂停以模拟人类行为 ---`);
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
                console.log('--- 长暂停结束，继续任务 ---\n');
            } else {
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }

        } catch (error) {
            console.error(`❌ [失败] 处理推广报表日期 ${dateStr} 时遇到错误: ${error.message}`);
            console.error(' -> 将跳过这个日期，继续下一个。');
        }
    }
    
    console.log('\n--- 所有推广报表下载任务已处理完毕！---');
    if (successfulDownloads.length > 0) {
        console.log(`\n--- 开始执行数据库导入，共 ${successfulDownloads.length} 个推广报表文件 ---`);
        for (const file of successfulDownloads) {
            await savePddPromotionReportToDatabase(file.path, file.date);
            await moveFileToArchive(file.path, PROMOTION_ARCHIVE_FOLDER, path.basename(file.path));
        }
        console.log('\n--- 所有推广报表文件均已导入数据库 ---');
    }
}

// ======================= [入口函数] =======================
async function main() {
    console.log(`\n--- 🚀 [Promotion Only] 启动拼多多推广报表下载任务 ---`);

    let context;
    let page;
    try {
        console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
        try { 
            await fs.access(userDataDir);
        } catch { 
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); 
            console.error('请先成功运行一次登录配置或检查路径。');
            return; 
        }
        
        // 推广报表下载虽然指定了路径 saveAs，但保持一致性还是传入 downloadPath
        await fs.mkdir(PROMOTION_DOWNLOAD_FOLDER, { recursive: true });

        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], 
            viewport: null,
            downloadsPath: PROMOTION_DOWNLOAD_FOLDER 
        });
        page = context.pages().length ? context.pages()[0] : await context.newPage();
        console.log('✅ 用户配置加载成功！会话已恢复。');

        // 执行推广报表任务
        await pddPromotionReportTask(page);

    } catch (error) {
        console.error('❌ 脚本在执行过程中遇到严重错误:', error.message);
    } finally {
        if (context) {
            await context.close();
            console.log('\n🔚 浏览器已关闭，推广报表任务执行结束。');
        }
    }
    console.log('\n🎉 推广报表任务执行完毕！');
}

main();