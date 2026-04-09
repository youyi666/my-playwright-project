const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// 启用隐身插件，抹除自动化特征
chromium.use(stealth);

(async () => {
    // 待抓取的网址列表（请替换为你正在测试的真实网址）
    const urls = [
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500946001010801&list_sn=YWGBa9o9B_lmiaes3Jhw_xjc&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775610902771_ppiz639h56&refer_page_sn=10014&activeTab=0',
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=158438010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWGKOjNRP-SpmKbvEED5Q9J3&__list_version=2&_pdd_fs=1&refer_page_name=bangdan_list&refer_page_id=17542_1775617970181_16m6qofvrv&refer_page_sn=17542&page_from=69&activeTab=0',
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283499844847010801&list_sn=YWEgW7aKJnACkTS-VA-syDSw&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775628324771_uec69a4wz4&refer_page_sn=10014&activeTab=0',
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500335952010801&list_sn=YWF8XVMLgYDEn8CVFmjq-aO4&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775628390060_fve52hluwo&refer_page_sn=10014&activeTab=0',
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500945926010801&list_sn=YWHB21qmr5XNDbU7tw8_uISo&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775628443889_21l75zlqrb&refer_page_sn=10014&activeTab=0',
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?refer_share_id=iLKJf757sHkUnIicy069SB75ZkwhIUfv&refer_share_channel=copy_link&_pdd_fs=1&__list_version=2&display_type=base&list_sn=YWE3UtyUoB3JnVpcQVxUEUuW&scene_id=goods_detail&refer_share_uin=6NCWZWVQQSPG3MY5ZMDLWFR3KU_GEXDA&_pdd_tc=ffffff&_pdd_sbs=1&share_list_id=9298010204&list_id=9298010204'
    ];

    // 复用你的本地 User Data Dir，保持登录态
    const userDataDir = 'D:\\WorkSpace\\03_Dev_自动化开发\\001号爬虫文件My-Playwright-Project\\download_playwright\\PDD\\pdd-auth-test-temp';

    console.log('🚀 启动文本提取诊断工具...');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, 
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await context.newPage();

    for (let currentUrl of urls) {
        console.log(`\n========================================`);
        console.log(`⏳ 准备访问诊断网址: ${currentUrl}`);

        try {
            await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 30000 });
            console.log(`✅ 页面加载完成，开始检测...`);

            // 智能登录检测区块 (保留以便顺利进入页面)
            try {
                await page.waitForSelector('div[data-ranking-goods-id]', { state: 'attached', timeout: 4000 });
                console.log("🔓 状态正常：已识别到商品数据。");
            } catch (error) {
                console.log("🔒 状态异常：遇到安全拦截或需要登录。");
                console.log("🛑 【人工接管】请在浏览器中完成处理...");
                await page.waitForSelector('div[data-ranking-goods-id]', { state: 'attached', timeout: 120000 });
                console.log("▶️ 恢复执行...");
            }

            // 在浏览器上下文中提取最纯粹的 DOM 原数据
            const rawDataList = await page.evaluate(() => {
                const goodsElements = document.querySelectorAll('div[data-ranking-goods-id]');
                if (goodsElements.length === 0) return [];

                return Array.from(goodsElements).map((el, index) => {
                    const goodsId = el.getAttribute('data-ranking-goods-id');
                    const titleEl = el.querySelector('div[title]');
                    const title = titleEl ? titleEl.getAttribute('title') : "未知标题";

                    // 【核心诊断】：获取最原始的 innerText，将换行符 \n 明确替换为可视化的 ||
                    // 这样我们就能清晰看到浏览器到底把哪些文字粘连在了一起
                    const rawText = el.innerText || "";
                    const visibleText = rawText.replace(/[\n\r]+/g, ' || ');

                    return {
                        index: index + 1,
                        goodsId: goodsId,
                        title: title,
                        rawText: visibleText
                    };
                });
            });

            if (rawDataList.length === 0) {
                console.log("⚠️ 警告：未提取到任何商品信息，请检查页面结构是否发生变化。");
            } else {
                console.log(`\n🎉 成功提取到 ${rawDataList.length} 条商品的原始文本，下面开始打印：\n`);
                
                rawDataList.forEach(item => {
                    console.log(`【商品编号 ${item.index}】 ID: ${item.goodsId}`);
                    console.log(`🏷️ 标题: ${item.title}`);
                    // 重点看这一行的输出
                    console.log(`🔍 原始文本: ${item.rawText}`); 
                    console.log(`--------------------------------------------------`);
                });
            }

        } catch (error) {
            console.error(`❌ 访问或提取页面失败: ${currentUrl}`);
            console.error(`错误详情: ${error.message}`);
        }
    }

    console.log(`\n🎯 诊断文本提取完毕！`);
    console.log(`👉 请将控制台上打印出的、存在解析错误的【🔍 原始文本】复制发给我，我来重写提取规则。`);
    
    await context.close();
})();