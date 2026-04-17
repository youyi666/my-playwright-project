// ================= [环境初始化与依赖] =================
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const exceljs = require('exceljs');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

// ================= [全局配置区] =================
const HEADLESS_MODE = false; 
const BASE_DIR = __dirname;
const JD_USER_DATA_DIR = path.join(BASE_DIR, 'browser_profiles', 'jd_api_store');
const ERROR_SCREENSHOT_DIR = path.join(BASE_DIR, 'error_screenshots');

// 路径请根据实际情况调整
const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, 'tasks.xlsx');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const CENTRAL_DB_PATH = 'D:\\WorkSpace\\00_Shared_Database数据库\\TmallDataCenter.db'; 
let DB_PATH = CENTRAL_DB_PATH;

if (!fs.existsSync(ERROR_SCREENSHOT_DIR)) {
    fs.mkdirSync(ERROR_SCREENSHOT_DIR, { recursive: true });
}

// ================= [全局抓包状态管理器] =================
// 用于在同一页面拦截器中区分是“批量搜索模式”还是“单品兜底模式”
const scrapeState = {
    mode: 'bulk',          // 'bulk' 或 'single'
    bulkMap: new Map(),    // 存储搜索页抓取到的 { skuId: price }
    currentTarget: null,   // 单品模式下正在寻找的 SKU
    capturedPrice: null    // 单品模式下抓到的价格
};

// ================= [基础工具与数据库交互] =================

function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

function get_completed_skus_from_db() {
    const completed = new Set();
    try {
        if (!fs.existsSync(DB_PATH)) return completed;
        const db = new Database(DB_PATH, { readonly: true });
        const today_str = DateTime.now().toFormat('yyyy-MM-dd');
        
        const stmt = db.prepare(`
            SELECT sku_id FROM price_history 
            WHERE record_time LIKE ? AND platform = '京东' 
            AND status NOT LIKE '%错误%' AND status NOT LIKE '%失败%'
        `);
        const rows = stmt.all(`${today_str}%`);
        rows.forEach(row => { if (row.sku_id) completed.add(row.sku_id); });
        db.close();
    } catch (e) {}
    return completed;
}

function save_results_to_db(records) {
    if (!records || records.length === 0) return;
    try {
        const db = new Database(DB_PATH);
        const createTableStmt = `
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, url TEXT, product_name TEXT, sku_id TEXT, true_sku_id TEXT,
                price REAL, limit_price REAL, status TEXT, record_time DATETIME, screenshot_path TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;
        db.exec(createTableStmt);

        const insertStmt = db.prepare(`
            INSERT INTO price_history 
            (platform, url, product_name, sku_id, true_sku_id, price, limit_price, status, record_time, screenshot_path)
            VALUES (@Platform, @URL, @Product_Name, @SKU_Identifier, @True_SKU_Identifier, @Price, @Limit_Price, @Price_Status, @Scrape_Date, @Main_Image_URL)
        `);
        
        const insertMany = db.transaction((data) => {
            for (const row of data) {
                let safePrice = typeof row.Price === 'number' ? row.Price : parsePriceToFloat(row.Price);
                let safeLimit = parsePriceToFloat(row.Limit_Price);

                insertStmt.run({
                    Platform: row.Platform, URL: row.URL, Product_Name: row.Product_Name || '',
                    SKU_Identifier: row.SKU_Identifier, True_SKU_Identifier: row.True_SKU_Identifier,
                    Price: safePrice, Limit_Price: safeLimit, Price_Status: row.Price_Status,
                    Scrape_Date: row.Scrape_Date, Main_Image_URL: row.Main_Image_URL
                });
            }
        });
        insertMany(records);
        db.close();
        console.log(`✅ [落库] 成功将 ${records.length} 条数据同步至中央数据库。`);
    } catch (e) {
        console.error(`❌ [落库] 写入失败: ${e.message}`);
    }
}

function append_results_to_csv(records) {
    if (!records || records.length === 0) return;
    let csvContent = "";
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        fs.writeFileSync(CSV_OUTPUT_PATH, "\uFEFFPlatform,URL,Product_Name,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n", 'utf8');
    }
    records.forEach(r => {
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return "";
            const str = String(field).replace(/"/g, '""');
            if (str.search(/("|,|\n|\r)/g) >= 0) return `"${str}"`;
            return str;
        };
        csvContent += [
            escapeCsv(r.Platform), escapeCsv(r.URL), escapeCsv(r.Product_Name), escapeCsv(r.SKU_Identifier),
            escapeCsv(r.True_SKU_Identifier), escapeCsv(r.Price), escapeCsv(r.Limit_Price),
            escapeCsv(r.Price_Status), escapeCsv(r.Scrape_Date), escapeCsv(r.Main_Image_URL)
        ].join(",") + "\n";
    });
    fs.appendFileSync(CSV_OUTPUT_PATH, csvContent, 'utf8');
}

// ================= [解析器核心] =================

// 批量提取 (阶段一使用 - 放宽条件版)
function extractBulkPricesFromJSON(obj, resultsMap) {
    if (Array.isArray(obj)) {
        for (let item of obj) extractBulkPricesFromJSON(item, resultsMap);
    } else if (obj !== null && typeof obj === 'object') {
        
        // 只要有 sku 就可以尝试找价格
        if (obj.sku) {
            let capturedPrice = null;
            
            // 优先级1：大促预估到手价
            if (obj.finalPrice && obj.finalPrice.estimatedPrice) {
                capturedPrice = obj.finalPrice.estimatedPrice;
            } 
            // 优先级2：普通标价 (通常在 obj.price.p 或者直接外层有价格属性)
            else if (obj.price && obj.price.p) {
                capturedPrice = obj.price.p;
            }

            // 如果找到了任意一种价格，就存入字典
            if (capturedPrice) {
                resultsMap.set(String(obj.sku), capturedPrice);
            }
        }
        
        // 继续向下递归，以防数据嵌套在更深层
        for (let key in obj) {
            if (typeof obj[key] === 'object') {
                extractBulkPricesFromJSON(obj[key], resultsMap);
            }
        }
    }
}

// 单个提取 (阶段二使用)
function extractSinglePriceFromJSON(obj, targetSku) {
    let result = null;
    function search(currentObj) {
        if (result) return; 
        if (Array.isArray(currentObj)) {
            for (let item of currentObj) search(item);
        } else if (currentObj !== null && typeof currentObj === 'object') {
            if (String(currentObj.sku) === String(targetSku) && currentObj.finalPrice && currentObj.finalPrice.estimatedPrice) {
                result = currentObj.finalPrice.estimatedPrice;
                return;
            }
            for (let key in currentObj) search(currentObj[key]);
        }
    }
    search(obj);
    return result;
}

// 模拟拟人化滚动
async function simpleScroll(page) {
    try {
        const width = await page.evaluate(() => window.innerWidth).catch(()=>1200);
        const height = await page.evaluate(() => window.innerHeight).catch(()=>800);
        await page.mouse.move(Math.random() * (width / 2), Math.random() * (height / 2), { steps: 5 });
        
        // 缓慢向下滚动到底部以触发懒加载 API
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0, distance = 300;
                let timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
                        clearInterval(timer); resolve();
                    }
                }, 300); 
            });
        });
        await page.waitForTimeout(2000);
    } catch (e) {}
}

// ================= [主控制器] =================

async function main() {
    console.log(`\n=============================================`);
    console.log(`🚀 [终极架构] 启动京东两级降级抓取策略`);
    console.log(`=============================================`);

    const completedSkus = get_completed_skus_from_db();
    let all_tasks = [];
    let final_results = [];

    // --- 1. 读取 Excel 任务 ---
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 
        let switchColIndex = -1;
        worksheet.getRow(1).eachCell((c, i) => { if (c.text === '[T]') switchColIndex = i; });

        worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
            if (rowNum === 1) return; 
            if (switchColIndex !== -1 && row.getCell(switchColIndex).value != 1) return;
            if (row.getCell(1).text?.trim() !== "京东") return;

            let finalUrl = row.getCell(4).value;
            if (typeof finalUrl === 'object' && finalUrl?.hyperlink) finalUrl = finalUrl.hyperlink;
            finalUrl = String(finalUrl).trim();
            if (/^\d+$/.test(finalUrl)) finalUrl = `https://item.jd.com/${finalUrl}.html`;

            let trueSkuId = "N/A";
            const match = finalUrl.match(/\/(\d+)\.html/) || finalUrl.match(/sku=(\d+)/);
            if (match) trueSkuId = match[1];

            const barcode = row.getCell(2).text?.trim() || 'N/A';
            if (!completedSkus.has(barcode)) {
                all_tasks.push({
                    url: finalUrl, trueId: trueSkuId, barcode: barcode,
                    productName: row.getCell(3).text?.trim() || 'N/A',
                    limitPrice: parsePriceToFloat(row.getCell(7).value)
                });
            }
        });
        console.log(`📊 [初始化] 待处理任务共 ${all_tasks.length} 个。`);
    } catch (e) { return console.error(`❌ 读取任务失败: ${e.message}`); }

    if (all_tasks.length === 0) return console.log(`🎉 今日任务均已完成！`);

    // --- 启动浏览器与拦截器 ---
    let browser = null;
    try {
        browser = await chromium.launchPersistentContext(JD_USER_DATA_DIR, {
            channel: 'msedge', headless: HEADLESS_MODE, viewport: null, 
            ignoreDefaultArgs: ["--enable-automation"],
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });
        const page = browser.pages()[0] || await browser.newPage();

        // 统一网络拦截器
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('api.m.jd.com') || url.includes('p.3.cn/prices/mgets')) {
                try {
                    const text = await response.text();
                    if (text.startsWith('{') || text.startsWith('[')) {
                        const jsonData = JSON.parse(text);
                        if (scrapeState.mode === 'bulk') {
                            extractBulkPricesFromJSON(jsonData, scrapeState.bulkMap);
                        } else if (scrapeState.mode === 'single' && scrapeState.currentTarget) {
                            const found = extractSinglePriceFromJSON(jsonData, scrapeState.currentTarget);
                            if (found) scrapeState.capturedPrice = found;
                        }
                    }
                } catch (e) {}
            }
        });

        // ==========================================
        // 🌊 阶段一：搜索页批量打捞 (Bulk Scraping)
        // ==========================================
        console.log(`\n🌊 [阶段一] 启动大规模搜索打捞...`);
        scrapeState.mode = 'bulk';
        const SEARCH_KEYWORD = "云米";
        const MAX_PAGES = 5; 

        const searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(SEARCH_KEYWORD)}&enc=utf-8`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 登录防御墙
        if (page.url().includes('passport.jd.com')) {
            console.log("🛑 触发登录拦截，请扫码...");
            await page.waitForURL(url => !url.toString().includes('passport.jd'), { timeout: 0 });
            await page.waitForTimeout(3000);
        }

        for (let cp = 1; cp <= MAX_PAGES; cp++) {
            console.log(`   📄 正在深度扫描第 ${cp} 页...`);
            
            // 1. 模拟人类浏览到底部，触发本页底部的 API 加载
            await simpleScroll(page); 
            await page.waitForTimeout(2000); // 必须等待滚动后的 API 返回
            
            if (cp < MAX_PAGES) {
                // [核心修复1] 纯文本定位：屏蔽动态 Hash，精确匹配文字为“下一页”的元素
                const nextBtn = page.locator('a, div, span, button').filter({ hasText: /^下一页$/ }).last();
                
                if (await nextBtn.isVisible({ timeout: 3000 }).catch(()=>false)) {
                    console.log(`   👆 发现 [下一页] 按钮，执行点击...`);
                    await nextBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(800);
                    
                    // force: true 可以无视一些透明的广告遮挡层，强行按下
                    await nextBtn.click({ force: true });
                    
                    console.log(`   ⏳ 等待页面刷新加载...`);
                    await page.waitForTimeout(4500); 
                } else {
                    console.log(`   ⚠️ 未能通过 DOM 找到按钮。触发 [URL底层直达] 备用方案...`);
                    
                    // [核心修复2] URL 数学计算兜底：京东页码规律 1 -> 3 -> 5
                    const targetPageNum = (cp + 1) * 2 - 1; 
                    const directUrl = `${searchUrl}&page=${targetPageNum}`;
                    
                    await page.goto(directUrl, { waitUntil: 'domcontentloaded' });
                    // 给 API 加载留出缓冲时间
                    await page.waitForTimeout(4000);
                }
            }
        }
        console.log(`🎯 [打捞完毕] 成功从底层数据包捕获 ${scrapeState.bulkMap.size} 个商品的预估价！`);

        // ==========================================
        // ⚖️ 阶段二：内存比对与精准分流
        // ==========================================
        const missing_tasks = [];
        
        all_tasks.forEach(task => {
            if (scrapeState.bulkMap.has(task.trueId)) {
                // 秒级匹配成功
                const capturedPrice = scrapeState.bulkMap.get(task.trueId);
                let status = "价格正常";
                const numPrice = parseFloat(capturedPrice);
                
                if (task.limitPrice && !isNaN(numPrice)) {
                    if (numPrice < task.limitPrice * 0.97) status = "破价警报";
                    else if (numPrice > task.limitPrice) status = "高价待调整";
                }
                
                console.log(`   ⚡ [秒级命中] SKU:${task.trueId} | 获取预估价: ￥${capturedPrice} | 状态: ${status}`);
                
                final_results.push({
                    Platform: "京东", URL: task.url, Product_Name: task.productName,
                    SKU_Identifier: task.barcode, True_SKU_Identifier: task.trueId,
                    Price: capturedPrice, Limit_Price: task.limitPrice, Price_Status: status,
                    Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'), Main_Image_URL: "Batch_Matched"
                });
            } else {
                // 没抓到的子 SKU，进入漏网之鱼池
                missing_tasks.push(task);
            }
        });

        // ==========================================
        // 🎯 阶段三：对漏网之鱼进行单品详情页兜底
        // ==========================================
        if (missing_tasks.length > 0) {
            console.log(`\n🔍 [阶段二] 启动兜底机制，深度访问 ${missing_tasks.length} 个未命中单品...`);
            scrapeState.mode = 'single';

            for (let i = 0; i < missing_tasks.length; i++) {
                const task = missing_tasks[i];
                console.log(`   --- 深入访问 (${i+1}/${missing_tasks.length}) SKU:${task.trueId} ---`);
                
                scrapeState.currentTarget = task.trueId;
                scrapeState.capturedPrice = null;
                let final_price = "Not Found", status = "未知";

                try {
                    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 45000, referer: "https://search.jd.com/" });
                    if (page.url().includes('passport.jd.com')) await page.waitForURL(url => !url.toString().includes('passport.jd'), { timeout: 0 });
                    
                    await simpleScroll(page);
                    await page.waitForTimeout(3000); 

                    if (scrapeState.capturedPrice) {
                        final_price = scrapeState.capturedPrice;
                        console.log(`      📡 API 深度抓取成功: ￥${final_price}`);
                    } else {
                        // DOM 节点最后兜底
                        const el = page.locator(".product-price--main, .price, .p-price").first();
                        if (await el.isVisible({timeout: 2000})) {
                            final_price = (await el.textContent()).replace(/[^\d.]/g, '');
                            console.log(`      👀 DOM 兜底获取: ￥${final_price}`);
                        }
                    }

                    if (final_price !== "Not Found") {
                        const numPrice = parseFloat(final_price);
                        if (task.limitPrice && !isNaN(numPrice)) {
                            if (numPrice < task.limitPrice * 0.97) status = "破价警报";
                            else if (numPrice > task.limitPrice) status = "高价待调整";
                            else status = "价格正常";
                        }
                    } else status = "抓取失败";

                } catch (e) {
                    console.log(`      ❌ 访问报错: ${e.message.split('\n')[0]}`);
                    final_price = "Error"; status = "脚本错误";
                }

                final_results.push({
                    Platform: "京东", URL: task.url, Product_Name: task.productName,
                    SKU_Identifier: task.barcode, True_SKU_Identifier: task.trueId,
                    Price: final_price, Limit_Price: task.limitPrice, Price_Status: status,
                    Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'), Main_Image_URL: "Detail_Matched"
                });
                
                if (i > 0 && i % 5 === 0) await page.waitForTimeout(Math.random() * 3000 + 3000);
            }
        }

    } catch (e) {
        console.error(`🚨 [致命崩溃]`, e);
        if (browser) await browser.pages()[0].screenshot({ path: path.join(ERROR_SCREENSHOT_DIR, `Crash_${Date.now()}.png`), fullPage: true }).catch(()=>{});
    } finally {
        if (browser) await browser.close();
        save_results_to_db(final_results);
        append_results_to_csv(final_results);
        console.log(`\n✅ 终极架构执行完毕！`);
    }
}

// 启动
main();