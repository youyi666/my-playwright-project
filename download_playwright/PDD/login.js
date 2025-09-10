// login.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// 定义文件和文件夹路径
const userDataDir = path.join(__dirname, 'pdd-auth-profile'); // 使用独立的文件夹避免冲突
const authFilePath = path.join(__dirname, 'pdd_auth_state.json');

(async () => {
    // 1. 清理旧的认证文件和浏览器配置，确保每次都是全新的登录
    if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    if (fs.existsSync(authFilePath)) {
        fs.rmSync(authFilePath);
    }
    console.log('✅ 已清理旧的认证文件，准备开始全新的登录...');

    // 2. 启动一个带持久化存储的浏览器实例
    const browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            '--start-maximized', 
            '--disable-blink-features=AutomationControlled' // 避免被网站检测为自动化工具
        ],
        viewport: null // 窗口最大化
    });
    
    // 3. 给出清晰的操作指令
    console.log('\n🚀 浏览器已为您打开。');
    console.log('--- 请按以下步骤手动操作 ---');
    console.log('   1. 在新打开的浏览器里，访问 https://mms.pinduoduo.com/ 并完成登录。');
    console.log('   2. 登录成功后，请确保您已经进入了拼多多商家后台的主界面。');
    console.log('\n');
    console.log('   ✅✅✅【最关键一步】✅✅✅');
    console.log('   当您确认已登录成功后，');
    console.log('   请【切换回这个终端窗口】，然后【按一下回车键 (Enter)】...');

    // 4. 等待用户在终端按下回车键，确认已完成登录
    process.stdin.once('data', async () => {
        try {
            console.log('\n收到确认！正在保存登录状态...');
            
            // 5. 保存当前的浏览器状态 (Cookies, Local Storage等)
            await browserContext.storageState({ path: authFilePath });
            
            console.log(`🎉 成功！登录状态已保存到 \`${authFilePath}\` 文件中。`);
            console.log('现在您可以运行 scrape.js 脚本来进行数据抓取了。');

        } catch (error) {
            console.error('❌ 保存状态时出错:', error.message);
        } finally {
            // 6. 自动关闭浏览器并退出脚本
            await browserContext.close();
            console.log('浏览器已自动关闭。');
            process.exit(0);
        }
    });

})();