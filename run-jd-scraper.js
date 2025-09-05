// 文件名: run-jd-scraper.js
// ================================================================================
// 京东平台 价格监控脚本 (v13.0 - 真实路径导航版)
//
// 更新日志 (v13.0):
// 1. [核心策略] 放弃直接访问商品URL的模式，避免被识别为机器人。
// 2. [功能增强] 新增模拟真实用户路径：访问首页 -> 搜索关键词 -> 点击商品链接。
// 3. [依赖变更] 脚本现在依赖 Excel 文件中新增的 "Keyword" 列。
// 4. [健壮性] 增加了对搜索结果是否存在、链接是否能点击的判断。
// ================================================================================
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');

// (辅助函数 randomDelay, simulateHumanScrolling 与上一版相同)
function randomDelay(min, max) {
    const delay = Math.random() * (max - min) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}
async function simulateHumanScrolling(page) {
    console.log("      └─ 模拟滚动...");
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = document.body.scrollHeight / 2;
            const timer = setInterval(() => {
                const scrollHeight = window.pageYOffset;
                window.scrollBy(0, 10);
                totalHeight += 10;
                if (totalHeight >= distance || scrollHeight === window.pageYOffset) {
                    clearInterval(timer);
                    resolve();
                }
            }, 30);
        });
    });
}

// ============================================================================
// --- 配置区 ---
// ============================================================================
const EXCEL_TASK_FILE_PATH = 'Z:\\平台价格监控\\products.xlsx';
const DB_OUTPUT_PATH = 'Z:\\平台价格监控\\Results\\prices.db';
const AUTH_FILE_PATH = path.join(__dirname, 'jd-auth.json');
const HEADLESS_MODE = false;

const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const PLATFORM_NAME = "京东";
const KEYWORD_COLUMN_HEADER = "Keyword"; // 新增 Keyword 列的配置

// (setup_database 和 save_results_to_db 函数与之前版本完全相同)
function setup_database(dbPath) { /* ... same as before ... */ }
async function save_results_to_db(dbPath, newRecords) { /* ... same as before ... */ }
// --- Hiding unchanged functions for brevity ---
function setup_database(dbPath){const outputDir=path.dirname(dbPath);if(!fs.existsSync(outputDir)){fs.mkdirSync(outputDir,{recursive:!0});console.log(`   创建了新目录: ${outputDir}`)}const db=new sqlite3.Database(dbPath);db.serialize(()=>{db.run(`
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
        `)});db.close()}async function save_results_to_db(dbPath,newRecords){if(!newRecords||newRecords.length===0){console.log("   没有新的记录需要保存。");return}const db=new sqlite3.Database(dbPath);const sql_upsert=`
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
        VALUES ($Platform, $URL, $SKU_Identifier, $Price, $Scrape_Date, $Main_Image_URL)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price;
    `;return new Promise((resolve,reject)=>{db.serialize(()=>{db.run('BEGIN TRANSACTION');const stmt=db.prepare(sql_upsert);let successCount=0;for(const record of newRecords){const params={$Platform:record.Platform,$URL:record.URL,$SKU_Identifier:record.SKU_Identifier,$Price:record.Price,$Scrape_Date:record.Scrape_Date,$Main_Image_URL:record.Main_Image_URL,};stmt.run(params,function(err){if(!err&&this.changes>0)successCount++})}stmt.finalize();db.run('COMMIT',(err)=>{if(err){db.run('ROLLBACK');reject(err)}else{console.log(`   数据库操作成功: ${successCount} 条记录被插入或更新。`);resolve(successCount)}})});db.close()})}


/**
 * 主执行函数
 */
async function main() {
    console.log(`--- 京东监控脚本 (v13.0 - 真实路径导航版) 启动 ---`);

    // (初始化、读取Excel、筛选任务等步骤与之前版本完全相同)
    setup_database(DB_OUTPUT_PATH);
    console.log(`[PREP] 数据库 '${DB_OUTPUT_PATH}' 已准备就绪。`);
    
    let all_tasks = [];
    try {
        const workbook = xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        all_tasks = xlsx.utils.sheet_to_json(worksheet);
        console.log(`[1/4] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${all_tasks.length} 条总任务。`);
    } catch (error) { console.log(`错误: 读取任务文件时出错: ${error.message}`); return; }

    const tasks_to_run = all_tasks.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    if (tasks_to_run.length === 0) { console.log(`任务文件中没有找到平台为“${PLATFORM_NAME}”的任务，脚本结束。`); return; }
    console.log(`   筛选出 ${tasks_to_run.length} 条 “${PLATFORM_NAME}” 平台的任务。`);
    
    if (!fs.existsSync(AUTH_FILE_PATH)) { console.error(`\n❌ 致命错误: 登录状态文件未找到！请先运行 jd-setup-auth.js`); return; }
    console.log("✅ 登录状态文件已找到。");

    const today_str = new Date().toISOString().split('T')[0];
    const new_records_this_session = [];
    let browser;

    try {
        console.log("[2/4] 正在启动浏览器并加载登录状态...");
        browser = await chromium.launch({ headless: HEADLESS_MODE });
        const context = await browser.newContext({
            storageState: AUTH_FILE_PATH,
            viewport: { width: 1920, height: 1080 }, // 添加了固定的分辨率
            locale: 'zh-CN',
        });
        const page = await context.newPage();
        console.log("SUCCESS: 浏览器已启动并成功加载登录状态。\n");

        console.log(`[3/4] 开始处理商品... (日期: ${today_str})`);
        for (const [index, task] of tasks_to_run.entries()) {
            const url = task[URL_COLUMN_HEADER];
            const keyword = task[KEYWORD_COLUMN_HEADER]; // 获取搜索关键词

            // --- 检查任务有效性 ---
            if (typeof url !== 'string' || !url.startsWith('http')) {
                console.log(`--- 跳过第 ${index + 1} 行: URL '${url}' 无效 ---`);
                continue;
            }
            if (!keyword) {
                console.log(`--- 跳过第 ${index + 1} 行: URL '${url}' 的 Keyword 为空 ---`);
                continue;
            }
            
            console.log(`--- 正在处理第 ${index + 1}/${tasks_to_run.length} 项: [${keyword}] ---`);
            
            const new_record = { /* ... a lot of same code ... */ };
            Object.assign(new_record, { Platform: task[PLATFORM_COLUMN_HEADER], URL: url, SKU_Identifier: 'default', Price: 'Error', Scrape_Date: today_str, Main_Image_URL: null });

            try {
                // ==========================================================
                // --- 核心修改区域 START: 模拟真实用户路径 ---
                // ==========================================================
                console.log(`   [导航] 1. 正在访问京东首页...`);
                await page.goto('https://www.jd.com/', { waitUntil: 'domcontentloaded' });
                await randomDelay(1000, 3000);

                console.log(`   [导航] 2. 在搜索框中输入: "${keyword}"`);
                await page.locator('#key').fill(keyword);
                await randomDelay(500, 1500);

                console.log(`   [导航] 3. 点击搜索按钮...`);
                await page.locator('button[aria-label="搜索"]').click();
                
                // 等待搜索结果页面加载
                await page.waitForURL('**/search.jd.com/**', { timeout: 20000 });
                console.log(`   [导航] 4. 搜索结果页面已加载.`);
                
                // 从目标URL中提取SKU ID，用于在搜索结果中精确定位
                const skuMatch = url.match(/(\d+)\.html/);
                if (!skuMatch) throw new Error("无法从URL中提取SKU ID");
                const sku = skuMatch[1];
                
                console.log(`   [导航] 5. 在结果中查找SKU为 ${sku} 的商品并点击...`);
                const productLink = page.locator(`a[href*="${sku}"]`).first();
                
                // 等待链接可见并点击
                await productLink.waitFor({ state: 'visible', timeout: 15000 });
                await productLink.click();
                
                // 等待新页面（商品详情页）加载完成
                // 注意: Playwright的click会自动等待导航完成，这里我们额外等待网络空闲
                await page.waitForLoadState('networkidle', { timeout: 20000 });
                console.log(`   [导航] 6. 商品详情页加载成功!`);
                // ==========================================================
                // --- 核心修改区域 END ---
                // ==========================================================

                // (模拟人类行为: 等待和滚动)
                console.log("   [动作] 开始模拟人类行为...");
                console.log("      ├─ 随机等待 (1.5s-3.5s)...");
                await randomDelay(1500, 3500);
                await simulateHumanScrolling(page);
                console.log("      └─ 随机等待 (1.0s-2.5s)...");
                await randomDelay(1000, 2500);
                
                let final_price = "Not Found";
                // (后续的价格抓取逻辑与之前版本完全相同)
                let price_found_by_css = false;
                const selectors_to_try=[{selector:"#J_FinalPrice .price",type:"促销价"},{selector:".J-presale-price",type:"预售价"},{selector:".p-price .price",type:"日常价"}];
                for(const{selector:selector,type:type}of selectors_to_try){try{const price_text=await page.locator(selector).first().textContent({timeout:2e3});if(price_text?.trim()){final_price=price_text.trim();console.log(`   [OK] 价格 (${type}定位): ${final_price}`);price_found_by_css=!0;break}}catch(error){continue}}
                if(!price_found_by_css){console.log("   INFO: 所有CSS定位失败, 启动最终方案 (源码解析)...");try{const page_source=await page.content();const match=page_source.match(/var pageConfig = ({.*?});/s);if(match&&match[1]){const json_str=match[1].replace(/\/\/.*$/gm,"");const page_data=JSON.parse(json_str);const price=page_data?.price?.p;if(price){final_price=price;console.log(`   [OK] 价格 (源码解析): ${final_price}`)}else{final_price="Not Found (Config)"}}else{final_price="Not Found (Config)"}}catch(e){final_price="Error (Source Parse)"}}
                new_record.Price = final_price;

            } catch (error) {
                console.log(`   [ERROR] 页面处理失败: ${error.message.split('\n')[0]}`);
                new_record.Price = "Navigation Error"; // 标记为导航错误
            }
            new_records_this_session.push(new_record);
            
            // 处理完一个商品后，进行一个较长的随机等待
            console.log("   [间隔] 单个任务完成, 进入较长随机等待 (15s-45s)...");
            await randomDelay(15000, 45000);

        }
    } catch (error) {
        console.log(`\n--- 任务循环中发生严重错误 ---: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
            console.log("\n浏览器已自动关闭。");
        }
    }
    
    console.log("\n[4/4] 正在执行最终保存操作...");
    await save_results_to_db(DB_OUTPUT_PATH, new_records_this_session);
    console.log(`[SUCCESS] 脚本执行完毕。`);
}

main().catch(console.error);