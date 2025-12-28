      
// =================================================================
// 淘系平台 价格/主图 监控脚本 (v11.4 - 识别优化与行为模拟)
//
// 更新日志 (v11.4):
// 1. [识别增强] 购买按钮选择器增加对“领券购买”文本的支持，以兼容更多商品页面。
// 2. [行为模拟] 在页面加载后、点击购买按钮前，新增3-6秒的随机等待，以模拟人类浏览行为，
//    降低被反爬虫机制检测的风险。
// =================================================================

const { chromium } = require('playwright');
const exceljs = require('exceljs');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// --- 配置区 (从 config.json 文件动态加载) ---
const BASE_DIR = path.dirname(__filename);
const config_path = path.join(BASE_DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(config_path, 'utf-8'));

const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);
const DB_OUTPUT_PATH = path.join(BASE_DIR, config.paths.db_output);
const BROWSER_EXEC_PATH = config.browser_settings.edge_executable_path;

if (!config.paths || !config.paths.taobao_user_data_dir) {
    console.error("\n[致命错误] 您的 config.json 文件中缺少 'paths.taobao_user_data_dir' 配置项。");
    console.error("这是必须的，用于存放淘宝的登录会话数据。");
    console.error("\n请在该文件的 'paths' 对象中添加此配置，例如：");
    console.error('"taobao_user_data_dir": "./user_data/taobao"\n');
    process.exit(1);
}
const TAOBAO_USER_DATA_DIR = path.join(BASE_DIR, config.paths.taobao_user_data_dir);
// --- 配置区结束 ---

const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const PLATFORM_NAME = "淘系";

// ★★★ [新增] sleep辅助函数 ★★★
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function setup_database(db_path) {
    // ... 此函数无改动 ...
    const output_dir = path.dirname(db_path);
    if (!fs.existsSync(output_dir)) {
        fs.mkdirSync(output_dir, { recursive: true });
    }
    const db = new sqlite3.Database(db_path);
    db.run(`
        CREATE TABLE IF NOT EXISTS price_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT, Platform TEXT, URL TEXT, SKU_Identifier TEXT,
            Price TEXT, Scrape_Date TEXT, Main_Image_URL TEXT,
            UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
        )
    `);
    db.close();
}

function save_results_to_db(db_path, new_records) {
    // ... 此函数无改动 ...
    if (new_records.length === 0) return;
    const db = new sqlite3.Database(db_path);
    const sql_upsert = `
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price, Main_Image_URL = excluded.Main_Image_URL;
    `;
    try {
        db.serialize(() => {
            const stmt = db.prepare(sql_upsert);
            new_records.forEach(record => {
                stmt.run(
                    record.Platform, record.URL, record.SKU_Identifier,
                    record.Price, record.Scrape_Date, record.Main_Image_URL
                );
            });
            stmt.finalize();
        });
        console.log(`   数据库操作成功: ${new_records.length} 条记录被插入或更新。`);
    } catch (e) {
        console.log(`   写入数据库时发生错误: ${e}`);
    } finally {
        db.close();
    }
}

async function checkLoginStatus(page) {
    // ... 此函数无改动 ...
    try {
        await page.goto('https://i.taobao.com/my_taobao.htm', { waitUntil: "domcontentloaded", timeout: 15000 });
        const loggedInIndicator = page.locator('.J_MyNick');
        await loggedInIndicator.waitFor({ timeout: 5000 });
        return true;
    } catch (e) {
        console.log(`   [信息] 检查登录状态时未找到用户标识，判定为未登录。`);
        return false;
    }
}

function showLoginIssueHelp() {
    // ... 此函数无改动 ...
    console.log("\n=============================================");
    console.log("          检测到可能的淘宝登录信息问题         ");
    // ...
    console.log("=============================================\n");
}

async function main() {
    console.log(`--- 淘系监控脚本 (v11.4 - 识别优化与行为模拟) 启动 ---`);
    
    setup_database(DB_OUTPUT_PATH);
    console.log(`[PREP] 数据库 '${DB_OUTPUT_PATH}' 已准备就绪。`);
    
    // ... Excel 读取逻辑无改动 ...
    let all_tasks_df;
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.getWorksheet(1);
        all_tasks_df = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            const urlCellValue = row.getCell(4).value;
            let finalUrl = '';
            if (typeof urlCellValue === 'object' && urlCellValue !== null && urlCellValue.hyperlink) {
                finalUrl = urlCellValue.hyperlink;
            } else {
                finalUrl = String(urlCellValue);
            }
            all_tasks_df.push({
                [PLATFORM_COLUMN_HEADER]: row.getCell(1).value,
                [URL_COLUMN_HEADER]: finalUrl
            });
        });
        console.log(`[1/4] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${all_tasks_df.length} 条总任务。`);
    } catch (e) {
        console.log(`致命错误: 读取任务文件 '${EXCEL_TASK_FILE_PATH}' 时出错: ${e.message}`);
        return;
    }

    const platform_tasks = all_tasks_df.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if (platform_tasks.length === 0) {
        console.log(`任务文件中没有找到平台为“${PLATFORM_NAME}”的任务，脚本结束。`);
        return;
    }
    console.log(`   筛选出 ${platform_tasks.length} 条 “${PLATFORM_NAME}” 平台的任务。`);
    
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    const new_records_this_session = [];
    
    let browser = null;
    try {
        console.log("[2/4] 正在根据配置启动专用浏览器...");
        browser = await chromium.launchPersistentContext(TAOBAO_USER_DATA_DIR, {
            executablePath: BROWSER_EXEC_PATH,
            headless: false,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
            viewport: { width: 1280, height: 800 },
            args: ['--disable-blink-features=AutomationControlled'],
            slowMo: 50
        });
        
        const page = await browser.newPage();
        console.log("SUCCESS: 专用浏览器启动并接管成功。");

        console.log("[CHECK] 正在检查淘宝登录状态...");
        const initialLoginStatus = await checkLoginStatus(page);
        
        if (!initialLoginStatus) {
            console.log("   [警告] 未检测到有效的淘宝登录状态!");
            showLoginIssueHelp();
            
            console.log("请在打开的浏览器中手动登录淘宝账号，登录完成后回到此处按回车键继续...");
            await new Promise(resolve => process.stdin.once('data', resolve));
            
            console.log("   正在刷新页面以确认登录状态...");
            await page.reload({ waitUntil: "domcontentloaded" });

            const recheckStatus = await checkLoginStatus(page);
            if (!recheckStatus) {
                console.log("   [错误] 仍然未检测到登录状态，将继续在有头模式下尝试运行，成功率可能降低。");
            } else {
                console.log("   [成功] 已检测到登录状态，将继续在有头模式下执行任务。");
            }
        } else {
            console.log("   [成功] 已检测到有效的淘宝登录状态");
            console.log("   切换到无头模式以提高效率...");
            await browser.close();
            
            browser = await chromium.launchPersistentContext(TAOBAO_USER_DATA_DIR, {
                executablePath: BROWSER_EXEC_PATH,
                headless: true,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
                viewport: { width: 1920, height: 1080 },
                args: ['--disable-blink-features=AutomationControlled']
            });
        }

        const workingPage = await browser.newPage();
        await workingPage.route('**/*.{png,jpg,jpeg,gif,svg,webp}', route => route.abort());

        console.log(`\n[3/4] 开始处理商品... (日期: ${today_str})`);
        for (let index = 0; index < platform_tasks.length; index++) {
            const task = platform_tasks[index];
            const url = task[URL_COLUMN_HEADER];
            if (typeof url !== 'string' || !url.startsWith('http')) {
                console.log(`--- 跳过第 ${index + 1} 行: URL '${url}' 无效 ---`);
                continue;
            }
            
            console.log(`--- 正在处理第 ${index + 1}/${platform_tasks.length} 行: ${url.substring(0, 60)}... ---`);
            
            let new_record = {
                'Platform': task[PLATFORM_COLUMN_HEADER], 'URL': url, 'SKU_Identifier': 'default',
                'Price': 'Error', 'Scrape_Date': today_str, 'Main_Image_URL': null
            };
            
            try {
                await workingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

                // ★★★ [新增] 模拟人类行为，增加3-6秒的随机等待 ★★★
                const randomWait = Math.random() * 3000 + 3000; // 3000ms to 6000ms
                console.log(`   [INFO] 页面加载完成，随机等待 ${Math.round(randomWait / 1000)} 秒...`);
                await sleep(randomWait);
                
                // ★★★ [修改] 增加 'text="领券购买"' 选择器 ★★★
                const buyNowButtonSelectors = [
                    'text="立即购买"',
                    'text="领券购买"',
                    '#J_LinkBuy',
                    '[class*="buyBtn"]',
                    '[class*="Buy--buyBtn"]'
                ];
                let clicked = false;
                for(const selector of buyNowButtonSelectors) {
                    try {
                        await workingPage.locator(selector).first().click({timeout: 3000});
                        console.log(`   [OK] 已点击购买按钮 (使用选择器: ${selector})。`);
                        clicked = true;
                        break;
                    } catch(e) { /* continue */ }
                }

                if (!clicked) { throw new Error("在详情页未找到“立即购买”或“领券购买”按钮。"); }
                
                console.log('   [INFO] 正在观察页面跳转或弹窗...');
                try {
                    const couponButton = workingPage.locator('//div[contains(@class, "Coupon")]//span[contains(text(), "领券")]');
                    await couponButton.waitFor({ state: 'visible', timeout: 3000 });
                    console.log('   [OK] 检测到优惠券弹窗，正在尝试点击...');
                    await couponButton.click();
                } catch (e) {
                    console.log('   [INFO] 未检测到优惠券弹窗，按正常流程继续。');
                }

                await workingPage.waitForURL(url => url.href.includes('buy.taobao.com') || url.href.includes('buy.tmall.com'), {
                    timeout: 15000
                });
                console.log(`   [OK] 已跳转到订单结算页面。`);
                
                const priceLocator = workingPage.locator('//p[text()="实付款"]/following-sibling::div//span[contains(@class, "price-integer") or contains(@class, "totalPrice_num")]');
                const priceText = await priceLocator.first().textContent({ timeout: 10000 });

                if (priceText && priceText.trim()) {
                    new_record['Price'] = priceText.trim();
                    console.log(`   [SUCCESS] 成功获取实付款价格: ${new_record['Price']}`);
                } else {
                    new_record['Price'] = "Not Found on Checkout";
                    console.log(`   [WARN] 在结算页未找到实付款价格。`);
                }

            } catch (e) {
                if (e.message.includes('SKU')) {
                     new_record['Price'] = "Need to select SKU";
                } else if (e.name === 'TimeoutError') {
                    console.log(`   [ERROR] 页面操作超时: ${e.message.split('\n')[0]}`);
                    new_record['Price'] = "Page Timeout";
                } else {
                    console.log(`   [ERROR] 页面处理失败: ${e.message.split('\n')[0]}`);
                    new_record['Price'] = "Page Error";
                }
            }
            
            new_records_this_session.push(new_record);
        }
    } catch (e) {
        console.log(`\n--- 浏览器启动或任务循环中发生严重错误 ---: ${e}`);
        showLoginIssueHelp();
    } finally {
        if (browser) {
            console.log("\n正在关闭浏览器...");
            await browser.close();
        }
        
        console.log("\n[4/4] 正在执行最终保存操作...");
        save_results_to_db(DB_OUTPUT_PATH, new_records_this_session);
        console.log(`[SUCCESS] 脚本执行完毕。本次抓取的 ${new_records_this_session.length} 条记录已成功同步至数据库。`);
    }
}

main();

    