// 00-Master_Runner.cjs - [增量模块] 拼多多多店铺全链路业务总控调度中心

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const path = require('path');
const fs = require('fs/promises');

// 引入您的三个基座模块
const UnifiedTask = require('./00-PDD_Unified_Full_Task.cjs');
const FinanceSync = require('./pdd_all_accounts_sync.cjs');
// 如果你的第三个文件没改名，请把这里改成：require('./pdd_expense_t-新开发的营销结算爬取.cjs')
const ExpenseSync = require('./pdd_expense_test.cjs'); 
const PriceGuard = require('./price-change.cjs');
// ======================= [全局多店配置区域] =======================
const STORE_CONFIGS = [
    { 
        storeName: '云米拼多多官方旗舰店', 
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile') 
    },
    { 
        storeName: '云米拼多多专卖店_新店',
        profileDir: path.join(__dirname, 'PDD', 'pdd-auth-profile-newstore')
    }
];

async function main() {
    console.log(`\n======================================================`);
    console.log(`🚀 [总控节点] 拼多多多店全链路数据同步系统启动`);
    console.log(`======================================================`);

    // 预先创建订单和推广的下载目录，防止基座找不到文件夹报错
    const orderDownloadFolder = path.join(__dirname, 'exc_data', '订单_订单查询');
    const promoDownloadFolder = path.join(__dirname, 'exc_data', '推广_商品数据', '拼多多');
    await fs.mkdir(orderDownloadFolder, { recursive: true }).catch(()=>{});
    await fs.mkdir(promoDownloadFolder, { recursive: true }).catch(()=>{});

    for (const config of STORE_CONFIGS) {
        console.log(`\n>>> 正在初始化店铺基座环境: 【${config.storeName}】 <<<`);
        
        let context = null;
        let page = null;

        try {
            // 为当前店铺启动独立持久化上下文，接管登录状态
            context = await chromium.launchPersistentContext(config.profileDir, { 
                headless: false, 
                viewport: { width: 1366, height: 768 },
                args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
                downloadsPath: orderDownloadFolder 
            });

            page = context.pages()[0] || await context.newPage();
            
            await page.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
            if (page.url().includes('login')) {
                console.log(`⚠️ 【${config.storeName}】需要扫码或验证，等待人工介入...`);
                await page.waitForURL('**/home', { timeout: 300000 });
                console.log(`✅ 【${config.storeName}】登录验证通过！`);
            }

            // --- 串联执行三大基座模块 (共享同一个 page 实例) ---
            
            console.log(`\n[调度器] 启动模块 1: 【订单与推广报表】双线轮询...`);
            await UnifiedTask.pddOrderTask(page, config.storeName);
            await UnifiedTask.pddPromotionTask(page, config.storeName);

            console.log(`\n[调度器] 启动模块 2: 【多账户财务流水】同步...`);
            await FinanceSync.runMultiAccountScraper(page, config.storeName);

            console.log(`\n[调度器] 启动模块 3: 【营销活动结算】明细抓取...`);
            await ExpenseSync.runUltimateScraper(page, config.storeName);
            
            console.log(`\n[调度器] 启动模块 4: 【价格卫兵】自动巡航与调价...`);
            await PriceGuard.runPriceChangeTask(page, config.storeName);
        } catch (storeError) {
            console.error(`\n❌ 店铺 【${config.storeName}】 执行过程中发生严重跨界异常:`, storeError.message);
            if (page) {
                await page.screenshot({ path: `error_Master_${config.storeName}_${Date.now()}.png`, fullPage: true }).catch(()=>{});
            }
        } finally {
            if (context) {
                console.log(`🏁 正在安全释放 【${config.storeName}】 的浏览器资源...`);
                await context.close();
            }
        }
    }

    console.log('\n🎉 所有店铺的全链路自动化数据同步任务圆满完成！');
}

main();