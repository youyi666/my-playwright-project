const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');

// ==========================================
// 🚀 拼多多全自动智能填表引擎 (兼容填空与下拉)
// ==========================================
async function autoFillPinduoduo(page, cleanData) {
    console.log(`\n===========================================`);
    console.log(`🤖 [填表引擎] 开始执行智能化 UI 数据注入...`);
    
    for (const [labelName, targetValue] of Object.entries(cleanData)) {
        try {
            console.log(`⏳ 正在处理属性：【${labelName}】 -> 准备注入 [${targetValue}]`);
            // 1. 找爹：锁定表单行
            const rowBox = page.locator('[data-testid="beast-core-form-item"]')
                .filter({ has: page.locator('label', { hasText: new RegExp(`^${labelName}$`) }) });
            
            // 容错：如果该类目没有这个字段，直接跳过，绝不报错
            if (await rowBox.count() === 0) {
                console.log(` ➡️ 页面未开放【${labelName}】字段，自动放行...`);
                continue;
            }

            // 2. 找儿子：锁定输入框
            const inputElement = rowBox.locator('input').first();
            await inputElement.scrollIntoViewIfNeeded();
            
            // 3. 统一操作：强力点击并填入内容
            await inputElement.click({ force: true });
            await inputElement.fill(targetValue.toString());
            
            // 给复杂的 React 动画渲染时间
            await page.waitForTimeout(500);

            // 4. 智能判断分支：寻找是否有悬浮出来的下拉菜单项
            const dropdownOption = page.getByText(targetValue, { exact: true }).filter({ state: 'visible' }).last();
            
            if (await dropdownOption.count() > 0) {
                // 💥 路线 A：发现悬浮菜单，判定为下拉框，强力击杀纯文本！
                await dropdownOption.click({ force: true });
                console.log(` ✅ [下拉框] 成功选中选项：${targetValue}`);
            } else {
                // 🖊️ 路线 B：未发现悬浮菜单，判定为普通输入框，注入底层失焦事件！
                await inputElement.evaluate(node => {
                    node.dispatchEvent(new Event('input', { bubbles: true }));
                    node.dispatchEvent(new Event('change', { bubbles: true }));
                    node.dispatchEvent(new Event('blur', { bubbles: true }));
                });
                console.log(` ✅ [输入框] 成功填入数值：${targetValue}`);
            }
        } catch (e) {
            console.log(` ❌ 处理属性【${labelName}】时发生意外: ${e.message}`);
        }
    }
    console.log(`🤖 [填表引擎] 全部文本属性注入完毕！`);
    console.log(`===========================================\n`);
}

// ==========================================
// 🚀 主流程控制中心
// ==========================================
(async () => {
    console.log('🚀 [系统启动] 正在初始化反爬虫双线浏览器环境...');
    
    // 加载本地字典
    const dictPath = path.join(__dirname, 'category_mapping.json');
    if (!fs.existsSync(dictPath)) {
        console.error('❌ 找不到 category_mapping.json，请确保字典文件存在！');
        process.exit(1);
    }
    const categoryDict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));

    const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
    
    // 使用 User Data Dir 概念复用登录状态
    const jdStatePath = path.join(__dirname, 'stateJD.json');
    const pddStatePath = path.join(__dirname, 'statePDD.json');

    const contextJD = await browser.newContext(fs.existsSync(jdStatePath) ? { storageState: jdStatePath } : {});
    const contextPDD = await browser.newContext(fs.existsSync(pddStatePath) ? { storageState: pddStatePath } : {});

    let pagePDD; 

    try {
        // ==========================================
        // 阶段一：京东全能抓取 (API窃听 + 图片过滤)
        // ==========================================
        console.log(`\n🔄 [京东端] 准备进入商品页并挂载双重侦测...`);
        const pageJD = await contextJD.newPage();
        
        // ⚠️ 替换为你要抓取的实际京东商品 SKU
        const targetJdItemId = '100187825912'; 

        // 1. [后台窃听] 提前挂载 API 拦截器
        const apiResponsePromise = pageJD.waitForResponse(async response => {
            return response.url().includes('pc_detailpage_wareBusiness') && response.status() === 200;
        }, { timeout: 15000 }).catch(() => null);

        // 2. 访问页面
        await pageJD.goto(`https://item.jd.com/${targetJdItemId}.html`, { waitUntil: 'domcontentloaded' });

        console.log(`⏳ [自动化] 开始模拟真人向下滚动，激活懒加载引擎...`);
        // 3. [主动出击] 阶梯式滚动机制
        await pageJD.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 800; 
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight || totalHeight > 10000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 400); 
            });
        });

        // 4. 收网：获取 API 参数文本
        let jdRawData = {};
        const apiResponse = await apiResponsePromise;
        if (apiResponse) {
            try {
                const resJson = await apiResponse.json();
                const attributes = resJson?.productAttributeVO?.attributes || [];
                attributes.forEach(item => {
                    if (item.labelName && item.labelValue) {
                        jdRawData[item.labelName] = item.labelValue.trim();
                    }
                });
                console.log(`✅ [后台窃听] 成功截获京东 API，提取到 ${Object.keys(jdRawData).length} 条参数！`);
            } catch (e) {
                console.log(`❌ 参数解析失败: ${e.message}`);
            }
        }

        // 5. [前台刮取] 执行 n1转n0主图修正 与 SKU纯净图过滤
        console.log(`🔍 [自动化] 开始在页面 DOM 中扫描核心商品图...`);
        const imagesData = await pageJD.evaluate(() => {
            let mainImages = [];
            try {
                if (window.pageConfig && window.pageConfig.product && window.pageConfig.product.imageList) {
                    mainImages = window.pageConfig.product.imageList.map(url => 'https://img10.360buyimg.com/n0/' + url.replace(/\.avif$/, ''));
                } else {
                    // 核心：处理主图链接，把 n1 或 n5 强制转换为 n0 高清大图
                    mainImages = Array.from(document.querySelectorAll('.spec-items img'))
                        .map(img => img.src.replace(/\/(n1|n5)\//, '/n0/').split('!')[0].replace(/\.avif$/, ''));
                }
            } catch(e) { console.log("主图抓取异常", e); }

            const detailBox = document.querySelector('#detail') || document.querySelector('#J-detail-content') || document.body;
            let detailImages = new Set();
            
            if (detailBox) {
                detailBox.querySelectorAll('img, div[data-bg]').forEach(el => {
                    let url = '';
                    if (el.tagName.toLowerCase() === 'img') {
                        url = el.getAttribute('data-lazyload') || el.getAttribute('data-src') || el.src;
                    } else {
                        url = el.getAttribute('data-bg') || el.style.backgroundImage;
                        if (url) url = url.replace(/url\(["']?/, '').replace(/["']?\)/, '');
                    }
                    
                    // 🎯 核心过滤网：必须包含 'sku' 这个关键路径，且为常规图片格式！
                    if (url && url.includes('sku') && /\.(jpg|jpeg|png|webp)/i.test(url)) {
                        detailImages.add(url);
                    }
                });
            }

            const cleanDetails = Array.from(detailImages)
                .map(url => url.startsWith('http') ? url : 'https:' + url)
                .map(url => url.replace(/\.avif$/, '').split('!')[0]); 

            return { mainImages, detailImages: cleanDetails };
        });

        console.log(`🖼️ [图片提取] 抓取到 ${imagesData.mainImages.length} 张主图，${imagesData.detailImages.length} 张商详图。`);

        // 兜底检查
        if (Object.keys(jdRawData).length === 0) {
            throw new Error('未能在京东页面抓取到有效文本参数，终止同步。');
        }

        // 保存京东端登录状态
        await contextJD.storageState({ path: jdStatePath });

        // ==========================================
        // 阶段二：本地极速清洗与熔断判定
        // ==========================================
        // ⚠️ 动态传入目标类目名称（如"油烟机"、"净水器"等）
        const targetCategory = "净水器"; 
        console.log(`\n⚙️ [数据清洗] 当前目标类目：【${targetCategory}】`);

        if (!categoryDict[targetCategory]) {
            // 核心熔断逻辑：找不到直接报错
            throw new Error(`类目【${targetCategory}】不在本地字典 category_mapping.json 中，拒绝盲填！`);
        }

        console.log(`✅ 匹配到【${targetCategory}】映射规则，开始极速清洗...`);
        let cleanPddData = {};
        const rules = categoryDict[targetCategory].direct_mapping;

        for (const rule of rules) {
            for (const jdKey of rule.jd_keywords) {
                if (jdRawData[jdKey]) {
                    let val = jdRawData[jdKey];
                    
                    if (rule.action === 'replace' && rule.replace_rule) {
                        for (const [oldStr, newStr] of Object.entries(rule.replace_rule)) {
                            val = val.replace(oldStr, newStr);
                        }
                    } else if (rule.action === 'extract_number') {
                        // 提取纯数字 (剔除单位)
                        const numMatch = val.match(/\d+(\.\d+)?/);
                        if (numMatch) val = numMatch[0];
                    } else if (rule.action === 'math_multiply' && rule.multiplier) {
                        // 针对特定需要转换单位的字段 (如：2.79 * 60)
                        const numMatch = val.match(/\d+(\.\d+)?/);
                        if (numMatch) {
                            val = (parseFloat(numMatch[0]) * rule.multiplier).toString();
                        }
                    }
                    
                    cleanPddData[rule.pdd_key] = val;
                    break;
                }
            }
        }
        console.log(`✨ [数据清洗] 清洗完毕，得到 PDD 待填参数字典：`, cleanPddData);

        // ==========================================
        // 阶段三：拼多多全自动填表
        // ==========================================
        console.log(`\n🔄 [拼多多端] 准备进入后台编辑页...`);
        pagePDD = await contextPDD.newPage();
        
        // ⚠️ 替换为你的拼多多商品编辑页URL。
        // （注意：如果是通过 Codegen 录制的动态页面点击进入，请留意录制代码中可能导致失效的一次性时间戳或动态 Token，并替换为稳健的跳转或点击逻辑）
        await pagePDD.goto('https://mms.pinduoduo.com/goods/goods_list', { waitUntil: 'domcontentloaded' });
        
        console.log(`⏳ 请确保页面已切换至商品属性编辑弹窗或详情页...程序默认等待 5 秒...`);
        await pagePDD.waitForTimeout(5000); 

        // 激活强力填表引擎
        await autoFillPinduoduo(pagePDD, cleanPddData);

        // 注意：图片上传模块 (gallery 和 goods_desc_images) 需要配合 PDD 的底层拦截或上传接口来做，
        // 这里目前保留了抓取到的完整图片数据 (imagesData) 供下一步开发图片上传模块使用。

        await contextPDD.storageState({ path: pddStatePath });
        console.log('>>> 🎉 任务完成，浏览器将保持开启状态供你检查。按 Ctrl+C 结束。');

    } catch (error) {
        console.error('\n❌ [程序阻断] 运行出错:', error.message);
        
        // 容错机制：保存错误截图防崩溃
        if (pagePDD) {
            const timestamp = new Date().getTime();
            const screenshotPath = path.join(__dirname, `error_pdd_fill_${timestamp}.png`);
            await pagePDD.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`📸 已自动保存拼多多端错误现场截图至：${screenshotPath}`);
        }
    }
})();