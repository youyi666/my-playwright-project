// viomi-download-script-daily.js

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

// --- 配置信息 ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// 邮件配置
const EMAIL_CONFIG = {
    smtp_server: "smtp.exmail.qq.com",
    smtp_port: 465,
    sender_email: "luojunsheng@viomi.com",
    sender_password: "HCXRGMx63n7hRt9W", 
    recipients: [
        "luojunsheng@viomi.com"
    ]
};

// --- URL 配置 ---
const SHIPMENT_URL = 'https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=1475';
const GSV_URL = 'https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=1506';

// --- Obsidian 配置 ---
// 路径使用了双反斜杠 \\ 来转义
const OBSIDIAN_VAULT_PATH = 'D:\\D_obsidian\\obsidian\\拼多多-净水项目\\工作日报';
// [新增] 历史数据存储文件 (自动生成在同一目录下)
const HISTORY_FILE = 'viomi_history.json';

// 辅助函数：解析数字 (移除万字和逗号)
function parseNumber(str) {
    if (typeof str !== 'string') return 0;
    const cleanStr = str.replace(/,/g, '').replace(/%/g, '');
    const match = cleanStr.match(/([\d\.\-]+)/);
    if (!match) return 0;
    let num = parseFloat(match[1]);
    // 如果包含“万”，统一转为数字便于计算 (脚本内部逻辑统一用“万”为单位的数值)
    return num;
}

// 辅助函数：格式化数字为“万”字符串
function formatToWan(num) {
    return num.toFixed(1) + '万';
}

// 辅助函数：Markdown 转 HTML
function markdownToHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
               .replace(/\n/g, '<br/>');
}

/**
 * [核心新增] 管理历史数据
 * 读取 json -> 写入今天的数据 -> 保存 -> 返回本月所有数据数组
 */
function updateAndGetHistory(dateStr, shipmentVal, gsvVal) {
    const filePath = path.join(OBSIDIAN_VAULT_PATH, HISTORY_FILE);
    let history = { shipment: {}, gsv: {} };

    // 1. 读取现有历史
    if (fs.existsSync(filePath)) {
        try {
            history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error('读取历史文件失败，将重新创建:', e.message);
        }
    }

    // 2. 写入/更新“昨日”的数据 (注意：key是日期)
    // 脚本运行是“今天”，抓的是“昨日”的数据，但我们按“数据产生的日期”来存比较好管理吗？
    // 为了简单，我们直接用 key = dateStr (运行脚本的当天日期，代表记录下“前一天”的数据)
    // 或者更严谨一点，算一下昨天的日期。
    // 这里我们直接用传入的 dateStr (脚本运行日期) 作为 Key，代表“在这一天记录到的昨日数据”。
    history.shipment[dateStr] = shipmentVal;
    history.gsv[dateStr] = gsvVal;

    // 3. 保存
    try {
        if (!fs.existsSync(OBSIDIAN_VAULT_PATH)){
            fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('写入历史文件失败:', e.message);
    }

    return history;
}

/**
 * [核心新增] 智能预测逻辑 (去除最高峰)
 */
function calculateSmartPrediction(currentCumulative, historyMap, daysPassed, daysRemaining, currentMonthPrefix) {
    // 1. 提取本月已记录的所有单日数据
    let dailyValues = [];
    for (let dateKey in historyMap) {
        if (dateKey.startsWith(currentMonthPrefix)) {
            dailyValues.push(historyMap[dateKey]);
        }
    }

    // 2. 计算日均 (Run Rate)
    let runRate = 0;
    let logicDescription = "";

    // 情况A: 数据太少 (少于3天)，没法去除最高峰，直接用累计/天数
    if (dailyValues.length < 3) {
        // 如果历史记录也没数据，就用当前的 total / days
        runRate = daysPassed > 0 ? (currentCumulative / daysPassed) : 0;
        logicDescription = "数据积累少于3天，采用简单平均";
    } 
    // 情况B: 数据充足，去除最高峰
    else {
        let maxVal = Math.max(...dailyValues);
        let sumVal = dailyValues.reduce((a, b) => a + b, 0);
        
        // 去除最高值后的总和 / (天数 - 1)
        let adjustedSum = sumVal - maxVal;
        let adjustedCount = dailyValues.length - 1;
        
        runRate = adjustedSum / adjustedCount;
        logicDescription = `基于${dailyValues.length}天数据，剔除峰值(${maxVal}万)`;
    }

    // 3. 预测月末 = 当前累计(已落袋) + (日均 x 剩余天数)
    let predictedTotal = currentCumulative + (runRate * daysRemaining);
    
    return {
        total: predictedTotal,
        rate: runRate,
        desc: logicDescription
    };
}

/**
 * 发送邮件
 */
async function sendEmail(subject, text, html) {
    console.log('📧 准备发送邮件...');
    let transporter = nodemailer.createTransport({
        host: EMAIL_CONFIG.smtp_server,
        port: EMAIL_CONFIG.smtp_port,
        secure: true, 
        auth: {
            user: EMAIL_CONFIG.sender_email,
            pass: EMAIL_CONFIG.sender_password,
        },
        tls: { rejectUnauthorized: false }
    });

    try {
        let info = await transporter.sendMail({
            from: `"${EMAIL_CONFIG.sender_email}" <${EMAIL_CONFIG.sender_email}>`,
            to: EMAIL_CONFIG.recipients.join(','),
            subject: subject, 
            text: text, 
            html: html 
        });
        console.log("✅ 邮件发送成功: %s", info.messageId);
    } catch (error) {
        console.error("❌ 邮件发送失败:", error);
    }
}

/**
 * 主程序
 */
async function runScript() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
        console.error('❌ 错误：请设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。');
        return;
    }

    const browser = await chromium.launch({ headless: true }); 
    const page = await browser.newPage();
    
    let shipmentData = {};
    let gsvData = {};
    let todayDate = new Date();

    try {
        // 1. 登录
        console.log(`🚀 开始导航到出货看板: ${SHIPMENT_URL}`);
        await page.goto(SHIPMENT_URL, { waitUntil: 'domcontentloaded' });
        
        console.log('🔑 正在登录...');
        try {
            await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
            await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
            await page.getByRole('button', { name: '登 录' }).click();
            await page.waitForLoadState('networkidle');
        } catch (e) {
            console.log('⚠️ 登录步骤跳过 (可能已登录):', e.message);
        }

        // 2. 抓取出货
        console.log('📦 [1/2] 正在抓取出货数据...');
        if (page.url() !== SHIPMENT_URL) await page.goto(SHIPMENT_URL, { waitUntil: 'networkidle' });

        const shipmentRowSelector = 'tr[data-row-key*="线上_吴云云_拼多多"]';
        try {
            await page.locator(shipmentRowSelector).waitFor({ state: 'visible', timeout: 60000 });
            const vals = await page.locator(shipmentRowSelector).locator('td.ant-table-cell').allTextContents();
            shipmentData = {
                target: vals[2].trim(),       // 全月任务
                yesterday: vals[3].trim(),    // 昨日完成
                cumulative: vals[4].trim(),   // 累计完成
                rate: vals[7].trim()          // 完成率
            };
        } catch (e) {
            shipmentData = { target: '0', yesterday: '0', cumulative: '0', rate: '0%' };
            console.error('⚠️ 出货抓取失败');
        }

        // 3. 抓取零售(GSV)
        console.log('💰 [2/2] 正在跳转至 GSV 零售看板...');
        await page.goto(GSV_URL, { waitUntil: 'networkidle' });
        try {
            const gsvRow = page.locator('tr').filter({ hasText: '拼多多' }).first();
            await gsvRow.waitFor({ state: 'visible', timeout: 60000 });
            const vals = await gsvRow.locator('td').allTextContents();
            gsvData = {
                monthTarget: vals[3].trim(), 
                monthRate: vals[4].trim(),       
                monthAchieved: vals[5].trim(), 
                dailyRetail: vals[8].trim()    
            };
        } catch (e) {
            gsvData = { monthTarget: '0', monthRate: '0%', monthAchieved: '0', dailyRetail: '0' };
            console.error('⚠️ GSV 抓取失败');
        }

    } catch (error) {
        console.error('❌ 运行错误:', error);
    } finally {
        await browser.close();
        console.log('🔒 浏览器已关闭');

        // =================================================================
        // 第四步：智能预测与生成
        // =================================================================
        
        // 1. 准备数据
        const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate(); 
        const daysPassed = todayDate.getDate() - 1; 
        const daysRemaining = daysInMonth - daysPassed;
        const currentMonthPrefix = `${todayDate.getFullYear()}-${(todayDate.getMonth()+1).toString().padStart(2, '0')}`;
        const todayDateStr = `${currentMonthPrefix}-${todayDate.getDate().toString().padStart(2, '0')}`;

        // 2. 更新历史库 (Key: 今天日期, Value: 昨天的数值)
        const shipmentVal = parseNumber(shipmentData.yesterday);
        const gsvVal = parseNumber(gsvData.dailyRetail);
        const history = updateAndGetHistory(todayDateStr, shipmentVal, gsvVal);

        // 3. 计算智能预测
        // 出货预测
        const shipCum = parseNumber(shipmentData.cumulative);
        const shipPred = calculateSmartPrediction(shipCum, history.shipment, daysPassed, daysRemaining, currentMonthPrefix);
        
        // 零售预测
        const gsvCum = parseNumber(gsvData.monthAchieved);
        const gsvPred = calculateSmartPrediction(gsvCum, history.gsv, daysPassed, daysRemaining, currentMonthPrefix);

        // 4. 构建文案
        const summaryText = `
**📊 出货 (Shipment)**
- 目标: ${shipmentData.target} | 进度: ${shipmentData.rate}
- 昨日: ${shipmentData.yesterday}
- 🔮 **本月预测**: ${formatToWan(shipPred.total)} (达成率 ${(shipPred.total/parseNumber(shipmentData.target)*100).toFixed(0)}%)
- *预测逻辑: ${shipPred.desc}*

**💰 零售 (GSV)**
- 目标: ${gsvData.monthTarget}万 | 达成: ${gsvData.monthRate}
- 昨日: ${gsvData.dailyRetail}万
- 🔮 **本月预测**: ${formatToWan(gsvPred.total)} (达成率 ${(gsvPred.total/parseNumber(gsvData.monthTarget)*100).toFixed(0)}%)
        `.trim();

        const mailSubject = `[日报] 拼多多业绩: 出货${shipmentData.yesterday} / 零售${gsvData.dailyRetail} (${todayDate.toLocaleDateString()})`;

        // 5. 发送邮件
        await sendEmail(mailSubject, summaryText, markdownToHtml(summaryText));

        // 6. 写入 Obsidian
        console.log('\n📝 正在写入 Obsidian...');
        const dateFileName = `${todayDate.getFullYear()}-${(todayDate.getMonth()+1).toString().padStart(2, '0')}-${todayDate.getDate().toString().padStart(2, '0')}.md`;
        const fullPath = path.join(OBSIDIAN_VAULT_PATH, dateFileName);

        const markdownContent = `---
CreateTime: ${new Date().toLocaleString()}
Type: 自动日报
Tags: #电商/拼多多 #自动报表
Target_Shipment: ${shipmentData.target}
Progress_Shipment: ${shipmentData.rate}
Cumulative_Shipment: ${shipmentData.cumulative}
Yesterday_Shipment: ${shipmentData.yesterday}
Target_GSV: ${gsvData.monthTarget}
Progress_GSV: ${gsvData.monthRate}
Cumulative_GSV: ${gsvData.monthAchieved}
Yesterday_GSV: ${gsvData.dailyRetail}
---

# 📅 ${todayDate.toLocaleDateString()} 拼多多运营日报

## 🔮 智能预测 (本月达成)
> ${shipPred.desc}，去除高峰干扰。

| 维度 | 月度目标 | 当前累计 | **预测全月** | **预测达成率** |
| :--- | :--- | :--- | :--- | :--- |
| **出货** | ${shipmentData.target} | ${shipmentData.cumulative} | **${formatToWan(shipPred.total)}** | **${(shipPred.total/parseNumber(shipmentData.target)*100).toFixed(0)}%** |
| **零售** | ${gsvData.monthTarget} | ${gsvData.monthAchieved} | **${formatToWan(gsvPred.total)}** | **${(gsvPred.total/parseNumber(gsvData.monthTarget)*100).toFixed(0)}%** |

## 📦 基础数据详情
- **出货**: 昨日 ${shipmentData.yesterday}，本月累计 ${shipmentData.cumulative}
- **零售**: 昨日 ${gsvData.dailyRetail}，本月累计 ${gsvData.monthAchieved}

## 📝 每日复盘
### 1. 预测偏差分析
- [ ] 今天的预测值 (${formatToWan(shipPred.total)}) 是否符合预期？
- [ ] 如果去除高峰后的日均 (${formatToWan(shipPred.rate)}) 偏低，是否需要增加推广？

### 2. 今日重点
- [ ] 
`;

        try {
            if (!fs.existsSync(OBSIDIAN_VAULT_PATH)){
                fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });
            }
            fs.writeFileSync(fullPath, markdownContent);
            console.log(`✅ [Obsidian] 笔记已写入: ${fullPath}`);
        } catch (err) {
            console.error('❌ [Obsidian] 写入失败:', err.message);
        }
    }
}

runScript();