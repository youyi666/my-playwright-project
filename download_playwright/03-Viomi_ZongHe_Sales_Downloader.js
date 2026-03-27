// 05-Viomi_Sales_TOP20_Sniper_Ultimate.js
// 【v20 - 销售额TOP20 完全体】
// 
// 修复日志：
// 1. [回滚] 日期选择逻辑完全回滚到 v15/Original 版本，恢复所有 waitFor 和 visibility 检查。
// 2. [保留] v19 的强制刷新 (F5) 和文件名校验逻辑。
// 3. [保留] 数据库去重和自动归档逻辑。

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';
import { fileURLToPath } from 'url';

// --- ESM 兼容定义 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 环境变量 ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

const DATABASE_PATH = path.join(
    __dirname, 
    '..', '..', '..', 
    '00_Shared_Database数据库', 
    'TmallDataCenter.db'
);
const DOWNLOAD_DIRECTORY = path.join(__dirname, 'exc_data', 'TOP20_Sniper');
const ARCHIVE_DIRECTORY = path.join(DOWNLOAD_DIRECTORY, '已导入');

// --- 监控范围 ---
const TARGET_PLATFORMS = ['京东', '天猫', '拼多多', '有品']; 
const LOOKBACK_DAYS = 30; 

// ======================= [数据库初始化] =======================

function initDatabase() {
    const dbDir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    
    const db = new Database(DATABASE_PATH);
    
    // [关键] 如果发现表结构不一样，为了省事，我们可以先删掉旧表
    // 这样下次运行时脚本会自动重建包含新列的表
    try {
        const check = db.prepare("SELECT barcode FROM sales_history LIMIT 1").get();
    } catch (e) {
        if (e.message.includes('no such column')) {
            console.log("   ⚠️ 检测到旧版数据库结构，正在升级表结构...");
            db.exec("DROP TABLE IF EXISTS sales_history"); 
        }
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS sales_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date TEXT,       -- 日期
            platform TEXT,          -- 渠道类型
            sku_id TEXT,            -- 平台商品id
            product_name TEXT,      -- 商品名称
            category TEXT,          -- 类目
            barcode TEXT,           -- [新增] 商品69码 (核心关联字段)
            
            -- 流量数据
            visitor_count INTEGER,  -- 访客数
            page_views INTEGER,     -- [新增] 浏览量
            favorites INTEGER,      -- [新增] 收藏量
            
            -- 销售漏斗
            order_buyers INTEGER,   -- [新增] 下单买家数
            order_items INTEGER,    -- [新增] 下单件数
            order_amount REAL,      -- [新增] 下单金额
            
            sales_volume INTEGER,   -- 支付数量 (修正原名为支付件数)
            sales_users INTEGER,    -- [新增] 支付用户数
            sales_amount REAL,      -- 支付金额
            
            -- 意向数据
            cart_items INTEGER,     -- [新增] 加购件数
            cart_users INTEGER,     -- [新增] 加购人数
            
            -- 指标
            aov REAL,               -- [新增] 客单价
            conversion_rate REAL,   -- 支付转化率
            
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(record_date, platform, sku_id) ON CONFLICT REPLACE
        )
    `);
    db.close();
}

// ======================= [工具函数] =======================

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getMissingTasks() {
    console.log(`\n--- 步骤 A: 计算最近 ${LOOKBACK_DAYS} 天任务 ---`);
    const db = new Database(DATABASE_PATH);
    const existing = new Set();
    try {
        const rows = db.prepare("SELECT DISTINCT record_date, platform FROM sales_history").all();
        rows.forEach(r => existing.add(`${r.record_date}|${r.platform}`));
    } catch (e) {}
    db.close();

    const tasks = [];
    const today = new Date();
    for (let i = 1; i <= LOOKBACK_DAYS; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = formatDate(d);
        for (const platform of TARGET_PLATFORMS) {
            if (!existing.has(`${dateStr}|${platform}`)) {
                tasks.push({ date: dateStr, platform: platform });
            }
        }
    }
    tasks.sort((a, b) => a.date.localeCompare(b.date) || TARGET_PLATFORMS.indexOf(a.platform) - TARGET_PLATFORMS.indexOf(b.platform));
    console.log(`   📉 待执行: ${tasks.length} 个任务`);
    return tasks;
}

// ======================= [核心交互逻辑 - 老兵回归] =======================

// 1. 强力清空下载列表
async function clearDownloadList(page) {
    try {
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
        if (!await downloadManagerIcon.isVisible()) return;

        await downloadManagerIcon.click();
        await page.waitForTimeout(500);

        let retry = 0;
        while (retry < 20) {
            const deleteBtns = page.getByRole('button', { name: 'delete' });
            const count = await deleteBtns.count();
            if (count === 0) break;
            await deleteBtns.first().click();
            await page.waitForTimeout(300);
            retry++;
        }
        await page.keyboard.press('Escape'); 
        await page.waitForTimeout(300);
    } catch (error) {
        console.warn('      ⚠️ 清理列表轻微异常, 尝试继续...');
        await page.keyboard.press('Escape').catch(()=>{});
    }
}

// 2. 设置筛选条件 (★★★ 核心：恢复“老兵”日期逻辑 ★★★)
async function setFiltersAndQuery(page, dateStr, platformName) {
    console.log(`      ⚙️ 设置筛选: [${dateStr}] [${platformName}]`);

    // --- 开始日期 (原汁原味的老兵逻辑) ---
    const startDatePicker = page.locator('div.ant-picker').first();
    const startDateInput = startDatePicker.locator('input');
    
    // 显式检查清除按钮
    const startClearButton = startDatePicker.locator('span.ant-picker-clear');
    if (await startClearButton.isVisible({ timeout: 2000 })) { 
        await startClearButton.click(); 
    }
    
    await startDateInput.click();
    // 必须等待面板弹出
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await startDateInput.fill(dateStr);
    
    // 在可见面板中点击
    const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
    await visiblePanelStart.locator(`td[title="${dateStr}"]`).click();
    // 等待面板消失
    await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });


    // --- 结束日期 (原汁原味) ---
    const endDatePicker = page.locator('div.ant-picker').nth(1);
    const endDateInput = endDatePicker.locator('input');
    
    const endClearButton = endDatePicker.locator('span.ant-picker-clear');
    if (await endClearButton.isVisible({ timeout: 2000 })) { 
        await endClearButton.click(); 
    }
    
    await endDateInput.click();
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await endDateInput.fill(dateStr);
    
    const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
    await visiblePanelEnd.locator(`td[title="${dateStr}"]`).click();
    await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });


    // --- 平台设置 (维持 v19 的强力清空) ---
    const selector = page.locator('.ant-select-selector').first();
    const removeIcons = page.locator('.ant-select-selection-item-remove');
    while (await removeIcons.count() > 0) { 
        await removeIcons.first().click(); 
        await page.waitForTimeout(50);
    }
    
    await selector.click();
    await page.keyboard.type(platformName, { delay: 100 });
    await page.waitForTimeout(800); // 给足渲染时间

    const option = page.locator(`.ant-select-item-option-content:has-text("${platformName}")`).first();
    if (!await option.isVisible()) {
        console.warn(`      ❌ 无法找到平台选项: ${platformName}`);
        return false;
    }
    await option.click();
    await page.keyboard.press('Escape'); 

    // --- 点击查询并等待 ---
    console.log(`      🖱️ 点击查询...`);
    
    // 网络监听双保险
    const responsePromise = page.waitForResponse(resp => 
        resp.url().includes('dashboard') && resp.status() === 200, 
        { timeout: 15000 }
    ).catch(() => null);

    await page.getByRole('button', { name: '查 询' }).first().click();
    
    await responsePromise; 
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000); // 宁可多等3秒，不要拿到旧数据

    return true;
}

// 3. 下载流程
async function downloadTop20(page, dateStr, platformName) {
    console.log(`      🎯 提取 TOP20 数据...`);
    
    const widget = page.locator('.gridItem--WrCz6', { has: page.locator('text="销售额TOP20"') }).last();
    if (!await widget.isVisible()) return null;

    // 悬停并点击
    await widget.hover();
    await widget.locator('.anticon-download').click();
    
    // 处理气泡
    await page.waitForTimeout(1000);
    const popover = page.locator('.ant-popover-content:visible');
    if (await popover.isVisible()) {
        await popover.locator('img, svg, button').first().click();
    }

    console.log(`      ⏳ 等待文件生成...`);
    const downloadIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
    await downloadIcon.click();

    const firstItem = page.locator('li[class^="item--"]').first();
    
    // 增加超时时间到 3 分钟，防止生成慢
    await firstItem.waitFor({ state: 'visible', timeout: 180000 });
    
    // 文件名防呆校验
    const fileName = await firstItem.innerText();
    if (!fileName.includes('销售额TOP20')) {
        console.error(`      ❌ 异常：文件名为 [${fileName}]，不是目标文件！`);
        await page.keyboard.press('Escape');
        return null;
    }

    await firstItem.locator('span.ant-tag:text("成功")').waitFor({ state: 'visible', timeout: 60000 });

    const downloadPromise = page.waitForEvent('download');
    await firstItem.locator('p[class^="success--"]').click();
    const download = await downloadPromise;

    if (!fs.existsSync(DOWNLOAD_DIRECTORY)) fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true });
    const saveName = `${dateStr}_${platformName}_TOP20.xlsx`;
    const savePath = path.join(DOWNLOAD_DIRECTORY, saveName);
    
    await download.saveAs(savePath);
    console.log(`      💾 已保存: ${saveName}`);
    await page.keyboard.press('Escape');
    
    return savePath;
}

// 4. 入库 (全字段映射版)
function importToDB(filePath, dateStr, platformName) {
    const db = new Database(DATABASE_PATH);
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (data.length === 0) { db.close(); return; }

    // 准备插入语句 (包含所有新字段)
    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO sales_history 
        (record_date, platform, sku_id, product_name, category, barcode, 
         visitor_count, page_views, favorites, 
         order_buyers, order_items, order_amount,
         sales_volume, sales_users, sales_amount,
         cart_items, cart_users, aov, conversion_rate)
        VALUES (@date, @plat, @sku, @name, @cat, @bc, 
                @uv, @pv, @fav, 
                @ob, @oi, @oa,
                @sv, @su, @sa,
                @ci, @cu, @aov, @rate)
    `);

    const transaction = db.transaction((rows) => {
        for (const row of rows) {
            // 数据清洗辅助函数 (防止空值报错)
            const cleanInt = (v) => parseInt(v) || 0;
            const cleanFloat = (v) => parseFloat(v) || 0.0;
            const cleanStr = (v) => String(v || '').trim();

            // [关键] 这里的中文键名必须和 Excel 表头完全一致！
            const record = {
                date: dateStr,
                plat: platformName,
                sku: cleanStr(row['平台商品id'] || row['商品ID']),
                name: cleanStr(row['商品名称'] || row['产品名称']),
                cat: cleanStr(row['类目'] || row['一级类目']),
                bc:  cleanStr(row['商品69码'] || row['69码'] || row['条形码']), // 抓取69码
                
                // 流量
                uv: cleanInt(row['访客数']),
                pv: cleanInt(row['浏览量']),
                fav: cleanInt(row['收藏量']),
                
                // 下单
                ob: cleanInt(row['下单买家数']),
                oi: cleanInt(row['下单件数']),
                oa: cleanFloat(row['下单金额']),
                
                // 支付
                sv: cleanInt(row['支付数量'] || row['支付件数']), // 兼容不同表头写法
                su: cleanInt(row['支付用户数']),
                sa: cleanFloat(row['支付金额']),
                
                // 加购
                ci: cleanInt(row['加购件数']),
                cu: cleanInt(row['加购人数']),
                
                // 指标
                aov: cleanFloat(row['客单价']),
                rate: cleanFloat(row['支付转化率'] || row['转化率'])
            };
            
            if (record.sku) insertStmt.run(record);
        }
    });

    transaction(data);
    db.close();
    console.log(`      ✅ 入库 ${data.length} 条 (全字段) | 归档中...`);

    if (!fs.existsSync(ARCHIVE_DIRECTORY)) fs.mkdirSync(ARCHIVE_DIRECTORY, { recursive: true });
    const destPath = path.join(ARCHIVE_DIRECTORY, path.basename(filePath));
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(filePath, destPath);
}

// ======================= [主流程] =======================

async function main() {
    console.log("🚀 --- [v20] 销售额TOP20 完全体 (老兵回归) ---");
    initDatabase();
    
    const tasks = getMissingTasks();
    if (tasks.length === 0) return console.log("✅ 无需更新。");

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('\n--- 登录后台 ---');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=857');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForLoadState('networkidle', { timeout: 60000 });

        for (const task of tasks) {
            console.log(`\n🔹 [${task.date}] [${task.platform}] 任务开始...`);
            
            // 强制刷新：这是清除缓存最有效的手段
            console.log(`      🔄 强制刷新页面...`);
            await page.reload({ waitUntil: 'networkidle' });
            
            await clearDownloadList(page);

            const filterOk = await setFiltersAndQuery(page, task.date, task.platform);
            if (filterOk) {
                const filePath = await downloadTop20(page, task.date, task.platform);
                if (filePath) {
                    importToDB(filePath, task.date, task.platform);
                } else {
                    console.error(`      ❌ 下载失败，跳过入库`);
                }
            }
        }

    } catch (e) {
        console.error('❌ 运行中断:', e);
    } finally {
        await browser.close();
        console.log('🏁 脚本结束');
    }
}

main();