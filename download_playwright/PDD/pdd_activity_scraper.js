// pdd_activity_scraper.js (最终版 - 数据库集成 - 多状态简化版)

const { chromium, errors } = require('playwright');
const xlsx = require('xlsx');
const path = require('path');
const fs =require('fs/promises');
const sqlite3 = require('sqlite3').verbose();


// ======================= [配置区域] =======================
const userDataDir = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\PDD\\pdd-auth-profile';
const INPUT_EXCEL_PATH = 'C:\\Users\\Administrator\\iCloudDrive\\github\\software_version\\input\\products.xlsx';
const INPUT_SHEET_NAME = 'products1';
const PRODUCT_ID_COLUMN_HEADER = '商品ID';
const OUTPUT_DIR = __dirname; 
const DB_PATH = path.join(__dirname, 'pdd_activity.db');

// ======================= [修改1 - 开始] =======================
// [修改] 将单个URL改为对象数组，以支持遍历多个状态页面
const TARGETS = [
    { url: 'https://mms.pinduoduo.com/act/register_record?tab=2', status: '审核中' },
    { url: 'https://mms.pinduoduo.com/act/register_record?tab=3', status: '活动中' },
    { url: 'https://mms.pinduoduo.com/act/register_record?tab=4', status: '已结束' }
];
// ======================= [修改1 - 结束] =======================

const LONG_DELAY_MIN_MS = 2000;
const LONG_DELAY_MAX_MS = 5000;
const HUMAN_LIKE_DELAY_MIN_MS = 500;
const HUMAN_LIKE_DELAY_MAX_MS = 1500;


// ======================= [辅助函数] =======================
async function readProductsFromExcel(filePath, sheetName, idColumnName) {
    console.log(`\n--- [读取数据] 开始从文件 [${path.basename(filePath)}] 的 [${sheetName}] 工作表中读取所有数据... ---`);
    try {
        await fs.access(filePath);
        const workbook = xlsx.readFile(filePath);
        if (!workbook.SheetNames.includes(sheetName)) { throw new Error(`工作表 "${sheetName}" 不存在。`); }
        
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(worksheet);

        if (jsonData.length === 0) {
            console.warn(`⚠️ 警告: 工作表 [${sheetName}] 中没有任何数据。`);
            return [];
        }
        if (!jsonData[0].hasOwnProperty(idColumnName)) {
            throw new Error(`指定的商品ID列 "${idColumnName}" 在工作表中不存在。`);
        }

        console.log(`✅ [读取成功] 共找到 ${jsonData.length} 行商品数据。`);
        return jsonData;
    } catch (error) {
        console.error(`❌ [读取失败] 处理Excel文件时发生错误: ${error.message}`);
        return [];
    }
}
async function saveResultsToCsv(data, filePath) {
    if (data.length === 0) { console.log("\n--- [保存结果] 没有抓取到任何数据，无需生成CSV文件。 ---"); return; }
    console.log(`\n--- [保存结果] 准备将 ${data.length} 条记录保存到CSV文件... ---`);
    try {
        const worksheet = xlsx.utils.json_to_sheet(data);
        const csvOutput = xlsx.utils.sheet_to_csv(worksheet);
        await fs.writeFile(filePath, '\uFEFF' + csvOutput);
        console.log(`✅ [CSV保存成功] 数据已成功保存到: ${filePath}`);
    } catch (error) {
        console.error(`❌ [CSV保存失败] 写入文件时发生错误: ${error.message}`);
    }
}
function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(` -> 模拟操作，随机等待 ${delay / 1000} 秒...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

async function saveResultsToDb(data, dbPath) {
    if (data.length === 0) { console.log("--- [保存结果] 没有抓取到任何数据，无需写入数据库。 ---"); return; }
    console.log(`\n--- [保存结果] 准备将 ${data.length} 条记录写入SQLite数据库... ---`);

    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error(`❌ [DB错误] 连接数据库失败: ${err.message}`);
            return;
        }
        console.log(' -> 成功连接到 pdd_activity.db 数据库。');
    });

    db.serialize(() => {
        const columns = Object.keys(data[0]);
        const columnDefs = columns.map(col => `"${col}" TEXT`).join(', ');
        // ======================= [修改2 - 开始] =======================
        // [修改] 将“活动状态”加入联合主键，确保数据唯一性
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS activity (
                ${columnDefs},
                PRIMARY KEY ("登记日期","商品ID",  "活动ID", "系统推送时间", "活动状态")
            )
        `;
        // ======================= [修改2 - 结束] =======================
        db.run(createTableSql, (err) => {
            if (err) {
                console.error(`❌ [DB错误] 创建表 'activity' 失败: ${err.message}`);
                return;
            }
            console.log(" -> 表 'activity' 已确认存在。");
        });

        const placeholders = columns.map(() => '?').join(', ');
        const insertSql = `INSERT OR REPLACE INTO activity (${columns.map(col => `"${col}"`).join(', ')}) VALUES (${placeholders})`;
        const stmt = db.prepare(insertSql, (err) => {
             if (err) console.error(`❌ [DB错误] 准备插入语句失败: ${err.message}`);
        });

        console.log(" -> 开始写入数据...");
        for (const record of data) {
            const values = columns.map(col => record[col]);
            stmt.run(values, (err) => {
                if (err) console.error(`❌ [DB错误] 插入记录失败 (ID: ${record[PRODUCT_ID_COLUMN_HEADER]}): ${err.message}`);
            });
        }

        stmt.finalize((err) => {
            if (err) console.error(`❌ [DB错误] 完成语句时出错: ${err.message}`);
            else console.log(` -> ${data.length} 条记录已成功写入/更新。`);
        });
    });

    db.close((err) => {
        if (err) {
            console.error(`❌ [DB错误] 关闭数据库连接时出错: ${err.message}`);
        } else {
            console.log('✅ [DB保存成功] 数据库连接已关闭。');
        }
    });
}


// ======================= [主逻辑] =======================
async function main() {
    console.log("--- [任务开始] 拼多多商品活动报名记录抓取脚本 (多状态简化版) ---");
    
    const now = new Date();
    const registrationDate = now.toISOString().split('T')[0];
    const fileTimestamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const outputCsvPath = path.join(OUTPUT_DIR, `拼多多活动报名记录_${fileTimestamp}.csv`);
    
    const productsData = await readProductsFromExcel(INPUT_EXCEL_PATH, INPUT_SHEET_NAME, PRODUCT_ID_COLUMN_HEADER);
    if (productsData.length === 0) { console.log("因未能读取到商品数据，脚本执行终止。"); return; }
    
    console.log(`\n--- [启动浏览器] 正在从 \`${userDataDir}\` 加载用户配置... ---`);
    try { await fs.access(userDataDir); } catch { console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！`); return; }
    const context = await chromium.launchPersistentContext(userDataDir, { headless: false, args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], viewport: null });
    const page = context.pages().length ? context.pages()[0] : await context.newPage();
    console.log('✅ 用户配置加载成功！开始执行抓取任务...');
    
    const allResults = [];
    
    // ======================= [修改3 - 开始] =======================
    // [新增] 外层循环，用于遍历不同的活动状态页面
    for (const target of TARGETS) {
        console.log(`\n\n-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-`);
        console.log(`--- [切换任务] 开始处理状态: [${target.status}]，访问URL: ${target.url} ---`);
        console.log(`-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-`);

        for (const [index, product] of productsData.entries()) {
            const productId = String(product[PRODUCT_ID_COLUMN_HEADER]).trim();
            if (!productId) {
                console.log(`\n[${index + 1}/${productsData.length}] 跳过，因为商品ID为空。`);
                continue;
            }
            try {
                console.log(`\n[${index + 1}/${productsData.length}] 正在处理商品ID: ${productId}，状态: [${target.status}]`);
                await page.goto(target.url, { waitUntil: 'load', timeout: 60000 });
                const searchInput = page.locator('div.activity-with-label-wrapper:has-text("商品ID") textarea');
                await searchInput.waitFor({ state: 'visible', timeout: 30000 });

                await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
                await searchInput.fill(productId);

                const queryButton = page.getByRole('button', { name: '查询' });

                await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
                await queryButton.click();
                console.log(' -> 已点击查询按钮。');
                
                console.log(' -> 执行固定等待3秒，等待页面刷新...');
                await page.waitForTimeout(3000);
                console.log(' -> 等待结束。');

                // 恢复使用原始的、只查找详情链接的定位器
                const detailLinkLocator = page.locator('[data-tracking-click-viewid="ele_registration_details_shared"]:visible');
                
                const addNoRecordResult = () => {
                     allResults.push({
                        ...product,
                        [PRODUCT_ID_COLUMN_HEADER]: String(product[PRODUCT_ID_COLUMN_HEADER]),
                        '登记日期': registrationDate,
                        '活动状态': target.status, // 新增活动状态
                        '活动ID': '无', 
                        '活动名称': '无报名记录',
                        '活动类型': '无', 
                        '系统推送时间': '无'
                    });
                };
                
                let linkCount = 0;
                try {
                    await detailLinkLocator.first().waitFor({ state: 'visible', timeout: 5000 }); 
                    linkCount = await detailLinkLocator.count();
                    console.log(` -> [直接计数] 通过Playwright直接清点，发现 ${linkCount} 条可见记录。`);
                } catch (e) {
                    console.log(` -> 未找到商品ID [${productId}] 在状态 [${target.status}] 下的相关报名记录。`);
                    addNoRecordResult();
                    continue; 
                }

                if (linkCount === 0) {
                    console.log(' -> 确认无记录可处理，跳至下一个商品。');
                    addNoRecordResult();
                    continue;
                }

                console.log(` -> 开始逐一处理这 ${linkCount} 条记录...`);

                for (let i = 0; i < linkCount; i++) {
                    let detailsPage;
                    try {
                        const link = detailLinkLocator.nth(i);
                        console.log(`  -> 正在处理第 ${i + 1}/${linkCount} 条记录...`);
                        
                        const pagePromise = context.waitForEvent('page', { timeout: 60000 });
                        
                        await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
                        await link.click();
                        detailsPage = await pagePromise;
                        await detailsPage.waitForLoadState('domcontentloaded');
                        console.log('    -> 新详情页面已打开...');

                        try {
                            const expandButton = detailsPage.locator('text="展开全部活动进度"');
                            await randomDelay(HUMAN_LIKE_DELAY_MIN_MS, HUMAN_LIKE_DELAY_MAX_MS);
                            await expandButton.click({ timeout: 3000 });
                            console.log('    -> 已点击“展开全部活动进度”。');
                        } catch (expandError) {
                            console.log('    -> 页面信息已完全展示，无需展开。');
                        }
                        
                        const activityNameElement = detailsPage.locator('//div[contains(@class, "activity-detail_text")]/preceding-sibling::div[1]');
                        const activityName = (await activityNameElement.textContent({ timeout: 10000 })).trim();
                        const cleanedActivityName = activityName.replace(/\s*\.beast-core-ellipsis-1\{[\s\S]*?\}/g, '').trim();

                        const typeAndIdElement = detailsPage.locator('.activity-detail_text__3NhJ0');
                        const typeAndIdText = await typeAndIdElement.textContent({ timeout: 10000 });

                        let systemPushTime = "无";
                        try {
                            const timelineItemLocator = detailsPage.locator('//li[.//div[contains(text(), "系统推送商品")]]');
                            const itemText = await timelineItemLocator.innerText({ timeout: 5000 });
                            const lines = itemText.split('\n');
                            const labelIndex = lines.findIndex(line => line.trim().includes('系统推送商品'));
                            if (labelIndex !== -1 && labelIndex + 1 < lines.length) {
                                const potentialTime = lines[labelIndex + 1].trim();
                                if (/\d{4}-\d{2}-\d{2}/.test(potentialTime)) {
                                    systemPushTime = potentialTime;
                                    console.log(`    -> [文本解析成功] 找到“系统推送时间”：${systemPushTime}`);
                                } else {
                                    console.log(`    -> [文本解析] “系统推送商品”下一行内容格式不正确: "${potentialTime}"`);
                                }
                            } else {
                                console.log("    -> [文本解析] 未在活动进度中找到“系统推送商品”或其后续行。");
                            }
                        } catch (timeError) {
                            console.log("    -> 未找到包含“系统推送商品”的活动进度项，将标记为 '无'。");
                        }
                        
                        const idMatch = typeAndIdText.match(/活动ID:\s*(\d+)/);
                        const activityId = idMatch ? idMatch[1].trim() : '未找到';
                        const textParts = typeAndIdText.split('|').map(p => p.trim());
                        const activityType = textParts.length > 0 ? textParts[0] : '未找到';
                        
                        // ======================= [修改4 - 开始] =======================
                        const singleResult = {
                            ...product,
                            [PRODUCT_ID_COLUMN_HEADER]: String(product[PRODUCT_ID_COLUMN_HEADER]),
                            '登记日期': registrationDate,
                            '活动状态': target.status, // 新增活动状态列
                            '活动ID': activityId,
                            '活动名称': cleanedActivityName,
                            '活动类型': activityType, 
                            '系统推送时间': systemPushTime
                        };
                        // ======================= [修改4 - 结束] =======================
                        
                        console.log('    --- [抓取结果预览] ---');
                        console.log(`      登记日期: ${singleResult['登记日期']}`);
                        console.log(`      商品ID: ${singleResult[PRODUCT_ID_COLUMN_HEADER]}`);
                        console.log(`      活动状态: ${singleResult['活动状态']}`);
                        console.log(`      活动ID: ${singleResult['活动ID']}`);
                        console.log(`      系统推送时间: ${singleResult['系统推送时间']}`);
                        console.log('    ------------------------');
                        
                        allResults.push(singleResult);
                        console.log(`    -> 第 ${i + 1} 条记录抓取成功。`);
                        
                    } catch (innerError) {
                        if (innerError.message.includes('Target page, context or browser has been closed')) {
                            console.error(`  ❌ [处理中断] 因目标页面已关闭，无法继续处理商品ID [${productId}] 的剩余记录。将跳至下一个商品。`);
                            break;
                        }

                        if (innerError instanceof errors.TimeoutError) {
                            console.error(`  ❌ [处理失败] 第 ${i + 1} 条记录无法正常打开或处理超时。将跳过此条记录。`);
                        } else {
                            console.error(`  ❌ [处理失败] 处理第 ${i + 1} 条记录时出错: ${innerError.message}`);
                        }
                    } finally {
                        if (detailsPage && !detailsPage.isClosed()) {
                            await detailsPage.close();
                            console.log('    -> 详情页面已关闭。');
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ [严重错误] 处理商品ID ${productId} 的搜索阶段出错: ${error.message}`);
                console.error(' -> 将跳过这个商品，继续下一个。');
            } finally {
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
            }
        }
    }
    // ======================= [修改3 - 结束] =======================
    console.log('\n--- 所有商品ID和状态已处理完毕！---');
    await context.close();
    console.log('浏览器已关闭。');
    
    await saveResultsToCsv(allResults, outputCsvPath);
    await saveResultsToDb(allResults, DB_PATH);
    
    console.log('\n🎉 脚本所有任务执行完毕！');
}

main();