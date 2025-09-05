/**
 * ================================================================================
 * 拼多多平台 价格监控脚本 (v11.0 - JS版 - API拦截)
 *
 * 更新日志 (v11.0 JS):
 * - [技术栈] 从 Python/Pandas/Playwright(sync) 迁移到 Node.js/ExcelJS/Playwright(async)。
 * - [核心逻辑] 保持通过监听网络请求，直接捕获商品详情API的JSON响应数据的方案。
 * - [数据解析] 直接从干净的JSON数据中解析出所有SKU的价格信息。
 * - [环境友好] 使用NPM管理依赖，避免复杂的Python环境问题。
 * ================================================================================
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const playwright = require('playwright-extra');
const { devices } = require('playwright-core');
const stealth = require('puppeteer-extra-plugin-stealth')();

// 将stealth插件添加到chromium
playwright.chromium.use(stealth);


// ============================================================================
// --- 配置区 ---
// ============================================================================
const EXCEL_TASK_FILE_PATH = path.join(__dirname, 'products_多多.xlsx');
const EXCEL_OUTPUT_PATH = path.join(__dirname, 'Results', 'products_多多_Results.xlsx');
const USER_DATA_DIR = path.join(__dirname, 'pdd-auth-profile');

const URL_COLUMN_HEADER = "URL";
const PLATFORM_COLUMN_HEADER = "Platform";
const SKU_COLUMN_HEADER = "SKUsToScrape";
const PLATFORM_NAME = "拼多多";

const PRICE_COLUMN_HEADER = "Price";
const DATE_COLUMN_HEADER = "Date";


// ============================================================================
// --- 核心函数区 ---
// ============================================================================

/**
 * 安全地将新记录追加到Excel文件中
 * @param {string} filePath - Excel文件路径
 * @param {Array<Object>} newRecords - 要添加的新记录数组
 */
async function saveResults(filePath, newRecords) {
    if (!newRecords || newRecords.length === 0) {
        console.log("   没有新的记录需要保存。");
        return;
    }

    const workbook = new ExcelJS.Workbook();
    const outputDir = path.dirname(filePath);

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    let worksheet;
    let headers = Object.keys(newRecords[0]);

    if (fs.existsSync(filePath)) {
        try {
            await workbook.xlsx.readFile(filePath);
            worksheet = workbook.getWorksheet(1); // 获取第一个工作表
            console.log(`   成功读取现有文件: ${filePath}`);
        } catch (e) {
            console.log(`   读取旧文件失败: ${e.message}，将创建新工作表。`);
            worksheet = workbook.addWorksheet('Results');
            worksheet.addRow(headers);
        }
    } else {
        worksheet = workbook.addWorksheet('Results');
        worksheet.addRow(headers);
    }
    
    // 添加新行
    newRecords.forEach(record => {
        // 确保记录顺序与表头一致
        const row = headers.map(header => record[header]);
        worksheet.addRow(row);
    });

    await workbook.xlsx.writeFile(filePath);
}


/**
 * 从API返回的JSON数据中，根据SKU任务查找对应的价格。
 * @param {Object} apiData - 商品详情API返回的JSON对象。
 * @param {string} skuTask - Excel中定义的SKU任务字符串，例如 "流光白,128GB"。
 * @returns {number|string} 价格 (float) 或 错误信息 (string)。
 */
function findSkuPriceFromJson(apiData, skuTask) {
    try {
        const skusList = apiData.store.goodsSkus;
        const specsMap = new Map(apiData.store.goodsSpecs.map(spec => [spec.spec_key, spec]));

        const targetSkuSpecs = new Set(skuTask.split(',').map(s => s.trim()));
        
        for (const sku of skusList) {
            const currentSkuSpecNames = new Set();
            for (const specItem of sku.specs) {
                const specKey = specItem.spec_key;
                const specValueId = specItem.spec_value_id;

                if (specsMap.has(specKey)) {
                    const specDefinition = specsMap.get(specKey);
                    const valueFound = specDefinition.spec_values.find(v => v.spec_value_id === specValueId);
                    if (valueFound) {
                        currentSkuSpecNames.add(valueFound.spec_value);
                    }
                }
            }
            
            // 检查两个Set是否完全相等
            if (targetSkuSpecs.size === currentSkuSpecNames.size && 
                [...targetSkuSpecs].every(spec => currentSkuSpecNames.has(spec))) {
                
                // 价格通常以“分”为单位
                const priceInFen = sku.groupPrice;
                return priceInFen / 100.0;
            }
        }
        return "SKU Not Matched";
    } catch (e) {
        console.error(`      ❌ 解析JSON时出错: ${e.message}`);
        return "JSON Parse Error";
    }
}


async function main() {
    console.log(`--- ${PLATFORM_NAME}监控脚本 (v11.0 - JS版 - API拦截) 启动 ---`);

    if (!fs.existsSync(USER_DATA_DIR)) {
        console.error(`致命错误: 用户数据目录 '${USER_DATA_DIR}' 未找到!`);
        console.error(">>> 请先运行 'node pdd_login.js' 脚本以生成登录目录。");
        return;
    }
    
    let allTasks = [];
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(EXCEL_TASK_FILE_PATH);
        const worksheet = workbook.getWorksheet(1);
        const headers = worksheet.getRow(1).values.slice(1); // 获取表头
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // 跳过表头行
                const task = {};
                row.values.slice(1).forEach((value, index) => {
                    task[headers[index]] = value;
                });
                allTasks.push(task);
            }
        });
        console.log(`[1/3] 成功从 '${EXCEL_TASK_FILE_PATH}' 读取 ${allTasks.length} 条总任务。`);
    } catch (e) {
        console.error(`致命错误: 读取任务文件失败: ${e.message}`);
        return;
    }

    const tasksToRun = allTasks.filter(task => task[PLATFORM_COLUMN_HEADER] === PLATFORM_NAME);
    console.log(`   筛选出 ${tasksToRun.length} 条 “${PLATFORM_NAME}” 平台的任务。`);

    const todayStr = new Date().toISOString().split('T')[0];
    const newRecordsThisSession = [];
    
    let context;
    try {
        console.log("[2/3] 正在启动带持久化目录和隐身功能的浏览器...");
        const iphone12ProConfig = devices['iPhone 12 Pro'];
        
        context = await playwright.chromium.launchPersistentContext(USER_DATA_DIR, {
            ...iphone12ProConfig,
            headless: false, // 后台运行以提高效率
            args: ['--disable-blink-features=AutomationControlled'],
            locale: 'zh-CN'
        });
        console.log("SUCCESS: 浏览器启动成功。\n");

        console.log(`[3/3] 开始处理商品... (日期: ${todayStr})`);
        
        for (let i = 0; i < tasksToRun.length; i++) {
            const task = tasksToRun[i];
            let page = null;
            try {
                page = await context.newPage();
                
                const url = task[URL_COLUMN_HEADER];
                const skusStr = String(task[SKU_COLUMN_HEADER] || '');
                console.log(`\n--- 正在处理第 ${i + 1}/${tasksToRun.length} 行: ${url.substring(0, 60)}... ---`);

                // 核心：设置网络监听器来捕获API响应
                const apiDataPromise = new Promise((resolve, reject) => {
                    page.on('response', async (response) => {
                        if (response.url().includes("api.pinduoduo.com/api/goods/detail")) {
                            console.log(`   截获到目标API响应: ${response.url()}`);
                            try {
                                const json = await response.json();
                                resolve(json);
                            } catch (e) {
                                console.log(`   ❌ API响应JSON解析失败: ${e.message}`);
                                reject(new Error("API JSON Parse Failed"));
                            }
                        }
                    });
                });

                // 访问页面以触发API请求，并设置超时
                await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
                
                // 等待API数据，或者超时
                const apiData = await Promise.race([
                    apiDataPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("API Interception Timeout")), 20000))
                ]);

                if (!apiData) {
                    throw new Error("未能成功截获商品详情API的数据。");
                }
                console.log("   ✅ 成功获取API数据包。");

                const skuTasks = skusStr.split(';').map(s => s.trim()).filter(Boolean);

                if (skuTasks.length === 0) { // 如果SKU列为空, 获取默认价格
                    const defaultPrice = apiData.store.groupPrice / 100.0;
                    const newRecord = { ...task };
                    newRecord[DATE_COLUMN_HEADER] = todayStr;
                    newRecord[SKU_COLUMN_HEADER] = 'default';
                    newRecord[PRICE_COLUMN_HEADER] = defaultPrice;
                    newRecordsThisSession.push(newRecord);
                    console.log(`     - [default] 价格: ${defaultPrice}`);
                } else {
                    for (const skuTask of skuTasks) {
                        console.log(`     - 开始解析任务: [${skuTask}]`);
                        const price = findSkuPriceFromJson(apiData, skuTask);
                        const newRecord = { ...task };
                        newRecord[DATE_COLUMN_HEADER] = todayStr;
                        newRecord[SKU_COLUMN_HEADER] = skuTask;
                        newRecord[PRICE_COLUMN_HEADER] = price;
                        newRecordsThisSession.push(newRecord);
                        console.log(`       价格: ${price}`);
                    }
                }

            } catch (e) {
                console.error(`   ❌ 页面处理失败: ${e.message.split('\n')[0]}`);
                const errorRecord = { ...task };
                errorRecord[DATE_COLUMN_HEADER] = todayStr;
                errorRecord[PRICE_COLUMN_HEADER] = "Page Error";
                newRecordsThisSession.push(errorRecord);
            } finally {
                if (page) await page.close();
            }
        }
    } catch (e) {
        console.error(`\n--- 发生严重错误 ---: ${e.message}`);
    } finally {
        if (context) await context.close();
        
        console.log("\n--- 正在执行最终保存操作... ---");
        await saveResults(EXCEL_OUTPUT_PATH, newRecordsThisSession);
        console.log(`🎉🎉🎉 最终 ${newRecordsThisSession.length} 条新记录已成功保存至 '${EXCEL_OUTPUT_PATH}'`);
        console.log("脚本执行完毕。");
    }
}

// 启动主程序
main();