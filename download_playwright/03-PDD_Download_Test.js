// 03-PDD_Download_Test.js - 专注于解决下载按钮点击无效的独立测试脚本
// [2025-01-23 修复版 V2] 适配 div.download-box 卡片式布局

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs/promises');

// ======================= [配置区域] =======================
// 沿用原有配置，确保登录状态一致
const userDataDir = path.join(__dirname, 'PDD', 'pdd-auth-profile');
const DOWNLOAD_FOLDER = path.join(__dirname, 'exc_data', '订单_订单查询', '测试下载');
// 目标测试页面：报表导出记录页
const TARGET_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';

// ======================= [辅助函数] =======================
async function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ======================= [主逻辑] =======================
async function runTest() {
    console.log(`\n--- 🛠️ [测试启动] 拼多多报表下载按钮调试脚本 (V2) ---`);

    let context;
    let page;

    try {
        // 1. 检查配置路径
        try {
            await fs.access(userDataDir);
        } catch {
            console.error(`❌ 错误：用户配置文件夹 \`${userDataDir}\` 不存在！请先运行登录脚本。`);
            return;
        }

        // 2. 启动浏览器
        console.log(` -> 正在启动浏览器并加载用户配置...`);
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, // 必须开启界面以便观察
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
            viewport: null,
            downloadsPath: DOWNLOAD_FOLDER // 设置下载路径
        });

        page = context.pages().length ? context.pages()[0] : await context.newPage();

        // 3. 访问目标页面
        console.log(` -> 正在访问报表导出中心: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        
        console.log(' -> 等待页面加载 (3秒)...');
        await page.waitForTimeout(3000); 

        // 4. 定位策略：根据 HTML 源码，使用 div.download-box 定位
        console.log(' -> 🎯 正在尝试定位列表第一项...');
        
        // 找到第一个下载任务卡片
        const firstCard = page.locator('div.download-box').first();
        
        // 在卡片内寻找包含“下载报表”文字的按钮
        // 源码显示结构为：button > span "下载报表"
        const targetBtn = firstCard.locator('button').filter({ hasText: '下载报表' });
        
        // 检查元素是否存在
        const isBtnVisible = await targetBtn.count() > 0;
        
        if (isBtnVisible) {
            // [高亮调试] 给按钮加上红色边框和黄色背景，方便肉眼确认
            await targetBtn.evaluate(node => {
                node.style.border = '5px solid red';
                node.style.backgroundColor = 'yellow';
            });
            console.log(' -> 👁️ 已高亮目标按钮 (红色边框 + 黄色背景)。');
            await page.waitForTimeout(1000);

            // 设置下载监听 (超时设置为 15秒)
            const downloadPromise = page.waitForEvent('download', { timeout: 15000 });

            console.log(' -> 🖱️ 正在执行点击操作 (强制模式)...');
            // 使用 force: true 绕过可能的透明遮挡
            await targetBtn.click({ force: true });

            try {
                const download = await downloadPromise;
                const savedPath = await download.path();
                const suggestedFilename = download.suggestedFilename();
                console.log(`\n✅ [测试成功] 捕获到下载事件！`);
                console.log(`   文件名: ${suggestedFilename}`);
                
                // 另存为测试
                // 确保测试目录存在
                await fs.mkdir(DOWNLOAD_FOLDER, { recursive: true });
                const saveTo = path.join(DOWNLOAD_FOLDER, `TEST_${suggestedFilename}`);
                await download.saveAs(saveTo);
                console.log(`   已保存到: ${saveTo}`);

            } catch (e) {
                console.error(`❌ [测试失败] 点击了按钮，但在 15 秒内未检测到下载事件。`);
                console.error(`   可能原因：1. 文件已过期无法下载 2. 浏览器弹窗拦截 3. 网络延迟`);
            }

        } else {
            console.log(' -> ⚠️ 在第一个卡片中未找到“下载报表”按钮。');
            
            // 状态诊断
            const isGenerating = await firstCard.getByText('生成中').isVisible();
            if (isGenerating) {
                console.log(' -> 状态检测：当前最新报表显示为 [生成中]，无法下载。');
                console.log(' -> 建议：请等待片刻后重新生成或刷新页面。');
            } else {
                console.log(' -> 状态检测：可能是“失败”或“已过期”状态，请检查界面文字。');
            }
        }

        console.log('\n -> 🛑 测试脚本将暂停，保持浏览器开启，您可以手动调试 F12。');
        console.log('    (在控制台按 Ctrl+C 结束脚本)');
        
        // 保持浏览器不关闭，方便您调试
        await new Promise(() => {}); 

    } catch (error) {
        console.error('❌ 脚本执行出错:', error);
    } finally {
        if (context) {
            // await context.close(); 
        }
    }
}

runTest();