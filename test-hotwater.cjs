const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==========================================
// ⚠️ 填入你的 DeepSeek API Key
// ==========================================
const DEEPSEEK_API_KEY = 'sk-5ce512e159c64ce7a67b838828dd4f88';

// 假设这是我们抓到的京东脏数据（你可以随便改几条测试）
const mockJdData = `
    品牌: 云米 (VIOMI)
    能效网规格型号: JSQ25-VGW1338
    热水器容量: 60L
    能效等级: 二级能效
    防水等级: IPX4
    换热器材质: 磷脱氧铜
    产品尺寸: 长530mm 宽350mm 高151mm
`;

(async () => {
    console.log('🚀 [AI 动态侦察兵] 启动...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext(fs.existsSync('stateA.json') ? { storageState: 'stateA.json' } : {});
    
    // ⚠️ 换成你要测试的商品 ID（最好是个和之前不一样的类目）
    const TARGET_PRODUCT_ID = '846212481564'; 

    try {
        const page = await context.newPage();
        await page.goto('https://mms.pinduoduo.com/goods/goods_list', { waitUntil: 'domcontentloaded' });
        
        const input = page.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
        await input.waitFor({ state: 'visible', timeout: 0 });
        await input.fill(TARGET_PRODUCT_ID);
        await input.evaluate(node => { node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.getByRole('button', { name: '查询' }).click();

        try { await page.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 }).then(b => b.click()); } catch (e) {}

        const newPagePromise = context.waitForEvent('page');
        await page.getByTestId('beast-core-table-body-tr').getByText('编辑').first().click();
        const editPage = await newPagePromise;
        await editPage.waitForLoadState('domcontentloaded');
        await editPage.waitForTimeout(4000); // 等属性加载出来

        console.log(`\n===========================================`);
        console.log(`🕷️ [动态刮取] 正在扫描拼多多当前类目的所有属性坑位...`);
        
        // 【核心魔法】：一句代码刮出所有 label
        const rawLabels = await editPage.locator('[data-testid="beast-core-form-item"] label').allTextContents();
        // 清理掉必填项前面的红色星号 '*' 和空格
        const pddTargetKeys = rawLabels.map(l => l.replace('*', '').trim()).filter(l => l !== '');
        
        console.log(`🎯 成功侦测到 ${pddTargetKeys.length} 个拼多多属性坑位：`);
        console.log(pddTargetKeys.join(' | '));

        console.log(`\n🤖 [呼叫 AI] 正在将京东数据和拼多多坑位发送给 DeepSeek 申请匹配...`);
        
        const prompt = `
        你是一个电商数据清洗专家。
        【京东原始数据】：
        ${mockJdData}
        
        【拼多多目标坑位名单】：
        ${JSON.stringify(pddTargetKeys)}
        
        请仔细比对京东数据，将其填入拼多多的坑位中。
        规则：
        1. 只能使用拼多多目标名单里存在的键名。如果京东的数据在拼多多名单里找不到对应项，直接丢弃。
        2. 尺寸、容量、功率、噪音等参数，必须提取为【纯数字】（剔除W、L、mm等单位）。
        3. 能效等级只保留级别（如“一级”）。
        4. 只返回一个合法的 JSON 字典，不要任何 markdown 标记和多余文字。
        `;

        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [
                {"role": "system", "content": "你是一个只输出JSON的机器。"},
                {"role": "user", "content": prompt}
            ],
            temperature: 0.1
        }, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` }
        });

        const aiResult = response.data.choices[0].message.content.trim();
        console.log(`\n✨ [AI 洗稿完成] 获得完美融合的填表数据：`);
        console.log(aiResult);
        console.log(`===========================================\n`);

        console.log(`>>> 测试完毕，拿着这个 JSON 就可以直接调用之前的填表引擎了！`);
        await browser.close();

    } catch (error) {
        console.error('❌ 运行出错:', error);
    }
})();