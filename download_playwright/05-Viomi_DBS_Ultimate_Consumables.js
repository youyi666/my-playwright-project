// 08-Viomi_DBS_Refined_Fix.js - 针对“包含耗材”表格的深度修复版
//
// 1. [登录升级] 扫描页面所有可见 Input，自动识别账号/密码框填充，兼容性更强。
// 2. [耗材修复] 使用 "包含耗材" 文字作为锚点，精准定位并解析紧随其后的复杂表格。
// 3. [数据清洗] 专门处理 table-box / img-box 这种深层嵌套结构。

import { chromium } from 'playwright';
import path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import xlsx from 'xlsx';
import { fileURLToPath } from 'url';

// --- 基础配置 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

const DB_FILE = path.join(__dirname, 'sql_data', 'ProductDataCenter.db');
const TASKS_EXCEL_PATH = 'D:\\price_scraper\\tasks.xlsx';
const DB_TABLE_NAME = 'dbs_product_details';

// --- 辅助函数 ---

function initDatabase() {
    const dbDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(DB_FILE);
    
    // 确保包含 consumables_json 字段
    const createSql = `
        CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (
            barcode TEXT PRIMARY KEY,
            product_name TEXT,
            product_model TEXT,
            erp_code TEXT,
            sku_id TEXT,
            net_weight REAL,
            gross_weight REAL,
            dim_prod_l REAL, dim_prod_w REAL, dim_prod_h REAL,
            dim_pkg_l REAL, dim_pkg_w REAL, dim_pkg_h REAL,
            image_url TEXT,
            is_wifi TEXT,
            category_path TEXT,
            unit TEXT,
            consumables_json TEXT,  -- 存储耗材信息
            market_price TEXT,
            tax_rate TEXT,
            purchase_entity TEXT,
            software_entity TEXT,
            update_time TEXT,
            scrape_time TEXT
        )
    `;
    db.exec(createSql);
    db.close();
}

function parseDimensions(dimString) {
    if (!dimString || typeof dimString !== 'string') return { l: 0, w: 0, h: 0 };
    const parts = dimString.toLowerCase().split('x').map(s => parseFloat(s.trim()));
    return { l: parts[0] || 0, w: parts[1] || 0, h: parts[2] || 0 };
}

function findVal(rawData, section, subSection, labelName) {
    try {
        return rawData[section]?.[subSection]?.find(i => i.label === labelName)?.value || null;
    } catch (e) { return null; }
}

function getTaskCodes() {
    if (!fs.existsSync(TASKS_EXCEL_PATH)) return [];
    const wb = xlsx.readFile(TASKS_EXCEL_PATH);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    return [...new Set(rows.map(r => String(r['ProductID']).trim()).filter(c => c && c.length > 6))];
}

// --- 主程序 ---

async function main() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
        console.error('❌ 请设置环境变量 VIOMI_USERNAME 和 VIOMI_PASSWORD');
        process.exit(1);
    }

    initDatabase();
    const taskCodes = getTaskCodes();
    if (taskCodes.length === 0) {
        console.log('⚠️ 没有任务，退出。');
        return;
    }

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // --- 1. 登录 (升级版) ---
        console.log('➡️ 登录云米门户...');
        await page.goto('https://su.viomi.com.cn/super/login.html');

        try {
            await page.waitForSelector('input', { timeout: 5000 });
            
            // 策略：找到所有可见的输入框
            const visibleInputs = await page.locator('input:visible').all();
            let filled = false;

            if (visibleInputs.length >= 2) {
                console.log(`   🔑 发现 ${visibleInputs.length} 个输入框，尝试填充...`);
                
                // 1. 填账号：通常是第一个可见框
                await visibleInputs[0].fill(VIOMI_USERNAME);
                
                // 2. 填密码：寻找 type="password" 的框，找不到就填第二个可见框
                const pwInput = page.locator('input[type="password"]:visible').first();
                if (await pwInput.isVisible()) {
                    await pwInput.fill(VIOMI_PASSWORD);
                } else {
                    await visibleInputs[1].fill(VIOMI_PASSWORD);
                }
                
                // 3. 点击登录
                const loginBtn = page.locator('.login-btn, button[type="button"], div[role="button"]').filter({ hasText: /登录|Login/ }).first();
                if (await loginBtn.isVisible()) {
                    await loginBtn.click();
                } else {
                    await page.keyboard.press('Enter');
                }
                filled = true;
                await page.waitForTimeout(2000);
            } 
            
            if (!filled) console.log('   ⚠️ 未找到合适的输入框，跳过自动填充。');

        } catch (e) { console.log('   ℹ️ 登录流程跳过或出错:', e.message); }

        // --- 2. 跳转与搜索 ---
        console.log('➡️ 跳转 DBS 系统...');
        const page2Promise = page.waitForEvent('popup');
        await page.locator('text=DBS 基础资料平台').first().click();
        const dbsPage = await page2Promise;
        await dbsPage.waitForLoadState('networkidle');

        console.log('➡️ 进入产品资料菜单...');
        await dbsPage.getByText('产品基础资料管理').click();
        await dbsPage.getByRole('menuitem', { name: '产品资料管理' }).click();

        const searchTypeInput = dbsPage.getByRole('textbox', { name: '请选择' }).first();
        const searchContentInput = dbsPage.getByRole('textbox', { name: '多个请使用英文逗号分隔' });
        const searchBtn = dbsPage.getByRole('button', { name: '搜索' });

        const db = new Database(DB_FILE);
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO ${DB_TABLE_NAME} (
                barcode, product_name, product_model, erp_code, sku_id,
                net_weight, gross_weight, 
                dim_prod_l, dim_prod_w, dim_prod_h,
                dim_pkg_l, dim_pkg_w, dim_pkg_h,
                image_url, is_wifi, category_path, unit,
                consumables_json, 
                market_price, tax_rate, purchase_entity, software_entity,
                update_time, scrape_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // --- 3. 循环任务 ---
        for (const code of taskCodes) {
            console.log(`\n🔍 处理 69码: [${code}]`);
            try {
                await searchTypeInput.click();
                await dbsPage.getByText('产品69码', { exact: true }).click();
                await searchContentInput.fill(code);
                await searchBtn.click();
                await dbsPage.waitForTimeout(1500);

                const viewBtn = dbsPage.getByRole('button', { name: '查看' }).first();
                if (!(await viewBtn.isVisible())) {
                    console.log(`   ⚠️ 未找到记录`);
                    continue;
                }

                const popupPromise = dbsPage.waitForEvent('popup');
                await viewBtn.click();
                const detailPage = await popupPromise;
                await detailPage.waitForLoadState('domcontentloaded');
                await detailPage.waitForSelector('.container-box', { timeout: 15000 });

                // [关键修复]：显式等待 "包含耗材" 文字出现，确保表格已加载
                try {
                    // 等待包含文本的元素出现，不一定要等待整个表格，只要文字出来，表格通常就在附近
                    await detailPage.waitForSelector('text="包含耗材"', { timeout: 3000 }).catch(() => {});
                } catch(e) {}

                // --- 4. 浏览器内抓取 (Evaluate) ---
                const pageData = await detailPage.evaluate(() => {
                    const res = { raw: {}, consumables: [] };
                    const clean = t => t ? t.replace(/\s+/g, ' ').trim() : '';

                    // A. 常规数据 (Label - Value 模式)
                    const container = document.querySelector('.container-box');
                    if (container) {
                        let sec = 'Default', sub = 'Default';
                        for (const el of Array.from(container.children)) {
                            if (el.tagName === 'H3' || el.matches('.m-title')) { sec = clean(el.innerText); res.raw[sec] = {}; sub = 'General'; }
                            else if (el.tagName === 'H4') { sub = clean(el.innerText); if (!res.raw[sec]) res.raw[sec] = {}; res.raw[sec][sub] = []; }
                            else {
                                const items = el.matches('.el-form-item') ? [el] : el.querySelectorAll('.el-form-item');
                                for (const item of items) {
                                    const label = clean(item.querySelector('.el-form-item__label')?.innerText);
                                    const content = item.querySelector('.el-form-item__content');
                                    let val = null;
                                    if (content) {
                                        const imgs = content.querySelectorAll('img');
                                        if (imgs.length) val = Array.from(imgs).map(i => i.src);
                                        else {
                                            const inputs = Array.from(content.querySelectorAll('input:not([type="hidden"]), textarea'));
                                            if (inputs.length) {
                                                const texts = inputs.filter(i => i.type !== 'radio' && i.type !== 'checkbox').map(i => i.value);
                                                if (inputs[0].type === 'radio') {
                                                    const checked = content.querySelector('.is-checked .el-radio__label');
                                                    val = checked ? clean(checked.innerText) : '';
                                                } else val = texts.length > 1 ? texts.join(' x ') : texts[0];
                                            } else val = clean(content.innerText);
                                        }
                                    }
                                    if (!res.raw[sec]) res.raw[sec] = {}; if (!res.raw[sec][sub]) res.raw[sec][sub] = [];
                                    res.raw[sec][sub].push({ label, value: val });
                                }
                            }
                        }
                    }

                    // B. [核心修复] 耗材表格提取
                    // 逻辑：找到包含“包含耗材”文本的所有元素，往回找它的容器，然后在该容器内找 table
                    // 这是为了应对 <div title="需要安装"> ... 包含耗材 ... table ... </div> 的结构
                    
                    // 1. 找到所有包含“包含耗材”文本的节点
                    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    let targetTable = null;

                    while(node = textNodes.nextNode()) {
                        if(node.nodeValue.includes('包含耗材')) {
                            // 找到文字节点，向上找几层父级，看能不能找到 table 的兄弟
                            let parent = node.parentElement; 
                            // 尝试在父级或父级的父级中找 .el-table
                            // 你的 HTML 结构：div(包含文本) -> sibling div -> table
                            // 或者是：div(包含文本) -> parent -> sibling -> table
                            
                            // 向上查找 5 层
                            for(let i=0; i<5; i++) {
                                if(!parent) break;
                                const table = parent.querySelector('.el-table');
                                if(table) {
                                    targetTable = table;
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                        }
                        if(targetTable) break;
                    }

                    if (targetTable) {
                        const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
                        for (const row of rows) {
                            const cols = row.querySelectorAll('td');
                            // 根据 HTML 结构分析：
                            // Col 0: 耗材编码 (Input)
                            // Col 1: 图片 (img)
                            // Col 2: 名称 (div.img-box > div)
                            // Col 3: 物料编码 (div.img-box > div)
                            // Col 5: 69码 (div.img-box > div)
                            
                            if (cols.length >= 6) {
                                const getTextDeep = (cell) => {
                                    if(!cell) return '';
                                    // 优先看 input
                                    const input = cell.querySelector('input');
                                    if (input && input.value) return clean(input.value);
                                    // 再看 img-box 下的 div (针对名称列)
                                    const deepDiv = cell.querySelector('.img-box > div');
                                    if (deepDiv) return clean(deepDiv.innerText);
                                    // 最后看纯文本
                                    return clean(cell.innerText);
                                };

                                const item = {
                                    name: getTextDeep(cols[2]),      // 关键：名称
                                    code: getTextDeep(cols[0]),      // 编码
                                    material: getTextDeep(cols[3]),  // 物料
                                    barcode: getTextDeep(cols[5]),   // 69码
                                    image: cols[1].querySelector('img')?.src || ''
                                };

                                if (item.name && item.name !== '无需填写，系统自动生成') {
                                    res.consumables.push(item);
                                }
                            }
                        }
                    }

                    return res;
                });

                await detailPage.close();

                // C. 数据清洗与入库
                const raw = pageData.raw;
                const base = '商品基础信息详情', subBase = '基础信息', subExt = '扩展属性', subList = '上市信息', subFin = '财务信息', subSys = '系统信息';
                const prodDims = parseDimensions(findVal(raw, base, subBase, '产品尺寸（mm）'));
                const pkgDims = parseDimensions(findVal(raw, base, subBase, '产品外包装尺寸（mm）'));
                const imgRaw = findVal(raw, base, subBase, '产品主图');

                const cleanData = {
                    barcode: code,
                    product_name: findVal(raw, base, subBase, '产品名称'),
                    product_model: findVal(raw, base, subBase, '产品型号'),
                    erp_code: findVal(raw, base, subBase, 'erp物料编码'),
                    sku_id: findVal(raw, base, subBase, 'skuid'),
                    net_weight: parseFloat(findVal(raw, base, subBase, '净重(kg)')) || 0,
                    gross_weight: parseFloat(findVal(raw, base, subBase, '产品毛重(kg)')) || 0,
                    dim_prod_l: prodDims.l, dim_prod_w: prodDims.w, dim_prod_h: prodDims.h,
                    dim_pkg_l: pkgDims.l, dim_pkg_w: pkgDims.w, dim_pkg_h: pkgDims.h,
                    image_url: Array.isArray(imgRaw) ? imgRaw[0] : imgRaw,
                    is_wifi: findVal(raw, base, subBase, '是否支持联网'),
                    category_path: findVal(raw, base, subExt, '产品分类'),
                    unit: findVal(raw, base, subBase, '基本包装单位'),
                    
                    consumables_json: JSON.stringify(pageData.consumables), // 存入
                    
                    market_price: findVal(raw, base, subList, '建议零售价（元）'),
                    tax_rate: findVal(raw, base, subFin, '税率'),
                    purchase_entity: findVal(raw, base, subFin, '当前采购主体'),
                    software_entity: findVal(raw, base, subFin, '当前软件主体'),
                    update_time: findVal(raw, base, subSys, '更新时间'),
                    scrape_time: new Date().toLocaleString()
                };

                insertStmt.run(
                    cleanData.barcode, cleanData.product_name, cleanData.product_model, cleanData.erp_code, cleanData.sku_id,
                    cleanData.net_weight, cleanData.gross_weight,
                    cleanData.dim_prod_l, cleanData.dim_prod_w, cleanData.dim_prod_h,
                    cleanData.dim_pkg_l, cleanData.dim_pkg_w, cleanData.dim_pkg_h,
                    cleanData.image_url, cleanData.is_wifi, cleanData.category_path, cleanData.unit,
                    cleanData.consumables_json,
                    cleanData.market_price, cleanData.tax_rate, cleanData.purchase_entity, cleanData.software_entity,
                    cleanData.update_time, cleanData.scrape_time
                );

                console.log(`   ✅ 入库成功: ${cleanData.product_name}`);
                if (pageData.consumables.length > 0) {
                    console.log(`      🔗 抓取到 ${pageData.consumables.length} 个耗材 (例如: ${pageData.consumables[0].name})`);
                } else {
                    console.log(`      ℹ️ 该商品无耗材信息 (或抓取未命中)`);
                }

            } catch (err) {
                console.error(`   ❌ 错误: ${err.message}`);
                if (dbsPage.pages().length > 1) await dbsPage.pages()[1].close().catch(() => {});
            }
        }
        db.close();

    } catch (e) {
        console.error('❌ 程序异常:', e);
    } finally {
        await browser.close();
        console.log('--- 任务结束 ---');
    }
}

main();