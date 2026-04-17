const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');

(async () => {
    console.log('🚀 [全自动 JSON 提取器] 启动，使用动态搜索链路...');
    
    // 启动浏览器
    const browser = await chromium.launch({
        headless: false, 
        args: ['--disable-blink-features=AutomationControlled']
    });

    const stateAPath = path.join(__dirname, 'stateA.json');
    const contextA = await browser.newContext(fs.existsSync(stateAPath) ? { storageState: stateAPath } : {});
    
    // ==========================================
    // ⚠️ 请在这里填入你店铺里任意一款“油烟机”的商品ID
    // ==========================================
    const TARGET_PRODUCT_ID = '908882576802'; 

    try {
        console.log(`\n🔄 [操作提示] 正在自动访问店铺商品列表...`);
        const pageA = await contextA.newPage();
        const goodsListUrl = 'https://mms.pinduoduo.com/goods/goods_list'; 
        await pageA.goto(goodsListUrl, { waitUntil: 'domcontentloaded' });
        
        console.log(`🔍 [自动化] 正在定位【商品ID】并搜索...`);
        
        const inputA = pageA.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
        await inputA.waitFor({ state: 'visible', timeout: 0 }); // 无限期等待防掉线
        await inputA.fill(TARGET_PRODUCT_ID);
        
        await inputA.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await pageA.getByRole('button', { name: '查询' }).click();

        // 容错：清理可能弹出的公告弹窗
        try {
            await pageA.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 });
            await pageA.getByTestId('beast-core-modal-close-button').click();
        } catch (e) {}

        console.log(`🖱️ [自动化] 正在点击表格中的【编辑】按钮，并捕获新页面...`);
        const editBtnA = pageA.getByTestId('beast-core-table-body-tr').getByText('编辑').first();
        await editBtnA.waitFor({ state: 'visible', timeout: 10000 });

        // 核心时机：先开启新页面的监听，再点击
        const newPagePromiseA = contextA.waitForEvent('page');
        await editBtnA.click();

        // 击杀潜伏的“我知道了”弹窗
        try {
            const modalCloseBtn = pageA.getByTestId('beast-core-modal-close-button');
            await modalCloseBtn.waitFor({ state: 'visible', timeout: 3000 });
            console.log(`⏳ [自动化] 击杀拦截弹窗...`);
            await modalCloseBtn.click();
        } catch (e) {}

        // 接管真正的编辑页面
        const editPage = await newPagePromiseA;
        await editPage.waitForLoadState('domcontentloaded');

        console.log(`📡 [雷达挂载] 正在监听发往拼多多服务器的底层数据包...`);
        
        let jsonCaptured = false;
        editPage.on('request', async (request) => {
            if (request.method() === 'POST' && request.url().includes('action/edit')) {
                try {
                    const postData = request.postData();
                    const jsonData = JSON.parse(postData);
                    
                    // 将截获的 JSON 格式化并保存
                    fs.writeFileSync('pdd_target_template.json', JSON.stringify(jsonData, null, 4), 'utf-8');
                    
                    console.log('\n🎉 [截获成功] 拼多多目标格式（包含类目约束）已全部提取！');
                    console.log('📂 请在当前目录下查看文件：pdd_target_template.json');
                    console.log('>>> 任务圆满完成，3秒后自动关闭...');
                    
                    jsonCaptured = true;
                    setTimeout(async () => { 
                        await browser.close(); 
                        process.exit(0); 
                    }, 3000);
                } catch (e) {
                    console.log('⚠️ [异常] JSON 解析失败:', e.message);
                }
            }
        });

        // 等待页面完全加载完毕，防止太快点击没反应
        await editPage.waitForTimeout(3000);

        // 触发保存动作以发送数据包
        console.log('🤖 正在自动触发保存动作...');
        try {
            // 先尝试找底部的保存按钮并一击必杀
            await editPage.getByRole('button', { name: '提交' }).first().click({ force: true });
        } catch (e) {
            console.log(`⚠️ [降级] 没找到“提交”，尝试点击“保存草稿”...`);
            await editPage.getByRole('button', { name: '保存草稿' }).first().click({ force: true });
        }
        
        // 兜底等待，防止脚本过早退出
        for(let i=0; i<15; i++) {
            if (jsonCaptured) break;
            await editPage.waitForTimeout(1000);
        }

    } catch (error) {
        console.error('❌ [程序异常] 运行出错:', error);
    }
})();