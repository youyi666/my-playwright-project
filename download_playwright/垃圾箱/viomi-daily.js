import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

// ================== 1. 配置区域 ==================
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;
const DEEPSEEK_API_KEY = "sk-518c2cffc9bf4fab860573856aea8537"; // ⚠️ 替换你的 Key

const TARGET_CHANNELS = ['拼多多', '京东', '天猫', '抖音'];
const OBSIDIAN_VAULT_PATH = 'D:\\D_obsidian\\obsidian\\拼多多-净水项目\\工作日报';
const HISTORY_FILE = 'viomi_history.json'; 

const EMAIL_CONFIG = {
    smtp_server: "smtp.exmail.qq.com",
    smtp_port: 465,
    sender_email: "luojunsheng@viomi.com",
    sender_password: "HCXRGMx63n7hRt9W", 
    recipients: ["luojunsheng@viomi.com"]
};

const SHIPMENT_URL = 'https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=1475';
const GSV_URL = 'https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=1506';

// ================== 2. 辅助工具 ==================

function parseNumber(str) {
    if (!str || typeof str !== 'string') return 0;
    const cleanStr = str.replace(/,/g, '').replace(/%/g, '').replace(/万/g, '');
    const match = cleanStr.match(/([\d\.\-]+)/);
    return match ? parseFloat(match[1]) : 0;
}

function formatToWan(num) { return num.toFixed(1) + '万'; }

// 邮件HTML渲染 (保持美观)
function markdownToHtml(text) {
    if (typeof text !== 'string') return '';
    let html = text
        .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #d9534f;">$1</strong>')
        .replace(/^> (.*$)/gim, '<div style="border-left: 4px solid #10b981; padding: 8px 12px; margin: 6px 0; background-color: #f0fdf4; color: #374151;">$1</div>')
        .replace(/^- (.*$)/gim, '<li style="margin-left: 20px;">$1</li>')
        .replace(/\n/g, '<br/>');
    return `<div style="font-family: '微软雅黑', sans-serif; line-height: 1.6; color: #333;">${html}</div>`;
}

// ================== 3. 核心功能 ==================

async function scrapeFilteredTable(page, type) {
    console.log(`🔍 [${type}] 正在扫描数据...`);
    const filteredRows = [];
    try {
        let tableScope;
        if (type === 'gsv') {
            try {
                tableScope = page.locator('div[class*="gridItem"]', { has: page.locator('h4', { hasText: '净水事业GSV日报NEW' }) });
                await tableScope.locator('tr.ant-table-row').first().waitFor({ timeout: 10000 });
            } catch(e) { tableScope = page; }
        } else {
            tableScope = page;
            await page.waitForSelector('tr.ant-table-row', { timeout: 15000 });
        }

        const rows = await tableScope.locator('tr.ant-table-row').all();
        for (const row of rows) {
            const cells = await row.locator('td').allTextContents();
            if (cells.length < 5) continue; 
            
            let rowData = {};
            let channelNameRaw = "";

            if (type === 'shipment') {
                channelNameRaw = cells[1]?.trim() || cells[0]?.trim();
                let targetIdx = (isNaN(parseNumber(cells[2])) && !isNaN(parseNumber(cells[3]))) ? 3 : 2;
                rowData = {
                    channel: channelNameRaw,
                    target: parseNumber(cells[targetIdx]),
                    yesterday: parseNumber(cells[targetIdx + 1]),
                    cumulative: parseNumber(cells[targetIdx + 2]),
                    rate: parseNumber(cells[targetIdx + 5]) 
                };
                if (rowData.rate === 0 && parseNumber(cells[7]) > 0) rowData.rate = parseNumber(cells[7]);
            } else if (type === 'gsv') {
                channelNameRaw = cells[1]?.trim();
                rowData = {
                    channel: channelNameRaw,
                    target: parseNumber(cells[3]), 
                    rate: parseNumber(cells[4]),   
                    cumulative: parseNumber(cells[5]), 
                    daily: parseNumber(cells[8]),      
                    traffic: parseNumber(cells[11]),   
                    conversion: parseNumber(cells[13]) 
                };
            }
            const matchedKey = TARGET_CHANNELS.find(key => channelNameRaw && channelNameRaw.includes(key));
            if (matchedKey && rowData.target > 0) {
                rowData.channel = matchedKey;
                filteredRows.push(rowData);
            }
        }
    } catch (e) { console.error(`⚠️ [${type}] 抓取异常:`, e.message); }
    return Array.from(new Map(filteredRows.map(item => [item.channel, item])).values());
}

async function generateCoachComment(myChannel, allData, historyData) {
    console.log("🧠 正在召唤 AI 教练...");
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY.includes("xxxx")) return "> [!warning] 缺少 AI Key";

    const today = new Date();
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const timeProgress = ((dayOfMonth / daysInMonth) * 100).toFixed(1);

    // 事实核查
    let maxConvRate = 0, maxConvChannel = "";
    TARGET_CHANNELS.forEach(c => {
        const d = allData.gsv.find(i => i.channel === c);
        if (d && d.conversion > maxConvRate) { maxConvRate = d.conversion; maxConvChannel = c; }
    });

    // 随机风格
    const styles = ["【犀利毒舌型】", "【热血教练型】", "【数据考据型】", "【老谋深算型】", "【风控预警型】"];
    const currentStyle = styles[Math.floor(Math.random() * styles.length)];

    let battleFieldInfo = `【四国杀数据 (时间进度:${timeProgress}%)】:`;
    const sortedChannels = TARGET_CHANNELS.map(c => {
        const g = allData.gsv.find(i => i.channel === c) || { rate: 0 };
        return { name: c, rate: g.rate };
    }).sort((a,b) => b.rate - a.rate);

    sortedChannels.forEach(item => {
        const c = item.name;
        const g = allData.gsv.find(i => i.channel === c) || {};
        const mark = c === myChannel ? "(我)" : "";
        battleFieldInfo += `\n- ${c}${mark}: 月目标达成${g.rate}% (转化率${g.conversion}%)`;
    });

    const systemPrompt = `
    你是一位电商运营总监。针对“${myChannel}”写日报点评。
    🔥 **今日人设**：${currentStyle}
    📅 **时间进度**：${timeProgress}%。
    
    【事实核查】：全场转化率最高的是${maxConvChannel}(${maxConvRate}%)。
    
    👉 **必须严格遵守以下输出格式**（不要改变关键词，否则系统无法识别）：
    🌟 **亮点**：(一句话概括，基于数据表扬)
    ⚔️ **差距**：(一句话概括，指出转化率或进度的硬伤)
    ⚡ **指令**：(给运营团队的具体动作建议)
    
    注意：保持犀利，不要废话，每项内容控制在 50 字以内。
    `;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: battleFieldInfo }],
            temperature: 1.1
        }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' } });
        return response.data.choices[0].message.content;
    } catch (error) { return "> [!error] AI Coach 正在开会"; }
}

// ================== 4. 主程序 ==================

async function runScript() {
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) { console.error('❌ 环境变量缺失'); return; }

    const browser = await chromium.launch({ headless: true }); 
    const page = await browser.newPage();
    let allShipmentData = [], allGSVData = [];
    const myChannel = "拼多多";
    const todayDate = new Date();

    try {
        // --- 1. 登录 ---
        console.log(`🚀 启动任务...`);
        await page.goto(SHIPMENT_URL, { waitUntil: 'domcontentloaded' });
        try {
            await page.waitForSelector('input[type="text"], input[placeholder*="用户"]', { timeout: 5000 });
            await page.fill('input[type="text"], input[placeholder*="用户"]', VIOMI_USERNAME);
            await page.fill('input[type="password"]', VIOMI_PASSWORD);
            await page.click('button, input[type="submit"], span:has-text("登 录")');
            await page.waitForLoadState('networkidle');
        } catch (e) { console.log('⚠️ 跳过自动登录'); }

        // --- 2. 抓取数据 ---
        console.log('💰 抓取零售...');
        if (page.url() !== GSV_URL) await page.goto(GSV_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000); 
        allGSVData = await scrapeFilteredTable(page, 'gsv');

        console.log('📦 抓取出货...');
        await page.goto(SHIPMENT_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000); 
        allShipmentData = await scrapeFilteredTable(page, 'shipment');

        // --- 3. 历史与AI ---
        let history = {};
        const historyPath = path.join(OBSIDIAN_VAULT_PATH, HISTORY_FILE);
        if (fs.existsSync(historyPath)) try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e){}

        const aiComment = await generateCoachComment(myChannel, { shipment: allShipmentData, gsv: allGSVData }, history);

        const myGSV = allGSVData.find(d => d.channel === myChannel) || {};
        history[myChannel] = { date: todayDate.toLocaleDateString(), gsv_rate: myGSV.rate };
        if (!fs.existsSync(OBSIDIAN_VAULT_PATH)) fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

        // --- 4. 组装报表数据 ---
        const myShipData = allShipmentData.find(d => d.channel === myChannel) || { target: 0, yesterday: 0, cumulative: 0, rate: 0 };
        
        const daysPassed = todayDate.getDate() || 1;
        const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate();
        const daysRemaining = daysInMonth - daysPassed;
        
        // 核心预测逻辑
        const gsvDailyAvg = myGSV.cumulative / daysPassed; // 零售日均
        const gsvPredTotal = myGSV.cumulative + (gsvDailyAvg * daysRemaining); // 预计全月
        const gsvPredRate = (gsvPredTotal / myGSV.target * 100).toFixed(0);

        const shipDailyAvg = myShipData.cumulative / daysPassed; // 出货日均
        const shipPredTotal = myShipData.cumulative + (shipDailyAvg * daysRemaining);
        const shipPredRate = (shipPredTotal / myShipData.target * 100).toFixed(0);

        // --- 5. 生成你想要的叙事型邮件文案 ---
        const emailBody = `
### 📊 核心数据复盘

**【零售 (GSV)】**
本月目标 **${myGSV.target}万**，当前进度 **${myGSV.rate}%**（已完成 ${myGSV.cumulative}万）。
昨日零售 **${myGSV.daily}万**。
按此趋势（日均 ${gsvDailyAvg.toFixed(2)}万），预计全月总达成 **${gsvPredTotal.toFixed(1)}万**（达成率 ${gsvPredRate}%）。

**【出货 (Shipment)】**
本月目标 **${myShipData.target}万**，当前进度 **${myShipData.rate}%**（已完成 ${myShipData.cumulative}万）。
昨日出货 **${myShipData.yesterday}万**。
按此趋势（日均 ${shipDailyAvg.toFixed(2)}万），预计全月总达成 **${shipPredTotal.toFixed(1)}万**（达成率 ${shipPredRate}%）。

---
### 🏆 AI点评
${aiComment}
        `.trim();

        await sendEmailWithRetry(`[日报] 拼多多业绩复盘 (${todayDate.toLocaleDateString()})`, emailBody, markdownToHtml(emailBody));

        // --- 6. 生成 Obsidian (保持 YAML 格式) ---
        const dateFileName = `${todayDate.getFullYear()}-${(todayDate.getMonth()+1).toString().padStart(2, '0')}-${todayDate.getDate().toString().padStart(2, '0')}.md`;
        const fullPath = path.join(OBSIDIAN_VAULT_PATH, dateFileName);
        const fullDateStr = `${todayDate.getFullYear()}/${todayDate.getMonth()+1}/${todayDate.getDate()} ${todayDate.toLocaleTimeString()}`;

        let comparisonTableMd = `| 渠道 | 零售达成 | 转化率 | 出货达成 | 昨日零售 |\n| :--- | :--- | :--- | :--- | :--- |\n`;
        TARGET_CHANNELS.forEach(c => {
            const g = allGSVData.find(x => x.channel === c) || {rate:0, conversion:0, daily:0};
            const s = allShipmentData.find(x => x.channel === c) || {rate:0};
            const style = c === myChannel ? '**' : '';
            // ⚠️ 关键：转化率 ${g.conversion}% 必须放在第三个位置
            comparisonTableMd += `| ${style}${c}${style} | ${g.rate}% | ${g.conversion}% | ${s.rate}% | ${g.daily}万 |\n`;
        });

        const markdownContent = `---
CreateTime: ${fullDateStr}
Type: 自动日报
Tags: #电商/拼多多 #自动报表
Target_Shipment: ${formatToWan(myShipData.target)}
Progress_Shipment: ${myShipData.rate}%
Cumulative_Shipment: ${formatToWan(myShipData.cumulative)}
Yesterday_Shipment: ${formatToWan(myShipData.yesterday)}
Target_GSV: ${myGSV.target}
Progress_GSV: ${myGSV.rate}%
Cumulative_GSV: ${myGSV.cumulative}
Yesterday_GSV: ${myGSV.daily}
---

# 📅 ${todayDate.toLocaleDateString()} 拼多多运营日报

## 🔮 智能预测 (本月达成)
> 基于${daysPassed}天数据，线性推演。

| 维度 | 月度目标 | 当前累计 | **预测全月** | **预测达成率** |
| :--- | :--- | :--- | :--- | :--- |
| **出货** | ${formatToWan(myShipData.target)} | ${formatToWan(myShipData.cumulative)} | **${formatToWan(shipPredTotal)}** | **${shipPredRate}%** |
| **零售** | ${myGSV.target} | ${myGSV.cumulative} | **${formatToWan(gsvPredTotal)}** | **${gsvPredRate}%** |

## 📦 基础数据详情
- **出货**: 昨日 ${formatToWan(myShipData.yesterday)}，本月累计 ${formatToWan(myShipData.cumulative)}，按此趋势（日均 ${shipDailyAvg.toFixed(2)}万），预计全月总达成 **${shipPredTotal.toFixed(1)}万**（达成率 ${shipPredRate}%）
- **零售**: 昨日 ${myGSV.daily}，本月累计 ${myGSV.cumulative}万，按此趋势（日均 ${gsvDailyAvg.toFixed(2)}万），预计全月总达成 **${gsvPredTotal.toFixed(1)}万**（达成率 ${gsvPredRate}%）。

## ⚔️ 关键竞争 (Big 4)
${comparisonTableMd}

## 🏆 AI指导
${aiComment}

## 📝 我的思考 (Reflection)

### 1. 策略与价格决策 (Price Moves)
> 💡 **填写模板**: \`**[[商品名]]** | 💡 决策: #跟价 599 | 📝 备注: 京东降价\`
> *周报会自动抓取 #跟价 #跟涨 #躺平 等标签*
- [ ] 

### 2. 关键动作 (Action Items)
> *完成的事项请打钩 [x]，周报会自动汇总*
- [ ] 
`;
        fs.writeFileSync(fullPath, markdownContent);
        console.log(`✅ Obsidian 笔记已生成: ${fullPath}`);

    } catch (error) { console.error('❌ 运行错误:', error); } 
    finally { await browser.close(); }
}

async function sendEmailWithRetry(subject, text, html, retries = 3) {
    let transporter = nodemailer.createTransport({
        host: EMAIL_CONFIG.smtp_server, port: EMAIL_CONFIG.smtp_port, secure: true,
        auth: { user: EMAIL_CONFIG.sender_email, pass: EMAIL_CONFIG.sender_password },
        tls: { rejectUnauthorized: false }
    });
    for (let i = 0; i < retries; i++) {
        try { await transporter.sendMail({ from: EMAIL_CONFIG.sender_email, to: EMAIL_CONFIG.recipients, subject, text, html }); return; }
        catch (e) { await new Promise(res => setTimeout(res, 2000)); }
    }
}

runScript();