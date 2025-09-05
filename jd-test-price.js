// 文件名: jd-test-price.js，等待登陆状态准备完毕。
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

chromium.use(StealthPlugin());

// ======================= 配置区 =======================
// 你的登录状态文件路径
const AUTH_FILE_PATH = path.join(__dirname, 'jd-auth.json');

// 你想测试的商品URL
const TARGET_URL = 'https://item.jd.com/100185035241.html';

// 测试时建议设为 false，可以直观地看到浏览器操作
const HEADLESS_MODE = false; 

// 京东价格选择器 (按优先级排列)
const PRICE_SELECTORS = [
    '.price-single .price-value', // 自营或普通商品的主价格
    '.J-summary-price .price', // 另一种常见的价格容器
    '.main-price .price', // 备用价格选择器
    '#J-final-price',     // 最终成交价
    '.summary-price .price',
];
// ======================================================

(async () => {
    console.log("--- 京东价格抓取测试脚本 ---");

    // 1. 检查登录文件是否存在
    if (!fs.existsSync(AUTH_FILE_PATH)) {
        console.error(`\n❌ 错误: 登录状态文件未找到！`);
        console.error(`请确保 '${AUTH_FILE_PATH}' 文件存在于当前目录。`);
        console.error("如果文件不存在，请先运行登录脚本 `jd-login.js`。");
        return; // 终止脚本
    }
    console.log("✅ 登录状态文件已找到。");

    let browser;
    try {
        // 2. 启动浏览器并加载登录状态
        console.log("正在启动浏览器并加载登录状态...");
        browser = await chromium.launch({ headless: HEADLESS_MODE });
        const context = await browser.newContext({ 
            storageState: AUTH_FILE_PATH,
            // 模拟手机，因为手机端页面结构有时更简单
            ...chromium.devices['iPhone XR'],
        });
        const page = await context.newPage();
        console.log("✅ 浏览器已启动，并以登录状态加载。");

        // 3. 导航到目标页面
        console.log(`正在导航到: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 });
        console.log("✅ 页面加载完成。");
        
        // 给你3秒钟时间肉眼观察一下页面
        await page.waitForTimeout(3000);

        // 4. 尝试抓取价格
        console.log("\n--- 开始在页面上查找价格 ---");
        let priceText = null;
        let foundSelector = null;

        for (const selector of PRICE_SELECTORS) {
            console.log(`   > 尝试选择器: '${selector}'...`);
            try {
                const priceElement = page.locator(selector).first();
                const text = await priceElement.textContent({ timeout: 3000 });
                const cleanedText = text.replace(/¥/g, '').trim();
                
                if (cleanedText && !isNaN(parseFloat(cleanedText))) {
                    priceText = cleanedText;
                    foundSelector = selector;
                    break; // 找到就跳出循环
                }
            } catch (error) {
                // 如果找不到或超时，就继续尝试下一个选择器
                continue;
            }
        }

        // 5. 输出最终结果
        if (priceText) {
            console.log("\n=============================================");
            console.log(`🎉 成功! 使用选择器 '${foundSelector}' 找到价格: ¥${priceText}`);
            console.log("=============================================");
        } else {
            console.log("\n=============================================");
            console.log("❌ 失败! 未能使用任何预设选择器找到价格。");
            console.log("请检查打开的浏览器窗口：");
            console.log("  1. 页面是否已完全加载？");
            console.log("  2. 是否出现了新的、未预料到的验证码或弹窗？");
            console.log("  3. 手动F12检查一下价格元素的CSS选择器是否已变更。");
            console.log("=============================================");
        }

    } catch (error) {
        console.error("\n--- 脚本执行过程中发生严重错误 ---");
        console.error(error.message);
    } finally {
        if (browser) {
            if (HEADLESS_MODE === false) {
                 console.log("\n测试完成，浏览器将在10秒后自动关闭...");
                 await new Promise(resolve => setTimeout(resolve, 10000));
            }
            await browser.close();
            console.log("浏览器已关闭。");
        }
    }
})();