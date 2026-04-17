const { chromium } = require('playwright'); // 标准版 (JD/PDD/Youpin)
const { chromium: chromiumExtra } = require('playwright-extra');
// 增强版 (Taobao)
const stealth = require('puppeteer-extra-plugin-stealth')();
chromiumExtra.use(stealth); // 启用隐身插件

const exceljs = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
// [新增] 引入 SQLite 数据库驱动 (请确保已 npm install better-sqlite3)
const Database = require('better-sqlite3');
// ================= [全局配置区] =================

// 1. [全局控制开关] (调试与运行模式设置)
const HEADLESS_MODE = false; // true=无头后台运行, false=显示浏览器窗口

// 2. [静态路径定义] (固定目录结构)
const BASE_DIR = path.dirname(__filename);
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CSV_OUTPUT_PATH = path.join(BASE_DIR, 'price_monitoring_results.csv');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'price_screenshots');

// [迭代修改] 静态指定数据库路径，替换动态寻址逻辑
//const CENTRAL_DB_PATH = path.join(__dirname, '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');
// 注意：Windows 路径里的反斜杠 \ 在代码里要写成双反斜杠 \\ 
const CENTRAL_DB_PATH = 'D:\\WorkSpace\\03_Dev_自动化开发\\00_Shared_Database数据库\\TmallDataCenter.db';
let DB_PATH;

try {
    // 锁定 TmallDataCenter.db 的绝对路径，映射给基座变量
    DB_PATH = CENTRAL_DB_PATH;
    
    // 加入基础的路径存在性校验（容错机制）
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`寻址失败：静态指定的数据库路径不存在 -> ${DB_PATH}`);
    }
    console.log(`✅ [系统就绪] 成功锁定底层公共数据库: ${DB_PATH}`);
    // 【此处继续写你原有的 Playwright 初始化和 SQLite 数据库连接代码...】
    
} catch (error) {
    console.error(`🚨 [致命错误] 数据库环境初始化崩溃:`, error);
// 强烈建议：在此处可以加入 Playwright 的错误截图保存逻辑以防程序直接崩溃无从查证
    // await page.screenshot({ path: 'db_error_crash.png' }); 
    process.exit(1);
}

// 浏览器缓存目录 (统一管理)
const TAOBAO_USER_DATA_DIR = path.join(BASE_DIR, 'browser_profiles', 'taobao_store');
const JD_USER_DATA_DIR     = path.join(BASE_DIR, 'browser_profiles', 'jd_store');
const PDD_USER_DATA_DIR    = path.join(BASE_DIR, 'browser_profiles', 'pdd_store');
// [新增] 有品缓存目录
const YP_USER_DATA_DIR     = path.join(BASE_DIR, 'browser_profiles', 'yp_store');

// 3. [配置文件加载]
let config;
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } else {
        // 默认配置回退
        config = { 
            paths: { excel_task_file: 'tasks.xlsx' },
            browser_settings: { edge_executable_path: '', edge_user_data_dir: './jd_user_data' }
        };
        console.warn("⚠️ 未找到 config.json，使用默认配置。");
    }
} catch (e) {
    console.error("❌ 读取 config.json 失败。");
    process.exit(1);
}

// 4. [动态路径与初始化] (依赖 config 的变量及副作用)
const EXCEL_TASK_FILE_PATH = path.join(BASE_DIR, config.paths.excel_task_file);

// 初始化：如果截图目录不存在，则创建 (副作用逻辑放最后)
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR);
}

// ================= [公共工具函数] =================
// [迭代新增] 从数据库获取今日已完成的 SKU 列表 (真正的断点续传核心)
function get_completed_skus_from_db(platformName) {
    const completed = new Set();
    try {
        if (!fs.existsSync(DB_PATH)) return completed;
        // 数据库文件不存在，肯定没跑过
        
        // 使用只读模式尝试连接，即使 DB Browser 开着，通常只读查询是允许的
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        const today_str = DateTime.now().toFormat('yyyy-MM-dd');

        // 查询今天、特定平台，且状态不是失败/错误的记录
        const stmt = db.prepare(`
            SELECT sku_id 
            FROM price_history 
            WHERE record_time LIKE ? 
              AND platform = ? 
              AND status NOT LIKE '%错误%' 
              AND status NOT LIKE '%失败%'
        `);
        const rows = stmt.all(`${today_str}%`, platformName);
        
        rows.forEach(row => {
            if (row.sku_id) completed.add(row.sku_id);
        });
        db.close();
        console.log(`   ✅ [校验] 从底层数据库确认今日已成功落库 ${completed.size} 个 ${platformName} 任务。`);
    } catch (e) {
        // 如果表还没建，或者数据库被死锁导致连 SELECT 都失败，直接返回空 Set
        // 这样脚本会当做没有执行过，重新跑一遍作为兜底
        console.log(`   ⚠️ [校验] 数据库历史验证失败 (表不存在或被死锁锁定)，将重新执行任务: ${e.message}`);
    }
    return completed;
}

function init_csv_file() {
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        // [迭代新增] 表头增加 Product_Name
        const header = "\uFEFFPlatform,URL,Product_Name,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date,Main_Image_URL\n";
        fs.writeFileSync(CSV_OUTPUT_PATH, header, 'utf8');
        console.log(`🆕 已创建新的结果文件: ${CSV_OUTPUT_PATH}`);
    }
}

function append_results_to_csv(records) {
    if (!records || records.length === 0) return;
    let csvContent = "";
    records.forEach(r => {
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return "";
            const str = String(field).replace(/"/g, '""');
            if (str.search(/("|,|\n|\r)/g) >= 0) return `"${str}"`;
            return str;
        };

        const line = [
            escapeCsv(r.Platform),
            escapeCsv(r.URL),
            escapeCsv(r.Product_Name), // [迭代新增] 写入 Product_Name
            escapeCsv(r.SKU_Identifier),      
            escapeCsv(r.True_SKU_Identifier), 
            escapeCsv(r.Price),
            escapeCsv(r.Limit_Price),
            escapeCsv(r.Price_Status),
            escapeCsv(r.Scrape_Date),
            escapeCsv(r.Main_Image_URL)
        ].join(",");
        
        csvContent += line + "\n";
    });
    try {
        fs.appendFileSync(CSV_OUTPUT_PATH, csvContent, 'utf8');
        console.log(`   💾 CSV保存成功: 追加了 ${records.length} 条记录。`);
    } catch (e) {
        console.error(`   ❌ CSV写入失败: ${e.message}`);
    }
}

// [新增] 数据库写入核心函数
function save_results_to_db(records) {
    if (!records || records.length === 0) return;
    console.log(`   💿 正在将 ${records.length} 条数据同步至数据库...`);
    
    try {
        // 建立连接
        const db = new Database(DB_PATH);
        // 同步连接，效率高
        
        // 1. 确保表存在 (防呆设计：如果迁移脚本没跑，这里也会自动建表)
        const createTableStmt = `
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT,
                url TEXT,
                product_name TEXT,
                sku_id TEXT,
                true_sku_id TEXT,
                price REAL,
                limit_price REAL,
                status TEXT,
                record_time DATETIME,
                screenshot_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;
        db.exec(createTableStmt);

        // 2. 准备插入语句 (预编译，防止注入，性能更高)
        const insertStmt = db.prepare(`
            INSERT INTO price_history 
            (platform, url, product_name, sku_id, true_sku_id, price, limit_price, status, record_time, screenshot_path)
            VALUES 
            (@Platform, @URL, @Product_Name, @SKU_Identifier, @True_SKU_Identifier, @Price, @Limit_Price, @Price_Status, @Scrape_Date, @Main_Image_URL)
        `);
        // 3. 批量事务执行 (比一条条插快100倍)
        const insertMany = db.transaction((data) => {
            for (const row of data) {
                // 数据清洗：Price 可能是 "Not Found" 字符串，数据库该字段是 REAL，需要转 safe value
                let safePrice = null;
                if (typeof row.Price === 'number') {
                    safePrice = row.Price;
                } else if (typeof row.Price === 'string') {
                     // 移除可能的货币符号和逗号
                     const cleanPrice = row.Price.replace(/[^\d.]/g, '');
                     const p = parseFloat(cleanPrice);
                     if (!isNaN(p) && cleanPrice !== '') safePrice = p;
                }

                // 清洗 Limit_Price
                let safeLimit = null;
                if (row.Limit_Price) {
                    const cleanLimit = String(row.Limit_Price).replace(/[^\d.]/g, '');
                    const l = parseFloat(cleanLimit);
                    if(!isNaN(l)) safeLimit = l;
                }

                // 构建符合参数绑定的对象
                insertStmt.run({
                    Platform: row.Platform,
                    URL: row.URL,
                    Product_Name: row.Product_Name || '',
                    SKU_Identifier: row.SKU_Identifier,
                    True_SKU_Identifier: row.True_SKU_Identifier,
                    Price: safePrice,
                    Limit_Price: safeLimit,
                    Price_Status: row.Price_Status,
                    Scrape_Date: row.Scrape_Date,
                    Main_Image_URL: row.Main_Image_URL
                });
            }
        });

        insertMany(records);
        console.log(`   ✅ 数据库同步完成。`);
        db.close();
    } catch (e) {
        console.error(`   ❌ 数据库写入失败: ${e.message}`);
        // 数据库写入失败不应阻断流程，CSV 已经保存作为兜底
    }
}

function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

// ================= [阶段一：京东模块 (迭代版 - Edge 接管与精准复位)] =================

async function runJD() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段一] 启动京东监控任务 (支持断点续传)...`);
    console.log(`=============================================`);

    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    // [回归基础] 只保留最基本的滚动，不再模拟复杂的鼠标轨迹
    // [迭代修改] 为了不影响后续截图，改用“鼠标随机晃动” + “极小幅滚动并复位”策略
    async function simpleScroll(page) {
        try {
            // 1. 注入纯鼠标轨迹（页面不滚动，但产生充足的拟人特征防屏蔽）
            const width = await page.evaluate(() => window.innerWidth).catch(()=>1200);
            const height = await page.evaluate(() => window.innerHeight).catch(()=>800);
            await page.mouse.move(Math.random() * (width / 2), Math.random() * (height / 2), { steps: 10 });
            await page.waitForTimeout(Math.random() * 300 + 200);

            // 2. 原地微幅滚动并立刻复位（满足 wheel 事件检测，同时绝对不破坏截图画面）
            const microScroll = Math.floor(Math.random() * 50) + 20;
            // 仅滚动 20~70 像素
            await page.mouse.wheel(0, microScroll);
            // 往下滚一点点
            await page.waitForTimeout(Math.random() * 300 + 200);
            await page.mouse.wheel(0, -microScroll); // 原路滚回顶部（复位）
            await page.waitForTimeout(Math.random() * 500 + 500);
        } catch (e) {}
    }

    const PLATFORM_NAME = "京东";
    // --- [迭代修改] 断点续传核心：改用数据库作为唯一校验源 ---
    console.log(`📂 正在连接数据库核对今日已完成的任务记录...`);
    const completedSkus = get_completed_skus_from_db(PLATFORM_NAME);
    // -------------------------------------------

    let jd_tasks = [];
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0]; 
        
        let switchColIndex = -1;
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell, colNumber) => {
            const headerText = cell.text ? cell.text.trim() : '';
            if (headerText === '[T]') {
                switchColIndex = colNumber;
            }
        });
        // ================= [runJD 函数内] =================

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; 
            
            if (switchColIndex !== -1) {
                const switchVal = row.getCell(switchColIndex).value;
                if (switchVal != 1) return; 
            }

            const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
            if (platform !== PLATFORM_NAME) return;
            const productName = row.getCell(3).text ? row.getCell(3).text.trim() : 'N/A';

            const urlCellValue = row.getCell(4).value;
            const barcodeValue = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A';
            const limitPriceRaw = row.getCell(7).value;
            let limitPrice = null;
            if (limitPriceRaw) limitPrice = parsePriceToFloat(limitPriceRaw);
            
            // 处理超链接对象或普通文本
            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;

            // ★★★★★ [迭代新增：纯数字ID自动转京东链接] ★★★★★
            if (finalUrl) {
                const urlStr = String(finalUrl).trim();
                // 如果单元格内容全是数字（例如：10196375716835）
                if (/^\d+$/.test(urlStr)) {
                    finalUrl = `https://item.jd.com/${urlStr}.html`;
                    // console.log(`   🔄 [自动转换] 纯数字ID ${urlStr} -> ${finalUrl}`);
                    // 可选日志
                }
            }

            let trueSkuId = "N/A";
            if (typeof finalUrl === 'string') {
                const match = finalUrl.match(/\/(\d+)\.html/);
                if (match) trueSkuId = match[1];
                else { const match2 = finalUrl.match(/sku=(\d+)/); if (match2) trueSkuId = match2[1]; }
            }

            jd_tasks.push({
                url: finalUrl,
                productName: productName,
                barcode: barcodeValue,
                trueId: trueSkuId,
                limitPrice: limitPrice
            });
        });
        console.log(`[JD] Excel中共读取到 ${jd_tasks.length} 个任务。`);
    } catch (e) {
        console.log(`❌ [JD] 读取任务文件失败: ${e}`);
        return;
    }

    if (jd_tasks.length === 0) return;
    // 检查是否所有任务都完成了
    const pendingTasks = jd_tasks.filter(t => !completedSkus.has(t.barcode));
    if (pendingTasks.length === 0) {
        console.log(`🎉 [JD] 所有任务今日已完成，无需再次运行！`);
        return;
    }
    console.log(`📊 [JD] 剩余待处理任务: ${pendingTasks.length} 个`);

    let browser = null;
    let new_records = [];
    try {
        console.log(`[JD] 正在尝试接管 Edge 浏览器配置: ${JD_USER_DATA_DIR}`);
        // [迭代修改] 使用带有 stealth 插件的 chromiumExtra 替代标准 chromium，抹除机器指纹
        browser = await chromiumExtra.launchPersistentContext(JD_USER_DATA_DIR, {
            channel: 'msedge',
            headless: HEADLESS_MODE,
            viewport: null, 
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                '--start-maximized', 
                '--disable-blink-features=AutomationControlled',
                '--no-default-browser-check',
                '--disable-infobars'
            ]
        });
        const workingPage = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        
        const screenshotDir = path.join(BASE_DIR, 'error_screenshots');
        // 保持 V4 的稳定等待时间
        const randomTime = Math.random() * (7000 - 4000) + 4000;
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

        for (let index = 0; index < jd_tasks.length; index++) {
            const task = jd_tasks[index];
            if (!task.url || !task.url.startsWith('http')) continue;

            // [新增] 循环内的跳过逻辑
            if (completedSkus.has(task.barcode)) {
                // 可选：打印一条简洁的日志，或者完全静默
                // console.log(`⏭️ [已完成] SKU:${task.barcode} 跳过...`);
                continue; 
            }
            
            console.log(`--- [JD] (${index + 1}/${jd_tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";
            try {
                // [迭代修改] 在这里原有的 goto 中增加 referer 参数，伪装成从京东搜索页自然点击进入
                await workingPage.goto(task.url, { 
                    waitUntil: "domcontentloaded", 
                    timeout: 60000,
                    referer: "https://search.jd.com/"
                });
                // 登录检测
                if (workingPage.url().includes('passport.jd.com') || workingPage.url().includes('safe.jd.com')) {
                    console.log("🛑 [JD] 检测到登录页面，请手动完成登录...");
                    console.log("   (脚本将在页面跳转回商品详情页后自动继续)");
                    await workingPage.waitForURL(url => !url.toString().includes('passport.jd.com') && !url.toString().includes('safe.jd.com'), { timeout: 0 });
                    console.log("✅ [JD] 登录成功，继续执行...");
                    await workingPage.waitForTimeout(3000);
                }

                console.log("   ⏳ 等待页面渲染...");
                await simpleScroll(workingPage);
                
                await workingPage.waitForTimeout(randomTime);

                // 验证码检测
                const captchaSelectors = ['#captcha_modal', '.captcha-box', 'text="验证一下"', '#J-dj-captcha'];
                for (const sel of captchaSelectors) {
                    // [迭代修改] 移除原 isVisible 中无效的 timeout，实现瞬间检测
                    if (await workingPage.locator(sel).first().isVisible()) {
                        console.log("   ⚠️ 触发验证，等待人工介入 (请在浏览器中手动完成验证)...");
                        // [迭代新增] 替换原来的 waitForTimeout(0)。
                        // 使用 waitFor({ state: 'hidden', timeout: 0 }) 实现真正的无限等待，直到验证码元素被人工消除
                        await workingPage.locator(sel).first().waitFor({ state: 'hidden', timeout: 0 });
                        console.log("   ✅ 验证已完成，脚本自动继续执行...");
                        // [迭代新增] 验证通过后，给予页面数据重新加载的缓冲时间
                        await workingPage.waitForTimeout(2000);
                        break;
                    }
                }

                // 价格抓取
                try {
                    await Promise.any([
                        workingPage.waitForSelector("#J_FinalPrice .price", {timeout: 5000}),
                        workingPage.waitForSelector(".p-price .price", {timeout: 5000})
                    ]);
                } catch(e) {}

                const priceSelectors = [
                    ".product-price--value", // 2026最新版：精准匹配纯数字金额部分
                    ".product-price--main",  // 备用节点：匹配包含符号的整体外层
                    "#J_FinalPrice .price", 
                    ".J-presale-price", 
                    ".p-price .price", 
                    ".price"
                ];
                for (const sel of priceSelectors) {
                    try {
                        const el = workingPage.locator(sel).first();
                        if (await el.isVisible()) {
                            await el.scrollIntoViewIfNeeded();
                            const txt = await el.textContent();
                            if (/\d/.test(txt)) { final_price_str = txt.trim(); break; }
                        }
                    } catch (e) {}
                }

                if (final_price_str !== "Not Found") {
                    console.log(`   💰 抓取价格: ${final_price_str}`);
                    if (task.limitPrice !== null) {
                        const currentVal = parsePriceToFloat(final_price_str);
                        if (currentVal !== null) {
                            const alertThreshold = task.limitPrice * 0.97;
                            if (currentVal < alertThreshold) {
                                price_status = "破价警报";
                                console.log(`   🚨 [破价] ${currentVal} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${task.limitPrice})`);
                            } else if (currentVal > task.limitPrice) {
                                price_status = "高价待调整";
                                console.log(`   📈 [高价] ${currentVal} > 限价 ${task.limitPrice}`);
                            } else {
                                price_status = "价格正常";
                            }
                        }
                    }
                    // ==========================================
                    // [增量重构 - JD无差别截图终极防御版]：彻底放弃对不可靠 DOM 容器的依赖
                    // ==========================================
                    // [基座代码修正] 截图命名增加 trueId (商品ID)，格式：日期_JD_69码_商品ID.jpg，杜绝同码覆盖
                    const shotName = `${today_str}_JD_${task.barcode}_${task.trueId}.jpg`;
                    const fullShotPath = path.join(SCREENSHOT_DIR, shotName);

                    try {
                        // 1. 绝对避让：将鼠标移到屏幕最右侧空白区，彻底避开主图放大镜与顶部导航下拉菜单
                        const vWidth = await workingPage.evaluate(() => window.innerWidth).catch(() => 1200);
                        await workingPage.mouse.move(vWidth - 20, 300);
                        await workingPage.waitForTimeout(500); // 硬等待前端动画销毁

                        // 2. 极简截图：放弃 locator 和 clip，直接截取当前屏幕的可视区域。
                        // 因为上文已经将价格元素 scrollIntoView，此时画面必定是我们要的核心区域。
                        await workingPage.screenshot({
                            path: fullShotPath,
                            type: 'jpeg',
                            quality: 10,
                            fullPage: false // 仅截取当前可视区域，不强求全网页，斩断一切越界报错的可能
                        });
                        savedImagePath = fullShotPath;
                        console.log(`   📸 [可视区记录] 截图已稳妥保存 (${shotName})`);
                    } catch (shotErr) {
                        console.error(`   ❌ 截图保存发生罕见崩溃: ${shotErr.message}`);
                    }
                } else {
                    price_status = "抓取失败";
                    console.log(`   ❌ 未找到价格`);
                    const failShotPath = path.join(screenshotDir, `fail_JD_${index}.png`);
                    await workingPage.screenshot({ path: failShotPath });
                    savedImagePath = failShotPath;
                }

            } catch (e) {
                console.log(`   [出错] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "京东",
                URL: task.url,
                Product_Name: task.productName,
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });
            // 实时写入（可选优化）：
            if (index > 0 && index % 8 === 0) {
                const restTime = Math.floor(Math.random() * 5000) + 3000;
                console.log(`   ☕ 处理8件，小憩 ${restTime/1000}s...`);
                await workingPage.waitForTimeout(restTime);
            } else {
                await workingPage.waitForTimeout(Math.random() * 1500 + 1500);
            }
        }

    } catch (e) { console.error(`[JD] 严重错误: ${e}`);
    } 
    finally {
        if (browser) await browser.close();
        // 这里写入文件后，下次运行 script 读取时，就会包含上面运行过的任务
        append_results_to_csv(new_records);
        // ★★★ [新增] 数据库保存 ★★★
        save_results_to_db(new_records); 
        console.log(`[JD] 阶段任务完成。`);
    }
}

// ================= [阶段二：拼多多模块 (迭代版 - 新增局部截图)] =================
async function runPDD() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段二] 启动拼多多监控任务...`);
    console.log(`=============================================`);
    const today_str = DateTime.now().toFormat('yyyy-MM-dd'); // 为截图命名准备

    const TARGET_URL = "https://mms.pinduoduo.com/kit/goods-price-management?tool_full_channel=10323_97807&msfrom=mms_globalsearch";
    function extractIdFromInput(inputStr) {
        if (!inputStr) return "";
        const str = inputStr.toString().trim();
        if (/^\d+$/.test(str)) return str;
        try {
            const urlObj = new URL(str);
            const id = urlObj.searchParams.get("goods_id");
            if (id) return id;
        } catch (e) {
            const match = str.match(/goods_id=(\d+)/);
            if (match) return match[1];
        }
        return str;
    }

    let ids = [];
    let limitMap = {};
    try {
        if (!fs.existsSync(EXCEL_TASK_FILE_PATH)) {
            console.error(`❌ 未找到文件: ${EXCEL_TASK_FILE_PATH}`);
            return;
        }
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        data.forEach(row => {
            if (row['[T]'] != 1) return;
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (p === '拼多多') {
                const rawId = extractIdFromInput(row['URL']);
                if (rawId) {
                    ids.push(rawId);
                    const pName = row['ProductName'] || row['商品名称'] || "N/A"; // [迭代新增] 读取商品名称
                    let limit = row['PriceLimit'] || row['Limit_Price']; 
                    let limitVal = -1;
                    if (limit) {
                        if (typeof limit === 'string') limitVal = parseFloat(limit.replace(/[,￥]/g, ''));
                        else limitVal = limit;
                    }
                    let barcodeVal = row['ProductID'] || row['Barcode'] || row['Product ID'] || row['SKU'] || "N/A";
                    limitMap[rawId] = { limit: limitVal, barcode: barcodeVal, productName: pName }; // [迭代新增] 暂存名称
                }
            }
        });
        ids = [...new Set(ids)];
        console.log(`[PDD] 读取到 ${ids.length} 个商品ID。`);
    } catch (e) { console.error(`❌ [PDD] 读取 Excel 失败: ${e}`); return;
    }

    if (ids.length === 0) return;

    let browser = null;
    let new_records = [];
    try {
        const context = await chromium.launchPersistentContext(PDD_USER_DATA_DIR, {
            headless: HEADLESS_MODE, channel: 'msedge', args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], viewport: null
        });
        browser = context;
        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        await page.goto(TARGET_URL);
        await page.waitForTimeout(2000);
        if (page.url().includes('login') || (await page.locator('.login-content').count()) > 0) {
            console.log("🛑 [PDD] 请手动登录...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
        }
        await page.waitForSelector('table[class*="TB_tableWrapper"]', { timeout: 20000 });
        const inputLocator = page.locator('input[placeholder*="多个ID"]');
        await inputLocator.clear();
        await inputLocator.fill(ids.join(' '));
        await page.locator('button', { hasText: '查询' }).first().click();
        
        console.log("⏳ [PDD] 等待查询结果...");
        await page.waitForTimeout(3000);
        let hasNextPage = true;
        let pageNum = 1;

        while (hasNextPage) {
            console.log(`\n📄 [PDD] --- 第 ${pageNum} 页 ---`);
            const tbody = page.locator('tbody[data-testid="beast-core-table-middle-tbody"]');
            await page.waitForTimeout(1500);

            if (await tbody.count() > 0) {
                const rows = await tbody.locator('tr').all();
                for (const row of rows) {
                    try {
                        const cells = await row.locator('td').all();
                        if (cells.length < 5) continue;
                        const productInfoText = await cells[1].innerText();
                        const priceText = await cells[3].innerText();
                        // [迭代新增] 嗅探是否包含“百亿补贴”专属标签
                        const isSubsidy = priceText.includes('百亿补贴');
                        let currentPrice = 0;
                        if (priceText) {
                            const matches = priceText.match(/\d+(\.\d+)?/g);
                            if (matches) {
                                const validPrices = matches.map(parseFloat).filter(p => p > 0);
                                if (validPrices.length > 0) currentPrice = validPrices[validPrices.length - 1];
                            }
                        }
                        
                        let matchedId = null;
                        for (const id of Object.keys(limitMap)) {
                            if (productInfoText.includes(id)) {
                                matchedId = id;
                                break;
                            }
                        }

                        // ==========================================
                        // [基座代码修正 - PDD无差别截图]：直接对当前商品所在的整行元素进行轻量化截图
                        // ==========================================
                        let localShotPath = "";
                        if (matchedId) {
                            const shotName = `${today_str}_PDD_${matchedId}.jpg`;
                            const fullShotPath = path.join(SCREENSHOT_DIR, shotName);
                            try {
                                await row.scrollIntoViewIfNeeded();
                                await row.screenshot({ 
                                    path: fullShotPath, 
                                    type: 'jpeg', 
                                    quality: 10 // PDD行截图同样采用极限压缩
                                });
                                localShotPath = fullShotPath;
                                console.log(`   📸 [无差别记录] PDD 行截图已保存.`);
                            } catch (shotErr) {
                                console.error(`   ❌ PDD 截图失败: ${shotErr.message}`);
                            }
                        }

                        if (matchedId && currentPrice > 0) {
                            const info = limitMap[matchedId];
                            const refPrice = info.limit;
                            const barcode = info.barcode; 
                            let status = "正常";
                            if (refPrice > 0) {
                                const alertThreshold = refPrice * 0.97;
                                if (currentPrice < alertThreshold) {
                                    status = "破价警报";
                                    console.log(`   🚨 [破价] ID:${matchedId} | ${currentPrice} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${refPrice})`);
                                } else if (currentPrice > refPrice) {
                                    status = "高价待调整";
                                    console.log(`   📈 [高价] ID:${matchedId} | ${currentPrice} > ${refPrice}`);
                                }
                            }

                            // [迭代新增] 如果是百亿补贴商品，强行在状态里打上烙印
                            if (isSubsidy) {
                                status = (status === "正常") ? "百亿补贴" : `${status} | 百亿补贴`;
                                console.log(`   🔥 [百亿标签] ID:${matchedId} 已打标百亿补贴，写入数据库。`);
                            }

                            new_records.push({
                                Platform: "拼多多",
                                URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${matchedId}`,
                                Product_Name: info.productName, // [迭代新增] 存入结果记录
                                SKU_Identifier: barcode, 
                                True_SKU_Identifier: matchedId, 
                                Price: currentPrice,
                                Limit_Price: refPrice > 0 ? refPrice : "",
                                Price_Status: status, // 这里会将百亿补贴的烙印存入数据库
                                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                                Main_Image_URL: localShotPath // 改为存储本地截图路径，对齐全局结构
                            });
                        }
                    } catch (e) { console.error("   ⚠️ 行解析错:", e.message);
                    }
                }
            }
            const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
            if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
                const classAttr = await nextBtn.getAttribute('class') || "";
                if (classAttr.includes('disabled')) hasNextPage = false;
                else { await nextBtn.click(); await randomDelay(2000, 3000); pageNum++;
                }
            } else { hasNextPage = false;
            }
        }

    } catch (e) { console.error(`[PDD] 错误: ${e}`);
    } 
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        // ★★★ [新增] 数据库保存 ★★★
        save_results_to_db(new_records);
        console.log(`[PDD] 阶段任务完成。`);
    }
}



// ================= [阶段三：淘系模块 (保持原样，已被证明全量截图)] =================

async function runTaobao() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段三] 启动淘系监控任务 (安全加强版)...`);
    console.log(`⚠️ 提示：正在采用低频拟人化策略，以降低封号风险。`);
    console.log(`=============================================`);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // --- [迭代新增] 拟人化行为模拟：不规则移动与滚动 ---
    async function simulateHumanAction(page) {
        console.log("   🧘 模拟人类浏览行为中...");
        try {
            const width = await page.evaluate(() => window.innerWidth);
            const height = await page.evaluate(() => window.innerHeight);
            
            // 1. 随机小幅度滚动
            for (let i = 0; i < 3; i++) {
                const scrollAmount = Math.floor(Math.random() * 300) + 100;
                await page.mouse.wheel(0, scrollAmount);
                await sleep(Math.random() * 1000 + 500);
            }
            
            // 2. 随机鼠标移动（在视口范围内）
            for (let i = 0; i < 2; i++) {
                await page.mouse.move(Math.random() * width, Math.random() * height, { steps: 10 });
                await sleep(500);
            }
        } catch (e) {}
    }

    // --- 辅助：清理页面遮挡 ---
    async function clearObstructions(page) {
        const closeSelectors = [
            '.mui-dialog-close', '.sufei-dialog-close', 'button[aria-label="Close"]', 
            '.rax-view[role="button"]', 'text="关闭"', 'text="不再提示"', '.ant-modal-close'
        ];
        for (const sel of closeSelectors) {
            try {
                const els = await page.locator(sel).all();
                for (const el of els) {
                    if (await el.isVisible()) {
                        await el.click({ force: true });
                        await sleep(300);
                    }
                }
            } catch (e) {}
        }
    }

    // [保持原有 SKU 选择逻辑]
    async function autoSelectSKU(page) {
        console.log("   ⚙️ 正在检查并自动选择 SKU...");
        const rowSelectors = ['dl.tm-sale-prop', 'ul.J_TSaleProp', 'div[class*="skuItem"]', 'div[class*="propRow"]'];
        let skuFound = false;
        for (const rowSel of rowSelectors) {
            const rows = await page.locator(rowSel).all();
            if (rows.length > 0) {
                skuFound = true;
                for (const row of rows) {
                    try {
                        const isSelected = await row.locator('.tb-selected, .tm-selected, [class*="selected"], [aria-checked="true"]').count() > 0;
                        if (!isSelected) {
                            const options = row.locator('li:not([class*="disabled"]):not([class*="out-of-stock"]) a, li:not([class*="disabled"]) span, button:not([disabled])');
                            if (await options.count() > 0) {
                                await options.first().click({ force: true });
                                await sleep(800);
                            }
                        }
                    } catch (e) {}
                }
            }
        }
    }

    // 1. 读取任务
    let tb_tasks = [];
    try {
        if (!fs.existsSync(EXCEL_TASK_FILE_PATH)) { console.error(`❌ 未找到Excel`); return;
        }
        const workbook = XLSX.readFile(EXCEL_TASK_FILE_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        data.forEach(row => {
            if (row['[T]'] != 1) return;
            const p = row['Platform'] ? row['Platform'].trim() : '';
            if (['淘系', '淘宝', '天猫'].includes(p)) {
                if (row['URL']) {
                    const pName = row['ProductName'] || row['商品名称'] || "N/A";
                    let limit = row['PriceLimit'] || row['Limit_Price'] || row['pricelimit'];
                    let limitVal = limit ? parseFloat(String(limit).replace(/[,￥]/g, '')) : null;
                    tb_tasks.push({
                        url: row['URL'],
                        productName: pName,
                        barcode: row['Barcode'] || row['SKU'] || row['SKU_Identifier'] || "N/A",
                        trueId: row['URL'].match(/[?&]id=(\d+)/) ? row['URL'].match(/[?&]id=(\d+)/)[1] : "N/A",
                        limitPrice: limitVal
                    });
                }
            }
        });
        console.log(`[Taobao] 读取到 ${tb_tasks.length} 个任务。`);
    } catch(e) { console.error(`❌ [Taobao] Excel 读取失败: ${e}`); return;
    }

    if (tb_tasks.length === 0) return;

    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        browser = await chromiumExtra.launchPersistentContext(TAOBAO_USER_DATA_DIR, {
            headless: HEADLESS_MODE,
            viewport: null,
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        });
        const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
        const screenshotDir = path.join(BASE_DIR, 'price_screenshots');
        for (let index = 0; index < tb_tasks.length; index++) {
            const task = tb_tasks[index];
            console.log(`--- [Taobao] (${index + 1}/${tb_tasks.length}) ID:${task.trueId} ---`);
            
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";
            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                // [迭代新增] 验证拦截熔断逻辑
                if (page.url().includes('login.taobao') || (await page.locator('.sufei-dialog-content').isVisible().catch(()=>false))) {
                    console.log("🛑 检测到高强度验证或登录拦截！");
                    console.log("   为了安全，请手动完成验证或重启脚本。此处强制等待 30 秒后跳过该商品...");
                    await sleep(30000); 
                    continue; 
                }

                await clearObstructions(page);
                // [迭代新增] 点击前的拟人化预热
                await simulateHumanAction(page);
                await autoSelectSKU(page);
                
                // [迭代新增] 显著增加动作间的随机间隔 (15s - 30s)
                const safeInterval = Math.random() * 15000 + 15000;
                console.log(`   ⏳ 正在进行安全冷却 (${(safeInterval/1000).toFixed(1)}s)...`);
                await sleep(safeInterval);

                const buySelectors = ['text="立即购买"', 'text="领券购买"', '#J_LinkBuy', '[class*="buyBtn"]', '[class*="Buy--buyBtn"]'];
                let clicked = false;
                for(const selector of buySelectors) {
                    try {
                        const btn = page.locator(selector).first();
                        if (await btn.isVisible()) {
                            await btn.click({timeout: 5000, force: true});
                            console.log(`   👆 已尝试购买链接`);
                            clicked = true; break;
                        }
                    } catch(e) {}
                }

                if (!clicked) throw new Error("无法触发购买动作");
                // [保持原有确认弹窗处理]
                await sleep(2000);
                const confirmSelectors = ['.sku-info .btn-ok', 'button[class*="sku--sure"]', 'div[role="dialog"] button:has-text("确定")'];
                for(const sel of confirmSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible()) {
                        await btn.click({force: true});
                        await sleep(1500); break;
                    }
                }

                console.log("   🔄 正在进入结算页...");
                await page.waitForURL(url => url.href.includes('buy.taobao') || url.href.includes('buy.tmall'), { timeout: 15000 });
                // [保持原有价格抓取逻辑]
                const priceSelectors = ['.trade-price-integer', '[class*="totalPrice_num"]', '[class*="realPay-price"]'];
                let priceText = "";
                for (const sel of priceSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible({timeout: 3000})) {
                            priceText = await el.textContent();
                            if (priceText && /\d/.test(priceText)) { priceText = priceText.trim(); break; }
                        }
                    } catch(e) {}
                }
                
                if (priceText) {
                    final_price_str = priceText;
                    console.log(`   💰 实付款: ${final_price_str}`);
                }

                const shotName = `${today_str}_TB_${task.barcode}.jpg`;
                // 使用 .jpg
                const fullShotPath = path.join(SCREENSHOT_DIR, shotName);
                try {
                    const viewportWidth = await page.evaluate(() => window.innerWidth).catch(() => 1920);
                    await page.screenshot({ 
                        path: fullShotPath,
                        type: 'jpeg',
                        quality: 10,
                        clip: { x: 0, y: 0, width: viewportWidth, height: 1000 }
                    });
                    savedImagePath = fullShotPath;
                    console.log(`   📸 [轻量化] 淘宝截图已保存 (1000px高, 10%画质).`);
                } catch (shotErr) {
                    console.error(`   ❌ 淘宝截图保存失败: ${shotErr.message}`);
                }

            } catch(e) {
                console.log(`   [Error] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "淘系",
                URL: task.url,
                Product_Name: task.productName,
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });

            // 每个商品任务结束后的总冷却
            const coolDown = Math.random() * 20000 + 10000;
            console.log(`   ☕ 完成一件，冷却 ${coolDown/1000}s...`);
            await sleep(coolDown);
        }

    } catch (e) { console.error(`[Taobao] 致命错误: ${e}`);
    }
    finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        save_results_to_db(new_records);
        console.log(`[Taobao] 阶段任务完成。`);
    }
}


// ================= [阶段四：有品模块 (保持原样，已被证明全量截图)] =================

async function runYoupin() {
    console.log(`\n=============================================`);
    console.log(`📦 [阶段四] 启动小米有品监控任务 (69码命名对齐版)...`);
console.log(`=============================================`);
    const PLATFORM_NAME = "米家有品";
    const { devices } = require('playwright');
    const iPhoneXR = devices['iPhone XR'];
    // --- 内部辅助函数：页面清理 ---
    async function cleanupPage(page) {
        try {
            const nuisanceSelectors = ['#lib10-opapp-wrap', '.m-header-download-banner', '.openAppDialog', '.m-detail-back-top'];
            await page.evaluate((selectors) => {
                selectors.forEach(selector => {
                    const el = document.querySelector(selector);
                    if (el) el.remove();
                });
            }, nuisanceSelectors);
        } catch (error) {}
    }

    // --- 内部辅助函数：价格抓取 ---
    async function grabPrice(page) {
        let priceText = "Not Found";
        try {
            const presalePriceLocator = page.locator('[aria-label^="预售到手价"]');
            const finalPriceLocator = page.locator('[aria-label^="到手价"]');
            const regularPriceLocator = page.locator('[aria-label^="￥"]');

            let priceAriaLabel = "";
            if (await presalePriceLocator.count() > 0) {
                priceAriaLabel = await presalePriceLocator.first().getAttribute('aria-label');
            } else if (await finalPriceLocator.count() > 0) {
                priceAriaLabel = await finalPriceLocator.first().getAttribute('aria-label');
            } else if (await regularPriceLocator.count() > 0) {
                priceAriaLabel = await regularPriceLocator.first().getAttribute('aria-label');
            }

            if (priceAriaLabel) {
                const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
                if (priceMatch) priceText = priceMatch[0];
            }
            return priceText;
        } catch (priceError) { return "Error"; }
    }

    // 1. 读取任务 (B列=69码/条形码, D列=URL, E列=指令, G列=限价)
    let yp_tasks = [];
    try {
        const workbook = new exceljs.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.worksheets[0];
        let switchColIndex = -1;
        worksheet.getRow(1).eachCell((cell, colNumber) => {
            if (cell.text && cell.text.trim() === '[T]') switchColIndex = colNumber;
        });
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            if (switchColIndex !== -1 && row.getCell(switchColIndex).value != 1) return;

            const platform = row.getCell(1).text ? row.getCell(1).text.trim() : '';
            if (platform !== PLATFORM_NAME && platform !== "有品") return;

            const barcode = row.getCell(2).text ? row.getCell(2).text.trim() : 'N/A'; // Column B (69码)
            const urlCellValue = row.getCell(4).value; // Column D (URL)
            const skuInstruction = row.getCell(5).text ? row.getCell(5).text.trim() : ''; // Column E (SKU指令)
            
            let finalUrl = (typeof urlCellValue === 'object' && urlCellValue?.hyperlink) ? urlCellValue.hyperlink : urlCellValue;
            
            yp_tasks.push({
                url: finalUrl,
                barcode: barcode,
                productName: row.getCell(3).text ? row.getCell(3).text.trim() : 'N/A',
                skuTask: skuInstruction, 
                limitPrice: parsePriceToFloat(row.getCell(7).value)
            });
        });
        console.log(`[Youpin] 任务加载完成: ${yp_tasks.length} 条。`);
    } catch (e) {
        console.log(`❌ [Youpin] 读取任务失败: ${e.message}`);
        return;
    }

    if (yp_tasks.length === 0) return;

    let browser = null;
    let new_records = [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');

    try {
        browser = await chromium.launchPersistentContext(YP_USER_DATA_DIR, {
            channel: 'msedge', headless: HEADLESS_MODE, ...iPhoneXR,
            args: ['--disable-blink-features=AutomationControlled']
        });
        const page = browser.pages()[0];
        
        for (let index = 0; index < yp_tasks.length; index++) {
            const task = yp_tasks[index];
            if (!task.url) continue;

            console.log(`--- [Youpin] (${index + 1}/${yp_tasks.length}) 69码: ${task.barcode} ---`);
            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await cleanupPage(page);
                await page.waitForTimeout(1000); 

                // 2. 触发 SKU 弹窗
                const buyBtnSelectors = ['text=/^立即(购买|抢购)$/', 'text="领券购买"', 'text="到货通知"', 'text=/^支付定金/', 'text="加入购物车"', '.m-detail-footer-btns .btn-item'];
                let isFound = false;
                for (const selector of buyBtnSelectors) {
                    const btn = page.locator(selector).first();
                    if (await btn.isVisible()) {
                        await btn.scrollIntoViewIfNeeded();
                        await btn.click({ force: true });
                        isFound = true; break;
                    }
                }
                if (isFound) await page.waitForTimeout(1500);
                const subTasks = (task.skuTask || '').split(';').map(t => t.trim()).filter(t => t !== '');
                const currentTasks = subTasks.length > 0 ? subTasks : ['default'];

                for (const currentTaskStr of currentTasks) {
                    let final_price_str = "Not Found";
                    let price_status = "未知";
                    let savedImagePath = "";

                    // 3. 执行 SKU 点击指令
                    if (currentTaskStr !== 'default') {
                        for (const step of currentTaskStr.split(',').map(s => s.trim())) {
                            let targetText = step, targetIndex = 0; 
                            const match = step.match(/(.+)\[(\d+)\]$/);
                            if (match) { targetText = match[1].trim(); targetIndex = parseInt(match[2], 10);
                            }
                            const stepLocator = page.getByText(targetText, { exact: true });
                            if (await stepLocator.count() > targetIndex) {
                                await stepLocator.nth(targetIndex).click({ force: true });
                                await page.waitForTimeout(500);
                            }
                        }
                    }

                    await page.waitForTimeout(800);
                    final_price_str = await grabPrice(page);

                    if (final_price_str !== "Not Found" && final_price_str !== "Error") {
                        const currentVal = parsePriceToFloat(final_price_str);
                        // --- 【核心修正】截图命名使用 task.barcode (69码)，后缀改为 .jpg ---
                        const shotName = `${today_str}_YP_${task.barcode}_${Date.now()}.jpg`;
                        const fullPath = path.join(SCREENSHOT_DIR, shotName);
                        
                        let isAlert = false;
                        if (task.limitPrice && currentVal && currentVal < (task.limitPrice * 0.97)) {
                            isAlert = true;
                            price_status = "破价警报";
                        } else if (currentVal && task.limitPrice && currentVal > task.limitPrice) {
                            price_status = "高价待调整";
                        } else { 
                            price_status = "价格正常";
                        }

                        try {
                            // 有品通常是手机模拟，获取实际的移动端宽度
                            const viewportWidth = await page.evaluate(() => window.innerWidth).catch(() => 375);
                            await page.screenshot({ 
                                path: fullPath,
                                type: 'jpeg',
                                quality: 10,
                                clip: { x: 0, y: 0, width: viewportWidth, height: 1000 }
                            });
                            savedImagePath = fullPath;
                            console.log(`   📸 [轻量化] 有品截图已保存 (1000px高, 10%画质).`);
                        } catch (shotErr) {
                            console.error(`   ❌ 有品截图保存失败: ${shotErr.message}`);
                        }
                    }

                    // 4. 数据存入记录 (保持列对齐)
                    new_records.push({
                        Platform: "米家有品",
                        URL: task.url,
                        Product_Name: task.productName,
                        SKU_Identifier: task.barcode,      // CSV 第 4 列：69码
                        True_SKU_Identifier: currentTaskStr, 
                        Price: final_price_str,
                        Limit_Price: task.limitPrice,
                        Price_Status: price_status,
                        Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                        Main_Image_URL: savedImagePath
                    });
                }
            } catch (err) { 
                console.log(`   [Error] ${err.message.split('\n')[0]}`);
            }
        }
    } finally {
        if (browser) await browser.close();
        append_results_to_csv(new_records);
        // ★★★ [新增] 数据库保存 ★★★
        save_results_to_db(new_records);
        console.log(`[Youpin] 阶段任务完成。`);
    }
}


// ================= [全局控制开关] =================

// ★★★ 调试开关区 ★★★
const RUN_CONFIG = {
    JD: true,      // 京东开关
    PDD: true,     // 拼多多开关true
    TAOBAO: false,  // 淘系开关 false
    YOUPIN: false   // [新增] 有品开关
};
// ================= [阶段五：全局数据修正 (安全时间围栏版)] =================

/**
 * 读取CSV，智能识别列位置，仅修正【今天】产生的数据
 */
async function fixPriceStatus() {
    console.log(`\n=============================================`);
    console.log(`⚖️ [阶段五] 启动全局比价修正 (安全时间围栏版)...`);
    console.log(`=============================================`);
    if (!fs.existsSync(CSV_OUTPUT_PATH)) {
        console.log("❌ 结果文件不存在，无法修正。");
        return;
    }

    // 1. 获取“今天”的日期字符串 (格式 YYYY-MM-DD)
    // 注意：这里用的是本地时间，确保和脚本抓取的时间一致
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    // 例如 "2026-01-05"

    console.log(`📅 锁定修正范围: 仅处理日期包含 [${todayStr}] 的记录`);
    // 2. 读取文件
    const fileContent = fs.readFileSync(CSV_OUTPUT_PATH, 'utf8');
    const lines = fileContent.trim().split('\n');
    if (lines.length < 2) {
        console.log("⚠️ CSV记录不足，跳过修正。");
        return;
    }

    const headerLine = lines[0];

    // 3. 简单的 CSV 解析器
    const parseLine = (line) => {
        const pattern = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/; 
        return line.split(pattern).map(v => v.replace(/^"|"$/g, '').trim());
    };

    // 4. --- 精确列索引定位 (基于表头) ---
    // 定义我们需要的字段名称
    let idx_sku = -1;
    let idx_price = -1;
    let idx_status = -1;
    let idx_date = -1;
    let idx_platform = 0; 

    // 优先方案：解析第一行（表头），根据名称动态定位
    if (lines.length > 0) {
        // 去除可能的引号和空白
        const headerCols = lines[0].split(',').map(c => c.trim().replace(/^"|"$/g, '')); 
        
        // 查找对应列名的索引
        idx_sku = headerCols.indexOf('SKU_Identifier');      // 对应列2
        idx_price = headerCols.indexOf('Price');             // 对应列4
        idx_status = headerCols.indexOf('Price_Status');     // 对应列6
        idx_date = headerCols.indexOf('Scrape_Date');        // 对应列7
        idx_platform = headerCols.indexOf('Platform');
    }

    // 兜底方案：如果表头没找到（比如CSV没有表头），则强制使用标准结构
    // 结构依据: Platform,URL,SKU_Identifier,True_SKU_Identifier,Price,Limit_Price,Price_Status,Scrape_Date...
    if (idx_sku === -1 || idx_price === -1) {
        console.log("   ⚠️ 表头识别失败，切换至强制标准索引...");
        idx_platform = 0;
        idx_sku = 2;    // SKU_Identifier
        idx_price = 4; // Price
        idx_status = 6; // Price_Status
        idx_date = 7; // Scrape_Date
    }

    console.log(`   🎯 列索引锁定 -> SKU:[${idx_sku}] | 价格:[${idx_price}] | 状态:[${idx_status}] | 日期:[${idx_date}]`);
    // 5. 解析并筛选【今天】的数据
    let rows = [];
    let todayRowsIndices = []; // 记录哪些行属于今天 (方便回写)

    for (let i = 1; i < lines.length; i++) {
        const cols = parseLine(lines[i]);
        if (cols.length <= idx_status) continue; 
        
        const rowDate = cols[idx_date] || "";
        const rowSku = String(cols[idx_sku]).trim();
        const rowPrice = parseFloat(cols[idx_price]);
        const rowStatus = cols[idx_status];
        const rowPlatform = cols[idx_platform];

        const rowObj = {
            rawCols: cols,
            lineIndex: i, // 记住原始行号
            sku: rowSku,
            price: rowPrice,
            status: rowStatus,
            platform: rowPlatform,
            isToday: rowDate.includes(todayStr) // ★ 核心判断：是否是今天的数据
        };

        rows.push(rowObj);
    }

    // 6. 仅在【今天】的数据范围内，计算最低价
    const todaySkuMinPriceMap = {};
    rows.forEach(row => {
        if (!row.isToday || !row.sku || isNaN(row.price)) return; // 跳过历史数据
        
        if (!todaySkuMinPriceMap[row.sku]) {
            todaySkuMinPriceMap[row.sku] = row.price;
        } else {
            if (row.price < todaySkuMinPriceMap[row.sku]) {
                todaySkuMinPriceMap[row.sku] = row.price;
            }
        }
    });
    // 7. 遍历并修正 (只修正今天的)
    let fixCount = 0;
    rows.forEach(row => {
        // 安全锁：如果不是今天的数据，直接跳过，绝对不改
        if (!row.isToday) return;

        const isAlert = row.status && row.status.includes('破价'); 

        if (isAlert && todaySkuMinPriceMap[row.sku] !== undefined) {
            const minPrice = todaySkuMinPriceMap[row.sku];

            // 逻辑：如果 我的价格 > 今天全网最低价
            // 容差 0.01
            if (row.price > minPrice + 0.01) {
                const newStatus = "破价(跟随竞对)";
                
                // 修改内存数据
                row.rawCols[idx_status] = newStatus;
                
                console.log(`   🔧 [修正] ${row.platform} (码:${row.sku}) | 现价:${row.price} > 今日最低:${minPrice} -> 改判为:跟随`);
                fixCount++;
            }
        }
    });
    // 8. 回写文件
    if (fixCount > 0) {
        const escapeCsv = (str) => {
            if (str === null || str === undefined) return "";
            const s = String(str).replace(/"/g, '""');
            if (s.search(/("|,|\n|\r)/g) >= 0) return `"${s}"`;
            return s;
        };

        // 重新组装内容
        // 注意：这里 rows 包含了所有数据（历史+今天），但只有今天的 rawCols 被修改了
        const newContent = [headerLine, ...rows.map(r => r.rawCols.map(escapeCsv).join(','))].join('\n');
        try {
            fs.writeFileSync(CSV_OUTPUT_PATH, newContent, 'utf8');
            console.log(`✅ 修正完成！仅更新了今天 (${todayStr}) 的 ${fixCount} 条记录。`);
        } catch (e) {
            console.error(`❌ 文件回写失败: ${e.message}`);
        }
    } else {
        console.log(`✅ 检查完毕，今日数据无需修正。`);
    }
}


// ================= [增量模块：本地存储空间优化] =================
/**
 * 自动化空间清理策略 (滚动淘汰旧截图)
 * 采用原生 fs 模块实现，无需额外安装依赖
 * @param {number} days 保留最近多少天的截图，默认 30 天
 */
function cleanOldScreenshots(days = 30) {
    console.log(`\n=============================================`);
    console.log(`🧹 [空间运维] 启动历史截图清理策略 (保留最近 ${days} 天)...`);
    console.log(`=============================================`);
    try {
        if (!fs.existsSync(SCREENSHOT_DIR)) return;
        const files = fs.readdirSync(SCREENSHOT_DIR);
        const now = Date.now();
        const msInDay = 24 * 60 * 60 * 1000;
        let deletedCount = 0;

        files.forEach(file => {
            // 仅对图片文件执行清理，防止误删其他系统文件
            if (!file.endsWith('.jpg') && !file.endsWith('.png') && !file.endsWith('.jpeg')) return;
            
            const filePath = path.join(SCREENSHOT_DIR, file);
            const stats = fs.statSync(filePath);
            const diffDays = (now - stats.mtimeMs) / msInDay;

            if (diffDays > days) {
                fs.unlinkSync(filePath); // 硬删除过期文件
                deletedCount++;
            }
        });
        console.log(`✅ 清理完毕：共移除了 ${deletedCount} 张过期截图，释放了系统磁盘空间。`);
    } catch (e) {
        console.error(`❌ 清理历史截图时发生异常: ${e.message}`);
    }
}

// ================= [主控制器] =================

async function main() {
    console.log(`🚀 --- 全平台价格监控脚本启动 (v3.1 All-In-One + DB + 运维保障) ---`);
    console.log(`📂 结果存储位置: ${CSV_OUTPUT_PATH}`);
    console.log(`💿 中央数据库位置: ${DB_PATH}`);
    console.log(`🔧 当前运行模式: JD[${RUN_CONFIG.JD?'开':'关'}] | PDD[${RUN_CONFIG.PDD?'开':'关'}] | TB[${RUN_CONFIG.TAOBAO?'开':'关'}] | YP[${RUN_CONFIG.YOUPIN?'开':'关'}]`);
    
    init_csv_file();

    if (RUN_CONFIG.JD) await runJD();
    else console.log(`⏭️  [跳过] 京东`);

    if (RUN_CONFIG.PDD) await runPDD();
    else console.log(`⏭️  [跳过] 拼多多`);

    if (RUN_CONFIG.TAOBAO) await runTaobao();
    else console.log(`⏭️  [跳过] 淘宝`);

    if (RUN_CONFIG.YOUPIN) await runYoupin();
    else console.log(`⏭️  [跳过] 有品`);

    console.log(`\n⏳ 所有抓取任务结束，等待文件写入...`);
    await new Promise(r => setTimeout(r, 1500)); 

    // 执行安全修正
    await fixPriceStatus();
    // ==========================================
    // 增量模块：执行 30 天自动空间清理
    // ==========================================
    cleanOldScreenshots(30);
    console.log(`\n🎉 --- 全部流程执行完毕 ---`);
}

// 执行入口
main();