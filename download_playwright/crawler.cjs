const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// 🟢 增量模块：反爬虫 Stealth 插件注入
chromium.use(stealth);

// 🟢 增量模块：将默认页数放大至 999，让程序依赖底层检测不到按钮时再自动停止
async function runCrawler(keyword, maxPages = 999) {
    console.log("正在启动浏览器...");

    // 基座代码：启动浏览器
    // 【建议】：若后续熟练，可改用 chromium.launchPersistentContext('./pdd_user_data', {...}) 以复用本地登录状态
    const browser = await chromium.launch({
        headless: false // 初学者建议选 false 观察过程
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    let allGoods = [];

    // 监听 API 请求，获取底层 JSON 数据
    page.on('response', async (response) => {
        if (response.url().includes('common/goodsList') && response.status() === 200) {
            try {
                const data = await response.json();
                const goodsList = data.result?.goodsList || [];
                
                allGoods.push(...goodsList);
                console.log(`✅ 成功截获 ${goodsList.length} 条数据`);
            } catch (e) {
                console.log(`❌ 解析 JSON 失败: ${e.message}`);
            }
        }
    });

    const url = `https://jinbao.pinduoduo.com/promotion/single-promotion?keyword=${encodeURIComponent(keyword)}`;
    console.log(`开始访问: ${url}`);

    try {
        await page.goto(url);

        // =========================================================
        // 🟢 增量模块：自动化账号密码登录 (替换原有的 60 秒人工等待)
        // =========================================================
        console.log("\n==================================================");
        console.log("🤖 开始执行自动化账密登录流程...");
        console.log("==================================================\n");

        // 1. 优先定位纯文本节点“密码登录”进行切换，使用 exact 匹配避免误触
        const pwdLoginText = page.getByText('密码登录', { exact: true });
        await pwdLoginText.waitFor({ state: 'visible', timeout: 15000 });
        await pwdLoginText.click({ force: true });
        console.log("✅ 已成功点击“密码登录”，切换至账密表单");
        await page.waitForTimeout(1000); // 留出表单翻转的渲染动画时间

        // 2. 填写账号 (记得替换为真实账号)
        const accountInput = page.locator('input[type="text"]').first();
        await accountInput.click();
        await accountInput.fill('13226720449');
        
        // 【核心防坑】：主动触发底层数据绑定，防止前端框架吞弃击键
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="text"]');
            if (inputs.length > 0) {
                inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                inputs[0].dispatchEvent(new Event('blur', { bubbles: true }));
            }
        });
        console.log("✅ 账号填写完毕并触发底层更新");
        await page.waitForTimeout(500);

        // 3. 填写密码 (记得替换为真实密码)
        const pwdInput = page.locator('input[type="password"]').first();
        await pwdInput.click();
        await pwdInput.fill('Smiear88');
        
        await page.evaluate(() => {
            const pwds = document.querySelectorAll('input[type="password"]');
            if (pwds.length > 0) {
                pwds[0].dispatchEvent(new Event('input', { bubbles: true }));
                pwds[0].dispatchEvent(new Event('change', { bubbles: true }));
                pwds[0].dispatchEvent(new Event('blur', { bubbles: true }));
            }
        });
        console.log("✅ 密码填写完毕并触发底层更新");
        await page.waitForTimeout(500);

        // 4. 强力点击“我已阅读并同意”
        const agreementLabel = page.locator('text=我已阅读并同意');
        await agreementLabel.click({ force: true });
        console.log("✅ 已尝试强力点击用户协议勾选框");
        await page.waitForTimeout(800);

        // 5. 点击最终的“登录”按钮
        const loginBtn = page.getByRole('button', { name: '登录' }).first();
        await loginBtn.click({ force: true });
        console.log("✅ 已点击登录按钮，正在等待平台响应...");

        // 给足缓冲时间观察后续加载
        await page.waitForTimeout(3000); 

        // 登录结束后强制再次跳转目标搜索页，防止卡在进宝首页
        console.log(`🔄 正在重新跳转至目标搜索页以激活数据...`);
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000); // 留出网络请求时间

    } catch (e) {
        console.log(`❌ 页面访问或自动化登录遭遇异常: ${e.message}`);
        // 发生异常时截图，避免程序无声崩溃，保存错误现场
        await page.screenshot({ path: 'error_login.png', fullPage: true });
        console.log(`[Info] 登录错误现场已保存至: error_login.png`);
    }



    for (let i = 1; i <= maxPages; i++) {
        console.log(`正在处理第 ${i} 页...`);
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log(`❌ 滚动页面出错: ${e.message}`);
        }

        if (i < maxPages) {
            try {
                // =========================================================
                // 🟢 增量模块：增强型翻页终点检测逻辑
                // =========================================================
                // 先定位外层的 li 容器，因为前端框架通常把 disabled 状态写在容器上
                const nextBtnContainer = page.locator('li[data-testid="beast-core-pagination-next"]');
                
                if (await nextBtnContainer.isVisible()) {
                    
                    // 抓取容器的 class 和 aria 属性进行双重校验
                    const className = await nextBtnContainer.getAttribute('class') || '';
                    const ariaDisabled = await nextBtnContainer.getAttribute('aria-disabled') || '';
                    
                    // 判断是否包含禁用的特征 (拼多多的组件通常类名会包含 disable，或者 aria-disabled 变 true)
                    if (className.toLowerCase().includes('disable') || ariaDisabled === 'true') {
                        console.log("检测到【下一页】按钮已置灰 (disabled)，已到达最后一页，抓取结束。");
                        break; // 停止无限翻页，跳出循环
                    }

                    // 精准定位内部的图标(svg、icon)或纯文本节点进行强力点击
                    const nextBtnIcon = nextBtnContainer.locator('i');
                    await nextBtnIcon.click({ force: true });
                    
                    // 主动提供触发底层数据绑定的方案，唤醒框架层更新
                    await page.evaluate(() => {
                        document.dispatchEvent(new Event('change', { bubbles: true }));
                        document.dispatchEvent(new Event('input', { bubbles: true }));
                    });
                    
                    await page.waitForTimeout(3000); // 留出渲染与网络请求的时间
                } else {
                    console.log("未检测到下一页按钮节点，抓取结束。");
                    break;
                }
            } catch (e) {
                console.log(`❌ 翻页失败，可能已到末尾或出现弹窗遮挡: ${e.message}`);
                // UI 交互部分若有可能失败，加入错误截图保存逻辑以防程序直接崩溃
                await page.screenshot({ path: `error_page_${i}.png` });
                break;
            }
        }
    }

    await context.close();
    await browser.close();
    return allGoods;
}

// 执行抓取并存入 SQLite 数据库
// =========================================================
// 🟢 增量模块：全字段 SQLite 存储升级 (替换原有的数据入库部分)
// =========================================================
(async () => {
    const keyword = "净水器";
    
    // 🟢 增量模块：生成当日监控日期字符串 (YYYY-MM-DD)，匹配 SQLite 动态类型
    const today = new Date();
    // 抵消时区差异，确保获取正确的本地日期
    const offset = today.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(today - offset)).toISOString().split('T')[0];
    const scrapeDate = localISOTime;

    try {
        const rawData = await runCrawler(keyword);

        if (rawData.length > 0) {
            console.log(`\n抓取完成，共获取 ${rawData.length} 条记录，正在执行全字段写入 SQLite...`);

            const db = new sqlite3.Database('pdd_jinbao.db');

            db.serialize(() => {
                // 充分利用 SQLite 的动态类型特性，将复杂结构设为 TEXT
                // 🟢 增量模块：加入 scrape_date 字段，并将主键改为 (goodsId, scrape_date) 联合主键
                db.run(`CREATE TABLE IF NOT EXISTS goods_raw (
                    goodsId TEXT,
                    scrape_date TEXT,
                    mallName TEXT,
                    goodsName TEXT,
                    goodsImageUrl TEXT,
                    categoryId INTEGER,
                    categoryName TEXT,
                    minGroupPrice INTEGER,
                    goodsMarkPrice INTEGER,
                    hasCoupon INTEGER,
                    couponDiscount INTEGER,
                    promotionRateV2 REAL,
                    marketFeeV2 INTEGER,
                    salesTip TEXT,
                    sales_num INTEGER,
                    inBigSale TEXT,     -- 存储为 JSON 字符串
                    unifiedTag TEXT,    -- 存储为 JSON 字符串
                    PRIMARY KEY (goodsId, scrape_date)
                )`);

                // 使用对应数量的占位符 (新增了一个 scrape_date 参数)
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO goods_raw (
                        goodsId, scrape_date, mallName, goodsName, goodsImageUrl, 
                        categoryId, categoryName, minGroupPrice, 
                        goodsMarkPrice, 
                        hasCoupon, couponDiscount, promotionRateV2, marketFeeV2, 
                        salesTip, sales_num, inBigSale, unifiedTag
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                rawData.forEach(item => {
                    // 正则提取销量数字进行预处理
                    const salesTip = item.salesTip || "0";
                    const match = salesTip.match(/(\d+)/);
                    const salesNum = match ? parseInt(match[1], 10) : 0;

                    // 序列化复杂对象，防止存入 [object Object]
                    const inBigSaleStr = item.inBigSale ? JSON.stringify(item.inBigSale) : "[]";
                    const unifiedTagStr = item.unifiedTag ? JSON.stringify(item.unifiedTag) : "{}";

                    stmt.run(
                        String(item.goodsId),
                        scrapeDate, // 🟢 增量模块：注入日期维度
                        item.mallName,
                        item.goodsName,
                        item.goodsImageUrl,
                        item.categoryId,
                        item.categoryName,
                        item.minGroupPrice,
                        item.goodsMarkPrice,
                        item.hasCoupon ? 1 : 0, // SQLite 无原生 boolean，转为 1/0
                        item.couponDiscount,
                        item.promotionRateV2,
                        item.marketFeeV2,
                        salesTip,
                        salesNum,
                        inBigSaleStr,
                        unifiedTagStr
                    );
                });
                stmt.finalize();
            });

            db.close((err) => {
                if (err) console.error("数据库关闭失败:", err);
                else {
                    console.log("✅ 全字段数据已成功存入数据库 pdd_jinbao.db 表 goods_raw");
                    
                    // 🟢 增量模块：强烈的数据备份提醒与安全操作指引
                    console.log("\n⚠️ 【强烈数据备份提醒】");
                    console.log("如果你需要在 DB Browser for SQLite 中对错误抓取的数据进行修改，");
                    console.log("绝对禁止直接丢出按“行号”删除的危险代码！");
                    console.log("在执行任何 DELETE 或 UPDATE 前，必须先运行以下 SELECT 语句精准定位：");
                    console.log("SELECT * FROM goods_raw WHERE goodsId = '目标商品ID' AND scrape_date = 'YYYY-MM-DD';");
                }
            });
        } else {
            console.log("未抓取到有效数据，数据库未更新。");
        }

    } catch (e) {
        console.log(`❌ 程序主逻辑发生致命错误: ${e.message}`);
    }
})();