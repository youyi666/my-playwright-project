// price-change.cjs - [模块化改造与多店隔离完成版]

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');

// ======================= [全局配置区域] =======================
const STRATEGY = 'conservative';
const MAX_PRICE_DROP_LIMIT = 0.3; 

const DB_PATH = path.join(__dirname, '..', '00_Shared_Database数据库', 'TmallDataCenter.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`\n[致命错误] 找不到数据库文件！`);
    process.exit(1);
} else {
    console.log(`[系统日志] 成功锁定数据库: ${DB_PATH}`);
}

/**
 * 异常日志持久化写入 CSV (按店铺隔离)
 */
function logErrorToCSV(storeName, id, name, errorMsg) {
    const time = new Date().toLocaleString();
    const safeName = name ? name.replace(/,/g, ' ') : '未知'; 
    const safeError = errorMsg.replace(/,/g, ' ').replace(/\n/g, ' ');
    const row = `"${storeName}","${time}","${id}","${safeName}","${safeError}"\n`;
    
    // 动态生成属于该店铺的专用报错文件
    const ERROR_CSV_PATH = path.join(__dirname, `error_tasks_${storeName}.csv`);
    
    if (!fs.existsSync(ERROR_CSV_PATH)) {
        fs.writeFileSync(ERROR_CSV_PATH, '\uFEFF"店铺","时间","商品ID","商品名称","失败原因"\n');
    }
    fs.appendFileSync(ERROR_CSV_PATH, row);
}

/**
 * 成功调价持久化写入 CSV (按店铺隔离)
 */
function logSuccessToCSV(storeName, id, name, oldPrice, newPrice, rivalPrice, limitPrice, strategyUsed) {
    const time = new Date().toLocaleString();
    const safeName = name ? name.replace(/,/g, ' ') : '未知';
    const basis = `竞对极低价:${rivalPrice} | 设定的底线价:${limitPrice} | 采用策略:${strategyUsed}`;
    const row = `"${storeName}","${time}","${id}","${safeName}","${oldPrice}","${newPrice}","${basis}"\n`;
    
    // 动态生成属于该店铺的专用成功日志文件
    const SUCCESS_CSV_PATH = path.join(__dirname, `success_tasks_${storeName}.csv`);
    
    if (!fs.existsSync(SUCCESS_CSV_PATH)) {
        fs.writeFileSync(SUCCESS_CSV_PATH, '\uFEFF"店铺","执行时间","商品ID","商品名称","改前线上价","修改后价格","调价依据"\n');
    }
    fs.appendFileSync(SUCCESS_CSV_PATH, row);
}

function askConfirmation(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(`\x1b[41m\x1b[37m ⚠️ ${message} \x1b[0m (y/n): `, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
    }));
}

function calculateProposedPrice(rivalPrice, strategy) {
    if (strategy === 'aggressive') return (rivalPrice - 0.01).toFixed(2);
    if (strategy === 'equal') return rivalPrice.toFixed(2);
    return (Math.floor(rivalPrice / 10) * 10 + 9).toFixed(2);
}

async function tryClosePopups(page) {
    const closeSelectors = [
        '[data-testid="beast-core-modal-icon-close"]',
        '.beast-core-modal-close',
        'button:has-text("知道了")',
        'button:has-text("关闭")',
        '.ant-modal-close'
    ];
    for (const selector of closeSelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 发现干扰遮罩，执行强力清理...`);
                await btn.click({ force: true });
                await page.waitForTimeout(300);
            }
        } catch (e) {}
    }
}

async function configureActivityPage(page1, targetPriceStr, isPriceMatch, startDateObj = new Date()) {
    const startDayStr = startDateObj.getDate().toString();
    const endDateObj = new Date(startDateObj);
    endDateObj.setDate(startDateObj.getDate() + 6);
    const endDayStr = endDateObj.getDate().toString();
    const isCrossMonth = startDateObj.getMonth() !== endDateObj.getMonth();

    try {
        const datePicker = page1.getByTestId('beast-core-rangePicker-htmlInput');
        const hasDatePicker = await datePicker.isVisible({ timeout: 1500 }).catch(() => false);

        if (hasDatePicker) {
            console.log(` -> 📅 检测到【限时促销】，正在动态配置活动日期：今日起 7 天 (${startDayStr}号 至 ${endDayStr}号)...`);
            await datePicker.click({ force: true });
            const dropDownRoot = page1.getByTestId('beast-core-rangePicker-dropdown-contentRoot');
            
            const startDayCell = dropDownRoot.getByText(startDayStr, { exact: true });
            await startDayCell.nth(1).click({ force: true }); 
            await page1.waitForTimeout(400); 
            
            if (isCrossMonth) {
                console.log(' -> ⚠️ 注意：检测到 7 天促销期发生跨月，尝试执行日历翻页操作...');
                const nextMonthBtn = dropDownRoot.locator('.beast-core-rangePicker-next-month-btn, svg[data-icon="right"]');
                if (await nextMonthBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await nextMonthBtn.click({ force: true });
                    await page1.waitForTimeout(500); 
                } else {
                    console.log(' -> 🔍 未检测到独立的翻页按钮，假设面板为双月同屏显示，直接往下文查找...');
                }
            }

            const endDayCell = dropDownRoot.getByText(endDayStr, { exact: true });
            await endDayCell.last().click({ force: true });
            await page1.waitForTimeout(300);

            const confirmBtn = dropDownRoot.getByRole('button', { name: '确认' });
            await confirmBtn.click({ force: true });
            console.log(' -> ✅ 7 天日期范围表单配置已提交。');
        } else {
            console.log(' -> 📦 检测到【限量促销】(无日期输入框)，自动跳过时间配置步骤...');
        }
    } catch (error) {
        console.error(' -> ❌ 日期配置环节发生严重异常:', error.message);
        const errorImagePath = `error-logs/datepicker-crash-${Date.now()}.png`;
        try {
            await page1.screenshot({ path: errorImagePath, fullPage: true });
            console.log(` -> 📸 现场已保存至截图: ${errorImagePath}`);
        } catch (imgErr) {}
    }

    if (!isPriceMatch) {
        console.log(` -> 🔄 切换模式并填入目标价格: ${targetPriceStr}`);
        await page1.getByTestId('beast-core-table-header-tr').getByTestId('beast-core-icon-down').click();
        await page1.locator('[data-testid="beast-core-portal"]').getByText('活动价(元)', { exact: true }).click();
        await page1.waitForTimeout(800);
        
        const priceInput = page1.getByTestId('beast-core-table-body-tr').getByTestId('beast-core-inputNumber-htmlInput');
        await priceInput.click({ force: true });
        await priceInput.fill(targetPriceStr);
        
        await priceInput.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            node.dispatchEvent(new Event('blur', { bubbles: true }));
        });

        await page1.keyboard.press('Tab');
        await page1.waitForTimeout(800);

        const errorLocator = page1.locator('div[class*="Message_error"]').filter({ hasText: /建议优惠区间参考/ }).first();
        const fallbackLocator = page1.locator('text=/建议优惠区间参考/').first();

        if (await errorLocator.isVisible() || await fallbackLocator.isVisible()) {
            const errorText = await (await errorLocator.isVisible() ? errorLocator : fallbackLocator).innerText();
            throw new Error(`平台红线拦截 - ${errorText.trim()}`);
        }
        
        try {
            console.log('   🕵️ [安全扫描] 嗅探是否被默认勾选了“额外95折”...');
            const checkedIcon = page1.locator('#surpriseCouponCheck').getByTestId('beast-core-icon-check').first();
            if (await checkedIcon.isVisible({ timeout: 1500 })) {
                console.log('   🚨 [高危拦截] 检测到平台默认勾选了“额外95折”！正在强力拆除...');
                await checkedIcon.click({ force: true });
                await page1.waitForTimeout(500);
                
                if (!await checkedIcon.isVisible({ timeout: 500 })) {
                    console.log('   ✅ “额外95折”已成功取消勾选。');
                } else {
                    console.log('   ⚠️ 取消动作可能被 UI 拦截，请后续核查。');
                }
            } else {
                console.log('   🛡️ 状态安全：“额外95折”未被勾选 (或输入框未出现)。');
            }
        } catch (e) {
            console.log(`   ⚠️ [警告] 扫描“额外95折”时发生非致命异常，跳过排雷: ${e.message}`);
        }
    }

    await page1.getByRole('button', { name: '创建' }).click({ force: true });
    await page1.waitForTimeout(1000);
    const postClickError = page1.locator('div[class*="Message_error"]').filter({ hasText: /建议优惠区间参考/ }).first();
    if (await postClickError.isVisible()) {
        const postErrorText = await postClickError.innerText();
        throw new Error(`创建失败，触发平台红线 - ${postErrorText.trim()}`);
    }
}

// ======================= [核心主函数改造] =======================
// 剥离自身的浏览器启动代码，改为接收总控传入的 page 和 storeName
async function runPriceChangeTask(page, storeName) {
    console.log(`\n🚀 --- 拼多多价格卫兵 6.0 [模块化] - 当前店铺: ${storeName} ---`);
    const db = new Database(DB_PATH);
    const today = new Date(); 

    const pddProducts = db.prepare(`
        SELECT DISTINCT true_sku_id, sku_id, product_name 
        FROM price_history 
        WHERE platform = '拼多多' 
        AND sku_id IS NOT NULL 
        AND sku_id != 'N/A'
        AND date(record_time) = (SELECT MAX(date(record_time)) FROM price_history WHERE platform = '拼多多')
        AND (status NOT LIKE '%百亿补贴%' OR status IS NULL)
    `).all();

    const mappingCheckMap = {};
    for (const product of pddProducts) {
        if (!mappingCheckMap[product.true_sku_id]) {
            mappingCheckMap[product.true_sku_id] = new Set();
        }
        mappingCheckMap[product.true_sku_id].add(product.sku_id);
    }

    try {
        await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { waitUntil: 'domcontentloaded' });
        if (page.url().includes('login')) {
            console.log(` -> 🔑 [${storeName}] 等待手动扫码登录...`);
            await page.waitForURL(url => !url.href.includes('login'), { timeout: 300000 });
        }

        for (const product of pddProducts) {
            try {
                const goodsId = product.true_sku_id;
                console.log(`\n🔎 [检测中] ${product.product_name || '未知'} (ID: ${goodsId})`);
                
                if (mappingCheckMap[product.true_sku_id].size > 1) {
                    const conflictSkus = Array.from(mappingCheckMap[product.true_sku_id]).join(', ');
                    throw new Error(`[致命映射异常] 该 PDD 商品绑定了多个条码 (${conflictSkus})，存在乱价风险，强制熔断！`);
                }
                
                const rival = db.prepare(`
                    SELECT price as min_price, limit_price, platform, product_name, url 
                    FROM price_history 
                    WHERE sku_id = ? 
                    AND platform != '拼多多' 
                    AND datetime(record_time) >= datetime('now', '-24 hours', 'localtime') 
                    AND price > 100 
                    ORDER BY price ASC 
                    LIMIT 1
                `).get(product.sku_id);

                if (!rival?.min_price) { 
                    console.log(`   ⏭️  24h内无竞对比价，跳过。`);
                    continue;
                }

                const proposedPriceStr = calculateProposedPrice(rival.min_price, STRATEGY);
                const proposedPriceNum = parseFloat(proposedPriceStr);
                const limitPrice = rival.limit_price || 0;
                
                if (limitPrice > 0 && (limitPrice - proposedPriceNum) / limitPrice > MAX_PRICE_DROP_LIMIT) {
                    const drop = (((limitPrice - proposedPriceNum) / limitPrice) * 100).toFixed(1);
                    if (!await askConfirmation(`[${storeName}] 降价幅度(${drop}%)过大！是否执行调价？`)) continue;
                }

                await tryClosePopups(page);
                const searchInput = page.locator('input[data-testid="beast-core-input-htmlInput"]').filter({ hasNot: page.locator('#usernameId') }).and(page.locator('[placeholder*="ID"]')).first();
                await searchInput.fill(''); 
                await searchInput.fill(goodsId);
                
                console.log('   📡 正在向服务器发送查询请求，等待底层数据返回...');
                const [queryResponse] = await Promise.all([
                    page.waitForResponse(res => res.url().includes('/libra-backend/mms/activity/marketing/query') && res.status() === 200, { timeout: 10000 }),
                    page.getByText('查询', { exact: true }).click()
                ]);
                
                const queryData = await queryResponse.json();
                const activityList = queryData?.result?.marketing_activity_list || [];
                
                if (activityList.length > 0) {
                    console.log(`   📦 [X光扫描] 发现历史活动！服务器真实数据:`, JSON.stringify(activityList[0]).substring(0, 150) + '...');
                }

                await page.waitForTimeout(300);

                let firstRow = page.locator('tr[data-testid="beast-core-table-body-tr"]').first();
                let needCreateFromScratch = false;
                let currentPriceNum = 0; 

                if (!await firstRow.isVisible()) { 
                    console.log(`   💡 未搜到历史活动，触发新建工作流...`);
                    needCreateFromScratch = true;
                } else {
                    const headers = await page.locator('[data-testid="beast-core-table-header-tr"]').first().locator('th').allInnerTexts();
                    const priceIdx = headers.findIndex(t => t.includes('活动价(元)'));
                    const actionIdx = headers.findIndex(t => t.includes('操作'));

                    let rawPrice = await firstRow.locator('td').nth(priceIdx).innerText();
                    currentPriceNum = parseFloat(rawPrice.match(/\d+\.\d+/)?.[0] || "0");
                    let actionCell = firstRow.locator('td').nth(actionIdx);

                    const isOngoing = await actionCell.locator('a', { hasText: '结束' }).isVisible();
                    if (isOngoing && currentPriceNum > proposedPriceNum) {
                        console.log(`   📉 线上价偏高，正在强制结束旧活动...`);
                        await actionCell.locator('a', { hasText: '结束' }).click({ force: true });
                        await page.locator('button:has-text("确认结束"), .beast-core-modal-footer button').first().click({ force: true });
                        await page.locator('a:has-text("直接结束")').click({ force: true });
                        await page.waitForTimeout(3000);
                        
                        console.log(`   ✅ 旧活动已被清除，准备从零创建新活动...`);
                        needCreateFromScratch = true;
                    } else if (isOngoing && currentPriceNum <= proposedPriceNum) {
                        console.log(`   🛡️ 线上价格已占优，跳过。`);
                    } else if (!isOngoing) {
                        console.log(`   💡 历史活动已失效，准备从零创建新活动...`);
                        needCreateFromScratch = true;
                    }
                }

                if (needCreateFromScratch) {
                    console.log('   🛠️ 启动统一构建引擎，进入【限时促销】标准配置流...');
                    await page.getByRole('button', { name: '立即创建' }).first().click({ force: true });
                    
                    const promoRadio = page.locator('label').filter({ hasText: '限时促销在规定时间内对商品进行打折销售，时间结束后恢复原价' }).first();
                    await promoRadio.waitFor({ state: 'visible', timeout: 15000 });
                    await promoRadio.getByTestId('beast-core-icon-radio-circle_filled').click({ force: true });
                    await page.waitForTimeout(500);
                    
                    await page.getByRole('button', { name: '选择商品' }).first().click({ force: true });
                    await page.waitForTimeout(1000); 
                    
                    console.log('   🔍 正在弹窗中定位并搜寻商品...');
                    const modalSearchInput = page.getByTestId('beast-core-modal-body').getByTestId('beast-core-input-htmlInput').first();
                    await modalSearchInput.waitFor({ state: 'visible', timeout: 10000 });
                    await modalSearchInput.click({ force: true });
                    await modalSearchInput.fill(goodsId); 

                    const modalSearchBtn = page.getByText('查询', { exact: true }).first();
                    await modalSearchBtn.click({ force: true });
                    await page.waitForTimeout(2000); 

                    console.log('   🖱️ 勾选目标商品...');
                    const checkIcon = page.getByTestId('beast-core-table-body-tr').first().getByTestId('beast-core-icon-check').first();
                    await checkIcon.waitFor({ state: 'visible', timeout: 10000 });
                    await checkIcon.click({ force: true }); 
                    await page.waitForTimeout(500);
                    
                    await page.getByRole('button', { name: '确认选择' }).first().click({ force: true });
                    await page.waitForTimeout(1500);
                    
                    await configureActivityPage(page, proposedPriceStr, false, today);
                    
                    console.log(`   ✨ 商品 ID ${goodsId} 【限时促销】统一创建执行完毕。`);
                    
                    const oldPriceRecord = currentPriceNum > 0 ? currentPriceNum : '无活动/新上架';
                    logSuccessToCSV(
                        storeName, // 传入店铺名进行隔离记录
                        goodsId, 
                        product.product_name, 
                        oldPriceRecord, 
                        proposedPriceStr, 
                        rival.min_price, 
                        rival.limit_price || '未设置',
                        STRATEGY
                    );
                    console.log(`   📝 [审计日志] 已安全写入 success_tasks_${storeName}.csv`);
                    
                    console.log(`   🔙 正在清理成功弹窗，跳回活动列表主页...`);
                    try {
                        const successCloseBtn = page.getByTestId('beast-core-modal-inner').getByTestId('beast-core-button').first();
                        if (await successCloseBtn.isVisible({ timeout: 2000 })) {
                            await successCloseBtn.click({ force: true });
                        }
                    } catch(e) {}

                    await page.waitForTimeout(1000);
                    await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(2000);
                }

                if (page.url().includes('tool_full_channel=10921_77271')) {
                    console.log('   🧹 正在扫尾主页面状态...');
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                    const leftoverPopup = page.locator('[data-testid="beast-core-modal-icon-close"], .beast-core-modal-close, button:has-text("取消"), button:has-text("关闭")').filter({ visible: true }).first();
                    if (await leftoverPopup.isVisible()) {
                        await leftoverPopup.click({ force: true });
                        await page.waitForTimeout(500);
                    }
                }

            } catch (itemError) {
                const errMsg = itemError.message.slice(0, 100);
                console.error(`   ⚠️ [单品处理失败] 跳过 ID: ${product.true_sku_id} | 原因: ${errMsg}`);
                
                logErrorToCSV(storeName, product.true_sku_id, product.product_name, errMsg);
                
                const allPages = page.context().pages();
                if (allPages.length > 1) {
                    await allPages[allPages.length - 1].close();
                    await page.bringToFront();
                }

                console.log('   🚨 [异常防御] 检测到流程阻塞，放弃温和关闭，直接物理重置主页面...');
                try {
                    await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 30000 
                    });
                    await page.waitForTimeout(2500);
                    console.log('   ✅ [状态释放] 页面已完成强力重置，准备迎接下一个任务。');
                } catch (gotoError) {
                    console.error(`   ❌ [二次崩溃] 跳转重置失败: ${gotoError.message}，尝试终极刷新...`);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);
                }
            }
        }
    } catch (globalError) {
        console.error(`❌ 全局运行异常: ${globalError.message}`);
    } finally {
        db.close();
        console.log(`\n🎊 --- 6.0 批量调价引擎运行结束 [${storeName}] ---`);
    }
}

// 对外暴露模块接口
module.exports = { runPriceChangeTask };