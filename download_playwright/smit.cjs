const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');

(async () => {
    console.log('🚀 [系统启动] 正在初始化带有 Stealth 伪装的双重浏览器环境...');
    
    // [基座代码] 启动浏览器
    const browser = await chromium.launch({
        headless: false, 
        args: ['--disable-blink-features=AutomationControlled']
    });

    const stateAPath = path.join(__dirname, 'stateA.json');
    const stateBPath = path.join(__dirname, 'stateB.json');

    const contextA = await browser.newContext(fs.existsSync(stateAPath) ? { storageState: stateAPath } : {});
    const contextB = await browser.newContext(fs.existsSync(stateBPath) ? { storageState: stateBPath } : {});

    // [横幅注入]
    await contextA.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
            if (!document.getElementById('a-store-banner')) {
                const div = document.createElement('div');
                div.id = 'a-store-banner';
                div.innerHTML = '<h1 style="color:white; background:#ff4d4f; text-align:center; padding:15px; position:fixed; top:0; left:0; width:100%; z-index:999999; pointer-events:none; font-size:24px; margin:0;">🔴 这里是 A 店（数据源）！</h1>';
                document.body.appendChild(div);
            }
        });
    });

    await contextB.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
            if (!document.getElementById('b-store-banner')) {
                const div = document.createElement('div');
                div.id = 'b-store-banner';
                div.innerHTML = '<h1 style="color:white; background:#1890ff; text-align:center; padding:15px; position:fixed; top:0; left:0; width:100%; z-index:999999; pointer-events:none; font-size:24px; margin:0;">🔵 这里是 B 店（目标店）！</h1>';
                document.body.appendChild(div);
            }
        });
    });

    let productA_Data = null; 
    let productA_DecorationData = null; 
    const goodsListUrl = 'https://mms.pinduoduo.com/goods/goods_list'; 

    try {
        // ==========================================
        // 阶段一：在 A 店抓取源数据
        // ==========================================
        console.log(`\n🔄 [操作提示] 正在自动访问 A 店商品列表...`);
        const pageA = await contextA.newPage();
        await pageA.goto(goodsListUrl, { waitUntil: 'domcontentloaded' });
        
        console.log(`🔍 [自动化] 正在定位【商品ID】并搜索...`);
        const inputA = pageA.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
        await inputA.waitFor({ state: 'visible', timeout: 15000 }).catch(() => console.log('⚠️ 等待输入框超时。'));
        await inputA.fill('763759392708');
        
        await inputA.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        // [录制代码融合] 使用精准的 role 角色定位查询按钮
        await pageA.getByRole('button', { name: '查询' }).click();
        
        // 容错：搜索后如果立刻弹出一次弹窗，先清掉
        try {
            await pageA.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 });
            await pageA.getByTestId('beast-core-modal-close-button').click();
        } catch (e) {}

        console.log(`🖱️ [自动化] 正在点击表格中的【编辑】按钮，并处理潜伏弹窗...`);
        // [录制代码融合] 精准锁定表格行内的编辑按钮
        const editBtnA = pageA.getByTestId('beast-core-table-body-tr').getByText('编辑').first();
        await editBtnA.waitFor({ state: 'visible', timeout: 10000 });

        // 【核心时机修复】先开启新页面的监听
        const newPagePromiseA = contextA.waitForEvent('page');
        // 点击编辑
        await editBtnA.click();

        // 此时不要死等新页面，因为极其可能被弹窗拦住了！尝试击杀弹窗！
        try {
            const modalCloseBtn = pageA.getByTestId('beast-core-modal-close-button');
            await modalCloseBtn.waitFor({ state: 'visible', timeout: 3000 });
            console.log(`⏳ [自动化] 果然出现“我知道了”拦截弹窗，正在一击必杀...`);
            await modalCloseBtn.click();
        } catch (e) {
            // 如果没弹窗，说明直接放行了，忽略即可
        }

        // 现在再去迎接真正弹出的新页面
        const editPageA = await newPagePromiseA;
        await editPageA.waitForLoadState('domcontentloaded');

        // 设置监听器
        let aDataCaptured = false;
        editPageA.on('request', request => {
            if (request.method() === 'POST') {
                const url = request.url();
                if (url.includes('action/edit')) {
                    try {
                        productA_Data = JSON.parse(request.postData());
                        console.log(`✅ [后台窃听] 成功截获 A 店【主商品】数据！`);
                        aDataCaptured = true;
                    } catch (e) {}
                } else if (url.includes('decoration/commit/save')) {
                    try {
                        productA_DecorationData = JSON.parse(request.postData());
                        console.log(`✅ [后台窃听] 成功截获 A 店【商详装修】长图数据！`);
                    } catch (e) {}
                }
            }
        });

        await editPageA.route('**/action/edit*', async (route) => await route.continue());
        await editPageA.route('**/decoration/commit/save*', async (route) => await route.continue());

        console.log(`🖱️ [自动化] 正在自动触发 A 店的保存动作以窃取数据...`);
        try {
            // [录制代码融合] 使用 getByRole 点击底部按钮
            await editPageA.getByRole('button', { name: '提交' }).click();
        } catch (e) {
            console.log(`⚠️ [人工介入] 无法找到 A 店保存按钮，请手动点击【提交】。`);
        }

        for(let i=0; i<15; i++) {
            if (aDataCaptured) break;
            await editPageA.waitForTimeout(1000);
        }

        if (!productA_Data) {
            console.log('❌ 严重警告：没有抓到 A 店数据。');
        }
        await contextA.storageState({ path: stateAPath });

        // ==========================================
        // 阶段二：在 B 店进行拦截准备
        // ==========================================
        console.log(`\n🔄 [操作提示] 正在自动访问 B 店商品列表...`);
        const pageB = await contextB.newPage();
        await pageB.goto(goodsListUrl, { waitUntil: 'domcontentloaded' });

        console.log(`🔍 [自动化] 正在精准定位【商品ID】输入框并搜索商品 B...`);
        console.log(`⏳ [防掉线保护] 如果此时跳转到了登录页，请从容地拿出手机扫码登录。程序将无限期静默等待，绝不崩溃...`);
        
        const inputB = pageB.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
        
        // 【核心修改】将 timeout: 15000 改为 timeout: 0 (无限期等待)
        await inputB.waitFor({ state: 'visible', timeout: 0 });
        
        console.log(`✅ [自动化] 确认已进入 B 店后台！继续执行自动填表...`);
        await inputB.fill('916869819702');
        
        await inputB.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        await pageB.getByRole('button', { name: '查询' }).click();
        
        try {
            await pageB.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 });
            await pageB.getByTestId('beast-core-modal-close-button').click();
        } catch (e) {}

        const editBtnB = pageB.getByTestId('beast-core-table-body-tr').getByText('发布相似品').first();
        await editBtnB.waitFor({ state: 'visible', timeout: 10000 });

        console.log(`🖱️ [自动化] 正在点击【发布相似品】按钮，并处理 B 店确认弹窗...`);
        
        // 核心时机：新页面监听器必须挂在任何点击动作之前
        const newPagePromiseB = contextB.waitForEvent('page');
        
        // 动作 1：点击触发弹窗
        await editBtnB.click();

        // 动作 2：直接点击必出的【确认】按钮（替换掉了原有的 try...catch 逻辑）
        console.log(`⏳ [自动化] 正在点击【确认】...`);
        await pageB.getByRole('button', { name: '确认' }).click();

        const editPageB = await newPagePromiseB;
        await editPageB.waitForLoadState('domcontentloaded');
        await contextB.storageState({ path: stateBPath });

        // ==========================================
        // 阶段三：“借尸还魂”式数据融合与拦截提交
        // ==========================================
        console.log(`\n⚙️ [拦截监听] 正在挂载 B 店底层数据修改器...`);

        await editPageB.route('**/action/edit*', async (route, request) => {
            console.log('⚡ [触发拦截] 捕获到 B 店的主商品保存请求！');
            try {
                let originalBData = JSON.parse(request.postData());
                if (productA_Data) {
                    originalBData.goods_name = productA_Data.goods_name; 
                    originalBData.goods_desc = productA_Data.goods_desc; 
                    originalBData.gallery = productA_Data.gallery;       
                    originalBData.goods_properties = productA_Data.goods_properties; 
                    if (productA_Data.skus && productA_Data.skus.length > 0) {
                        originalBData.skus = productA_Data.skus.map(sku => ({
                            ...sku, id: undefined, sku_id: undefined   
                        }));
                    }
                }
                await route.continue({ postData: JSON.stringify(originalBData) });
                console.log('🎉 [任务完成] 主商品数据融合完毕并放行！');
            } catch (e) {
                await route.continue();
            }
        });

        await editPageB.route('**/decoration/commit/save*', async (route, request) => {
            console.log('⚡ [触发拦截] 捕获到 B 店的【商详装修】保存请求！');
            try {
                let originalBDeco = JSON.parse(request.postData());
                if (productA_DecorationData && productA_DecorationData.decoration_floor_list) {
                    originalBDeco.decoration_floor_list = productA_DecorationData.decoration_floor_list;
                }
                await route.continue({ postData: JSON.stringify(originalBDeco) });
                console.log('🎉 [任务完成] 商详装修长图替换完毕并放行！');
            } catch (e) {
                await route.continue();
            }
        });

        await editPageB.route('**/commit/submit*', async (route) => {
             await route.continue();
        });

        // [最终形态：全自动点击提交]
        try {
            console.log(`🖱️ [自动化] 尝试点击“装修商详”以激活长图保存逻辑...`);
            const decoBtn = editPageB.locator('button:has-text("装修商详")').first();
            await decoBtn.waitFor({ state: 'visible', timeout: 5000 });
            await decoBtn.click({ force: true });
            
            await editPageB.waitForTimeout(1500); 

            // ==========================================
            // 动态计算 A 店最高 SKU 价格
            // ==========================================
            let maxPriceStr = '2599'; // 默认兜底价，防止 A 店数据异常
            if (productA_Data && productA_Data.skus && productA_Data.skus.length > 0) {
                // 遍历获取所有 SKU 的价格，拼多多常见的单买价字段为 normal_price，拼单价为 group_price 或 sku_price
                const prices = productA_Data.skus.map(sku => Number(sku.normal_price || sku.group_price || sku.sku_price || 0));
                const maxPrice = Math.max(...prices);
                
                if (maxPrice > 0) {
                    // 底层单位是“分”，UI填表单位是“元”，转换并转为字符串
                    maxPriceStr = (maxPrice / 100).toString(); 
                }
            }

            console.log(`💰 [自动化] 从数据源提取到最高 SKU 价，正在填入【参考价】(${maxPriceStr}元)...`);
            const advicePriceInput = editPageB.locator('input[data-tracking-click-viewid="goods_advice_price"]');
            await advicePriceInput.waitFor({ state: 'visible', timeout: 5000 });
            await advicePriceInput.fill(maxPriceStr);
            
            // 触发底层数据绑定（保留你原本极其优秀的事件注入）
            await advicePriceInput.evaluate(node => {
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
                node.dispatchEvent(new Event('blur', { bubbles: true }));
            });
            
            await advicePriceInput.evaluate(node => {
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
                node.dispatchEvent(new Event('blur', { bubbles: true }));
            });

            // 模拟失焦，防止拦截
            // await editPageB.locator('body').click({ force: true });
            // await editPageB.waitForTimeout(500);

            console.log(`🚀 [自动化] 锁定【提交】按钮，执行最终发布！`);
            // [录制代码融合] 使用最高稳健度的角色定位，自带等待，一击必杀！
            await editPageB.getByRole('button', { name: '提交并上架' }).click({ force: true });

            console.log(`\n===========================================`);
            console.log(`🎊 [大功告成] 所有自动化流程执行完毕！`);
            console.log(`===========================================\n`);

        } catch (e) {
            console.log(`⚠️ [程序阻断] 全自动点击失败，原因: ${e.message}。请手动提交。`);
        }

        console.log('>>> 浏览器将保持开启状态供你检查。按 Ctrl+C 结束。');

    } catch (error) {
        console.error('❌ [程序异常] 运行出错:', error);
    } 
})();