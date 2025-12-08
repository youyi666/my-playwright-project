// =================================================================
// 淘系平台 价格/主图 监控脚本 (v10.4 - Upsert版)
//
// 更新日志 (v10.4):
// 1. [核心功能] 实现UPSERT逻辑。当同一天内多次运行时，新价格会覆盖旧价格。
// 2. [SQL优化] 修改 insertRecord 函数中的SQL语句，使用 ON CONFLICT(...) DO UPDATE
//    来自动处理记录的插入或更新，确保每日数据的唯一性和最新性。
// =================================================================

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const XLSX = require('xlsx');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

chromium.use(stealth);

// --- 配置区 (无改动) ---
const EXCEL_TASK_FILE_PATH = 'Z:\\平台价格监控\\products.xlsx';
const DB_OUTPUT_PATH = 'Z:\\平台价格监控\\Results\\prices.db';
const AUTH_FILE_PATH = 'C:\\Users\\Administrator\\my-playwright-project\\auth.json';
// ... 其他配置无改动 ...
const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const PLATFORM_NAME = "淘系";
const SCRAPE_MAIN_IMAGE = false; 
const PAUSE_AFTER_N_ITEMS = 50; 
const PAUSE_DURATION_MINUTES = 10; 
const PRICE_SELECTOR = 'div[class*="highlightPrice--"] span[class^="text--"]';
const MAIN_PIC_SELECTOR = 'img[class*="mainPic--"]';
const THUMBNAIL_PICS_SELECTOR = 'div[class*="thumbnails--"] img[class*="thumbnailPic--"]';


// --- 数据库辅助函数 (setupDatabase 无改动) ---
let db;
function setupDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = require('path').dirname(DB_OUTPUT_PATH);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        db = new sqlite3.Database(DB_OUTPUT_PATH, (err) => {
            if (err) { reject(err); }
            else { console.log("成功连接到SQLite数据库。"); resolve(); }
        });
        db.run(`
            CREATE TABLE IF NOT EXISTS price_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT, Platform TEXT, URL TEXT, SKU_Identifier TEXT,
                Price TEXT, Scrape_Date TEXT, Main_Image_URL TEXT,
                UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
            )
        `, (err) => { if (err) reject(err); });
    });
}

function insertRecord(record) {
    return new Promise((resolve, reject) => {
        // ★★★ 核心改动：修改SQL语句以实现UPSERT ★★★
        const sql = `
            INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) DO UPDATE SET
                Price = excluded.Price,
                Main_Image_URL = excluded.Main_Image_URL
        `;
        const params = [ record.Platform, record.URL, record.SKU_Identifier, record.Price, record.Scrape_Date, record.Main_Image_URL || null ];
        db.run(sql, params, function(err) {
            if (err) {
                console.error('   数据库写入失败:', err.message);
                reject(err);
            } else {
                // this.changes 会在 INSERT 时返回 1，在 UPDATE 时也可能返回 1
                resolve(this.changes);
            }
        });
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 主函数 main() (内容无改动) ---
async function main() {
    console.log(`--- 淘系监控脚本 (v10.4 - Upsert版) 启动 ---`);
    // ... main 函数的其余所有逻辑保持不变 ...
    if (!fs.existsSync(AUTH_FILE_PATH)) {
        console.error(`致命错误: 登录文件 ${AUTH_FILE_PATH} 未找到！`);
        return;
    }

    await setupDatabase();
    console.log(`[PREP] 数据库 '${DB_OUTPUT_PATH}' 已准备就绪。`);
    
    let tasksToRun;
    try {
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        tasksToRun = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        console.log(`[1/4] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${tasksToRun.length} 条任务。`);
    } catch (error) {
        console.error(`错误: 无法读取任务文件 '${EXCEL_TASK_FILE_PATH}'。`, error);
        return;
    }
    
    const platformTasks = tasksToRun.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if(platformTasks.length === 0) {
        console.log("任务文件中没有找到需要处理的平台，脚本结束。");
        return;
    }
    console.log(`   筛选出 ${platformTasks.length} 条 “${PLATFORM_NAME}” 平台的任务。`);


    let browser;
    const todayStr = new Date().toISOString().split('T')[0];
    const newRecordsThisSession = [];

    try {
        console.log("[2/4] 正在启动“隐身”浏览器并加载登录状态...");
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({ storageState: AUTH_FILE_PATH });
        const page = await context.newPage();
        if (!SCRAPE_MAIN_IMAGE) {
            await page.route('**/*.{png,jpg,jpeg,gif,svg}', route => route.abort());
        }
        console.log("SUCCESS: 浏览器启动成功，登录状态已加载。");
        
        console.log("\n   正在执行浏览器预热：访问淘宝首页以稳定会话...");
        try {
            await page.goto('https://www.taobao.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(3000); 
            console.log("   预热完成，会话已激活。\n");
        } catch (warmupError) {
            console.warn(`   警告: 浏览器预热失败 (不影响主流程): ${warmupError.message.split('\n')[0]}\n`);
        }
        
        console.log(`[3/4] 开始处理商品... (日期: ${todayStr})`);
        for (const [index, task] of platformTasks.entries()) {
            
            const url = task[URL_COLUMN_HEADER];
            if (!url || typeof url !== 'string' || !url.startsWith('http')) {
                console.log(`--- 跳过第 ${index + 1} 行: URL无效 ---`);
                continue;
            }

            console.log(`--- 正在处理第 ${index + 1}/${platformTasks.length} 行: ${url.substring(0, 50)}... ---`);
            
            const newRecord = {
                Platform: task[PLATFORM_COLUMN_HEADER], URL: url, SKU_Identifier: 'default',
                Price: 'Error', Scrape_Date: todayStr, Main_Image_URL: null
            };
            
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`   INFO: 价格未找到，执行重试 (第 ${attempt}/2 次尝试)...`);
                        await sleep(2000); // 重试前等待2秒
                    }

                    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
                    
                    try {
                        let priceText = "Not Found";
                        const finalPriceLocator = page.locator('[aria-label^="到手价"]');
                        const regularPriceLocator = page.locator('[aria-label^="￥"]');
                        const cssFallbackLocator = page.locator(PRICE_SELECTOR).first();
                        if (await finalPriceLocator.count() > 0) {
                            console.log("   -> 方案A: 成功检测到'到手价' aria-label...");
                            const priceAriaLabel = await finalPriceLocator.first().getAttribute('aria-label');
                            const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
                            if (priceMatch) priceText = priceMatch[0];
                        } else if (await regularPriceLocator.count() > 0) {
                            console.log("   -> 方案B: 成功检测到'￥' aria-label...");
                            const priceAriaLabel = await regularPriceLocator.first().getAttribute('aria-label');
                            const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
                            if (priceMatch) priceText = priceMatch[0];
                        } else if (await cssFallbackLocator.count() > 0) {
                            console.log("   -> 方案C: aria-label未找到, 启用CSS后备方案...");
                            priceText = (await cssFallbackLocator.textContent({ timeout: 5000 })).trim();
                        }
                        if (priceText !== "Not Found") {
                            const parsedPrice = parseFloat(priceText.replace(/,/g, '')) || priceText;
                            newRecord.Price = String(parsedPrice);
                            console.log(`   ✅ 价格: ${newRecord.Price}`);
                        } else {
                             console.log(`   ❌ 价格未找到。`);
                             newRecord.Price = "Not Found";
                        }
                    } catch (e) {
                        console.log(`   ❌ 获取价格时发生意外错误: ${e.message}`);
                        newRecord.Price = "Error";
                    }

                    if (newRecord.Price !== "Not Found" && newRecord.Price !== "Error") {
                        if (SCRAPE_MAIN_IMAGE) {
                            // 主图抓取逻辑
                        }
                    }

                } catch (pageError) {
                    console.error(`   页面处理失败 (尝试 ${attempt}/2): ${pageError.message.split('\n')[0]}`);
                    newRecord.Price = "Page Error";
                    if (pageError.message.includes('Target closed')) {
                         throw new Error("浏览器标签页或浏览器已关闭！脚本将终止。");
                    }
                    break;
                }
                
                if (newRecord.Price !== "Not Found") {
                    break;
                }
            }
            
            newRecordsThisSession.push(newRecord);

            if ((index + 1) % PAUSE_AFTER_N_ITEMS === 0 && platformTasks.length > (index + 1)) {
                 console.log("\n" + "=".repeat(60));
                 console.log(`   INFO: 已连续处理 ${PAUSE_AFTER_N_ITEMS} 个商品，将自动休眠 ${PAUSE_DURATION_MINUTES} 分钟。`);
                 const resumeTime = new Date(Date.now() + PAUSE_DURATION_MINUTES * 60000);
                 console.log(`         预计恢复时间: ${resumeTime.toLocaleTimeString('it-IT')}`);
                 console.log("=".repeat(60) + "\n");
                 await sleep(PAUSE_DURATION_MINUTES * 60 * 1000);
                 console.log("--- INFO: 休眠结束，继续执行任务 ---\n");
            }
        }
    } catch (e) {
        console.error("\n--- 任务循环中发生严重错误 ---", e.message);
    } finally {
        if (browser) {
            console.log("\n[4/4] 所有商品处理完毕，正在关闭浏览器并准备写入数据库...");
            await browser.close();

            let recordsAffected = 0;
            console.log(`   准备将 ${newRecordsThisSession.length} 条记录写入或更新到数据库...`);
            for (const record of newRecordsThisSession) {
                const changes = await insertRecord(record);
                if (changes > 0) recordsAffected++;
            }
            
            db.close();
            console.log(`🎉🎉🎉 任务完成，本轮共新增或更新了 ${recordsAffected} 条记录。`);
            console.log(`✅ 所有结果已更新到数据库 '${DB_OUTPUT_PATH}' 中。`);
        }
    }
}

if (require.main === module) {
    main();
}