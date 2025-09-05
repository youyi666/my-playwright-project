// =================================================================
// 小米有品多维度SKU价格追踪爬虫 (v10.0 - SQLite直写版)
//
// 更新日志 (v10.0):
// 1. [核心改造] 数据存储方式从写入Excel变更为直接写入SQLite数据库。
// 2. [依赖引入] 新增 "sqlite3" 依赖库用于操作数据库。
// 3. [智能写入] 脚本会自动连接数据库，如果表不存在则创建。每次抓取的数据都作为新行追加。
// 4. [逻辑优化] 移除了所有与 XLSX 库相关的代码，完全替换为数据库操作。
// =================================================================

const { chromium, devices } = require('playwright');
const XLSX = require('xlsx'); // 仅用于读取任务文件
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// --- 配置文件 ---
const EXCEL_TASK_FILE_PATH = 'Z:\\平台价格监控\\products.xlsx'; 
// 结果文件：所有平台的数据都将写入这个统一的数据库文件
const DB_OUTPUT_PATH = 'Z:\\平台价格监控\\Results\\prices.db';

const PLATFORM_NAME = "米家有品";
const URL_COLUMN_HEADER = "URL";
const SKU_COLUMN_HEADER = "SKUsToScrape";
const PLATFORM_COLUMN_HEADER = "Platform";

const PRICE_COLUMN_HEADER = "Price";
const DATE_COLUMN_HEADER = "Date"; // This will be the key for the Scrape_Date column in DB

// --- 数据库辅助函数 ---
let db;

function setupDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = require('path').dirname(DB_OUTPUT_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        db = new sqlite3.Database(DB_OUTPUT_PATH, (err) => {
            if (err) {
                console.error("无法连接到数据库", err.message);
                reject(err);
            }
            console.log("成功连接到SQLite数据库。");
        });

        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS price_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    Platform TEXT,
                    URL TEXT,
                    SKU_Identifier TEXT,
                    Price TEXT,
                    Scrape_Date TEXT,
                    Main_Image_URL TEXT,
                    UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
                )
            `, (err) => {
                if (err) {
                    console.error("创建表失败", err.message);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
}

function insertRecord(record) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) DO NOTHING
        `;
        const params = [
            record.Platform,
            record.URL,
            record.SKU_Identifier,
            record.Price,
            record.Scrape_Date,
            record.Main_Image_URL || null
        ];
        db.run(sql, params, function(err) {
            if (err) {
                console.error('   数据库插入失败:', err.message);
                reject(err);
            } else {
                if (this.changes > 0) {
                   // console.log(`   - 记录已插入: ${record.URL} - ${record.SKU_Identifier}`);
                }
                resolve();
            }
        });
    });
}

/**
 * 页面清理函数
 */
async function cleanupPage(page) {
    // ... (函数内容保持不变)
    console.log("   执行页面清理操作...");
    try {
        const nuisanceSelectors = [
            '#lib10-opapp-wrap',
            '.m-header-download-banner',
            '.openAppDialog'
        ];
        await page.evaluate((selectors) => {
            selectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });
        }, nuisanceSelectors);
        console.log("   页面清理完成。");
    } catch (error) {
        console.error("   页面清理时发生错误 (可忽略):", error.message);
    }
}

/**
 * 爬取单个商品页面的所有指定SKU任务
 */
async function scrapeSingleProduct(page, url, skusToScrapeStr) {
    // ... (函数内容保持不变, 只返回结果)
    const finalPrices = []; // 返回一个对象数组 [{task, price}]
    try {
        console.log(`   正在导航到: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

        await cleanupPage(page);
        
        const regularButton = page.getByText(/^立即(购买|抢购)$/).first();
        const couponButton = page.locator('[data-focusable="true"]:has-text("领券购买")');
        const noticeButton = page.getByText("到货通知").first();
        const depositButton = page.getByText(/^支付定金/).first(); 

        const buyButton = regularButton
            .or(couponButton)
            .or(noticeButton)
            .or(depositButton);

        await buyButton.waitFor({ state: 'visible', timeout: 7000 });
        await buyButton.click();
        console.log("   已点击“购买/抢购/领券/通知/定金”等主操作按钮。");

        console.log("   等待让SKU弹窗渲染...");
        await page.waitForTimeout(1500);

        const skusString = skusToScrapeStr ? String(skusToScrapeStr) : '';

        if (!skusString || skusString.trim() === '') {
             console.log("     - 无SKU指令，直接抓取当前价格...");
             const price = await grabPrice(page);
             finalPrices.push({ task: 'default', price: price });
             return finalPrices;
        }

        const tasks = skusString.split(';').map(t => t.trim());
        
        for (const task of tasks) {
            console.log(`     - 开始任务: [${task}]`);
            const clickSteps = task.split(',').map(s => s.trim());
            let taskSuccess = true;

            for (const step of clickSteps) {
                let targetText = step;
                let targetIndex = 0; 

                const match = step.match(/(.+)\[(\d+)\]$/);
                if (match) {
                    targetText = match[1].trim();
                    targetIndex = parseInt(match[2], 10);
                    console.log(`       指令解析: 文本="${targetText}", 索引=${targetIndex}`);
                }
                
                const stepLocator = page.getByText(targetText, { exact: true });

                const count = await stepLocator.count();
                if (count === 0) {
                    console.error(`       错误: 未找到选项 "${targetText}"。`);
                    taskSuccess = false;
                    break;
                }
                if (count <= targetIndex) {
                    console.error(`       错误: 找到了 ${count} 个 "${targetText}", 但您指定的索引是 ${targetIndex} (超出范围)。`);
                    taskSuccess = false;
                    break;
                }

                await stepLocator.nth(targetIndex).click({ force: true });
                console.log(`       已点击第 ${targetIndex + 1} 个 "${targetText}"`);
                await page.waitForTimeout(500);
            }

            if (taskSuccess) {
                const price = await grabPrice(page, task);
                finalPrices.push({ task: task, price: price });
            } else {
                finalPrices.push({ task: task, price: `任务'${task}'失败` });
            }
        }
    } catch (error) {
        console.error(`   处理页面 ${url} 时发生严重错误: ${error.message}`);
        return [{ task: 'all', price: `页面处理失败: ${error.message.split('\n')[0]}` }];
    }
    return finalPrices;
}

/**
 * 提取价格的辅助函数
 */
async function grabPrice(page, task = "当前") {
    // ... (函数内容保持不变)
    let priceText = "价格未找到";
    try {
        const presalePriceLocator = page.locator('[aria-label^="预售到手价"]');
        const finalPriceLocator = page.locator('[aria-label^="到手价"]');
        const regularPriceLocator = page.locator('[aria-label^="￥"]');

        let priceAriaLabel = "";
        if (await presalePriceLocator.count() > 0) {
            console.log("       -> 检测到'预售到手价'，最高优先级抓取...");
            priceAriaLabel = await presalePriceLocator.first().getAttribute('aria-label');
        } else if (await finalPriceLocator.count() > 0) {
            console.log("       -> 检测到'到手价'，优先抓取...");
            priceAriaLabel = await finalPriceLocator.first().getAttribute('aria-label');
        } else if (await regularPriceLocator.count() > 0) {
            console.log("       -> 未检测到特殊价，使用通用价格抓取...");
            priceAriaLabel = await regularPriceLocator.first().getAttribute('aria-label');
        }

        if (priceAriaLabel) {
            const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
            if (priceMatch) {
                priceText = priceMatch[0];
            }
        }
        
        console.log(`     ✓ 任务 [${task}] 成功, 获取价格: ${priceText}`);
        return priceText;
    } catch (priceError) {
        console.error(`       错误: 成功点击SKU，但获取价格失败。 - ${priceError.message}`);
        return `价格获取失败`;
    }
}

/**
 * 获取当天日期的字符串 YYYY-MM-DD
 */
function getTodayDateString() {
    return new Date().toLocaleDateString('sv-SE');
}


/**
 * 主执行函数
 */
(async () => {
    console.log(`--- “${PLATFORM_NAME}”平台监控脚本启动 (v10.0 - SQLite直写版) ---`);
    
    await setupDatabase();
    console.log(`[PREP] 数据库 '${DB_OUTPUT_PATH}' 已准备就绪。`);

    let tasksToRun;
    try {
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheetName = workbook.SheetNames[0];
        tasksToRun = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        console.log(`[1/4] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${tasksToRun.length} 条任务。`);
    } catch (error) {
        console.error(`错误: 无法读取任务文件 '${EXCEL_TASK_FILE_PATH}'。请检查文件是否存在。`);
        return;
    }
    
    const platformTasks = tasksToRun.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if(platformTasks.length === 0) {
        console.log("任务文件中没有找到需要处理的平台，脚本结束。");
        return;
    }
    console.log(`   筛选出 ${platformTasks.length} 条 “${PLATFORM_NAME}” 平台的任务。`);

    const todayStr = getTodayDateString();
    let recordsInserted = 0;

    console.log("[2/4] 正在启动浏览器...");
    const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
    const context = await browser.newContext({ ...devices['iPhone XR'] });
    const page = await context.newPage();
    console.log("   浏览器启动成功。");

    console.log(`[3/4] 开始处理商品列表 (日期: ${todayStr})...`);
    
    for (let i = 0; i < platformTasks.length; i++) {
        const task = platformTasks[i];
        
        console.log(`\n--- [${i + 1}/${platformTasks.length}] 处理中: ${task[URL_COLUMN_HEADER]} ---`);
        
        const url = task[URL_COLUMN_HEADER];
        const skus = task[SKU_COLUMN_HEADER];

        if (!url) {
            console.log("   跳过，原因: URL为空。");
            const errorRecord = {
                Platform: task[PLATFORM_COLUMN_HEADER],
                URL: url || 'N/A',
                SKU_Identifier: 'default',
                Price: 'URL为空',
                Scrape_Date: todayStr,
            };
            await insertRecord(errorRecord);
            recordsInserted++;
            continue;
        }

        const priceResults = await scrapeSingleProduct(page, String(url), skus);
        
        for (const result of priceResults) {
            const newRecord = {
                Platform: task[PLATFORM_COLUMN_HEADER],
                URL: url,
                SKU_Identifier: result.task,
                Price: result.price,
                Scrape_Date: todayStr
            };
            await insertRecord(newRecord);
            recordsInserted++;
        }
    }
    console.log("\n所有商品处理完毕。");
    console.log(`[4/4] 任务完成，共向数据库写入或更新了 ${recordsInserted} 条记录。`);
    
    await browser.close();
    db.close();
    console.log("--- 任务圆满完成 ---");
    console.log(`✅ 所有结果已更新到数据库 '${DB_OUTPUT_PATH}' 中。`);
})();