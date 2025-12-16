const { chromium } = require('playwright');
const XLSX = require('xlsx');
const clipboardy = require('clipboardy');
const path = require('path');

// ================= 配置区域 =================
// 1. 本地 Excel 路径 (注意：JS里路径建议用双斜杠 \\ 或者反斜杠 /)
const LOCAL_EXCEL_PATH = "D:\\我的数据\\data.xlsx";

// 2. 飞书表格的纯净链接 (建议用 sheets/sht... 结尾的链接)
const FEISHU_URL = "https://你的公司域名.feishu.cn/sheets/shtxxxxxxxxx";

// 3. 浏览器缓存路径 (保持登录状态)
const USER_DATA_DIR = "D:\\feishu_edge_data_js"; 
// ===========================================

(async () => {
    try {
        // --- 第一步：读取 Excel 并转为 TSV (制表符分隔) ---
        console.log("正在读取本地 Excel...");
        
        // 读取文件
        const workbook = XLSX.readFile(LOCAL_EXCEL_PATH);
        // 获取第一个 Sheet 的名字
        const sheetName = workbook.SheetNames[0];
        // 获取 Sheet 对象
        const worksheet = workbook.Sheets[sheetName];

        // 将 Sheet 转为 CSV 格式，但我们将分隔符(FS)设置为制表符(\t)
        // 这样就变成了 Excel 复制时的格式
        // strip: true 会去除多余的空行
        // blankrows: false 不跳过空行（保持数据结构）
        const copyText = XLSX.utils.sheet_to_csv(worksheet, { FS: "\t", strip: true, blankrows: false });
        // ============================================================
        // 🛑 【保险丝代码放在这里】 🛑
        // ============================================================
        
        // 检查 1: copyText 是否存在
        // 检查 2: copyText 的长度是否小于 10 个字符 (防止只有几个空格或空表)
        if (!copyText || copyText.length < 10) {
            console.error("❌ 【严重警告】本地 Excel 数据异常或为空！为了防止清空飞书，已停止同步。");
            // 直接强制退出程序，后面的代码都不会执行了
            process.exit(1);
        }

        console.log(`✅ 数据检查通过，长度: ${copyText.length}，准备同步...`);
        // ============================================================
        if (!copyText) {
            console.log("Excel 为空或读取失败！");
            return;
        }

        // 写入剪贴板
        clipboardy.writeSync(copyText);
        console.log(`已读取数据并写入剪贴板 (长度: ${copyText.length})`);


        // --- 第二步：启动 Edge 浏览器 ---
        console.log("正在启动 Edge 浏览器...");
        
        // launchPersistentContext 对应 Python 的同名函数
        const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
            channel: "msedge",      // 指定使用 Edge
            headless: true,        // 显示界面
            args: ["--start-maximized"],
            viewport: null          // 禁用视口锁定
        });

        const page = context.pages()[0] || await context.newPage();

        // --- 第三步：访问飞书 ---
        console.log(`正在打开飞书: ${FEISHU_URL}`);
        
        // waitUntil: 'domcontentloaded' 对应 Python 的设置，防止 Wiki 页面超时
        await page.goto(FEISHU_URL, { timeout: 60000, waitUntil: 'domcontentloaded' });

        // 等待人工登录或页面加载
        console.log("等待页面加载...");
        await page.waitForTimeout(5000); // JS 里的 sleep

        // --- 第四步：定位并操作 ---
        console.log("正在定位表格...");
        
        // 同样，如果有 Wiki 干扰，这里可以改坐标
        await page.mouse.click(200, 300);
        await page.waitForTimeout(1000);

        // 回到左上角
        await page.keyboard.press("Control+Home");
        await page.waitForTimeout(1000);

        // 全选 (按两次保险)
        console.log("正在清空旧数据...");
        await page.keyboard.press("Control+A");
        await page.waitForTimeout(500);
        await page.keyboard.press("Control+A");
        await page.waitForTimeout(500);

        // 删除
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(1000);

        // 回到起始点
        await page.keyboard.press("Control+Home");
        await page.waitForTimeout(1000);

        // --- 第五步：粘贴 ---
        console.log("正在粘贴新数据...");
        await page.keyboard.press("Control+V");

        console.log("等待数据同步...");
        await page.waitForTimeout(5000);

        console.log("同步完成！");

        // 关闭浏览器 (如果需要)
        // await context.close();

    } catch (error) {
        console.error("发生错误:", error);
    }
})();