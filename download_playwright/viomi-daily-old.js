// viomi-daily-pua.js

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import axios from 'axios'; // 需要安装: npm install axios

// --- 配置区域 ---
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;
// ⚠️ 去 https://platform.deepseek.com/ 申请一个 Key
const DEEPSEEK_API_KEY = "sk-518c2cffc9bf4fab860573856aea8537"; 

// 路径配置
const OBSIDIAN_VAULT_PATH = 'D:\\D_obsidian\\obsidian\\拼多多-净水项目\\工作日报';
const HISTORY_FILE = 'viomi_history.json';

// ... [省略之前的辅助函数 parseNumber, formatToWan, updateAndGetHistory 以节省篇幅，请保留原有的] ...
// ... [请确保 parseNumber, formatToWan, updateAndGetHistory, calculateSmartPrediction, sendEmail 这些函数都在] ...

// 补全辅助函数，防止你复制漏了
function parseNumber(str) {
    if (typeof str !== 'string') return 0;
    const cleanStr = str.replace(/,/g, '').replace(/%/g, '').replace(/万/g, '');
    const match = cleanStr.match(/([\d\.\-]+)/);
    return match ? parseFloat(match[1]) : 0;
}
function formatToWan(num) { return num.toFixed(1) + '万'; }

// -----------------------------------------------------------
// 核心：调用 AI 生成 PUA 内容
// -----------------------------------------------------------
async function generatePUAComment(dataContext) {
    console.log("😈 正在召唤毒舌老板进行 PUA...");
    
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY.includes("xxxx")) {
        return "> [!warning] PUA 失败\n> 请在脚本中配置正确的 DEEPSEEK_API_KEY 才能体验被骂的感觉。";
    }

    const systemPrompt = `
你是一个极度苛刻、擅长精神控制（PUA）的电商总监。你的员工发来了日报，你要对他进行“脱敏训练”。
请根据数据，用最尖酸、刻薄、让人脸红心跳的语气进行点评。
不要给建议，只给压力。要让他觉得自己一无是处，辜负了公司的培养。
常用话术：“这就是你的思考？”、“你是不是不想干了？”、“不要给我找理由”、“我看不到你的价值”。
字数控制在 150 字以内。
    `;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `日报数据如下：\n${dataContext}` }
            ],
            temperature: 1.3 // 温度调高，让它骂得更花哨
        }, {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("❌ AI 调用失败:", error.message);
        return "> [!error] 老板今天没空骂你 (API Error)";
    }
}

// ... [主程序逻辑] ...
async function runScript() {
    // ... [前半部分抓取逻辑保持不变，直到 finally 块] ...
    // 为了演示完整流程，这里简化展示抓取后的逻辑：
    
    // 假设这些是抓取到的数据（请保留你原有的抓取代码）
    // const shipmentData = ...
    // const gsvData = ...
    // const shipPred = ...
    // const gsvPred = ...

    // ==========================================================
    // 在生成 Markdown 之前，插入 AI 调用
    // ==========================================================
    
    // 1. 准备发给 AI 的数据摘要
    const dataForAI = `
    日期: ${new Date().toLocaleDateString()}
    【出货业绩】
    目标: ${shipmentData.target}
    当前进度: ${shipmentData.rate} (累计 ${shipmentData.cumulative})
    昨日完成: ${shipmentData.yesterday}
    AI预测全月: ${formatToWan(shipPred.total)} (达成率 ${(shipPred.total/parseNumber(shipmentData.target)*100).toFixed(0)}%)

    【零售业绩(GSV)】
    目标: ${gsvData.monthTarget}
    当前进度: ${gsvData.monthRate}
    昨日完成: ${gsvData.dailyRetail}
    AI预测全月: ${formatToWan(gsvPred.total)} (达成率 ${(gsvPred.total/parseNumber(gsvData.monthTarget)*100).toFixed(0)}%)
    `;

    // 2. 获取 PUA 内容
    const puaText = await generatePUAComment(dataForAI);

    // 3. 写入 Markdown (植入 PUA)
    const markdownContent = `---
CreateTime: ${new Date().toLocaleString()}
Type: 自动日报
Tags: #电商/拼多多 #自动报表
---

# 📅 ${new Date().toLocaleDateString()} 拼多多运营日报

## 1. 核心数据
| 维度 | 目标 | 累计 | **预测全月** | **预测达成率** |
| :--- | :--- | :--- | :--- | :--- |
| **出货** | ${shipmentData.target} | ${shipmentData.cumulative} | **${formatToWan(shipPred.total)}** | **${(shipPred.total/parseNumber(shipmentData.target)*100).toFixed(0)}%** |
| **零售** | ${gsvData.monthTarget} | ${gsvData.monthAchieved} | **${formatToWan(gsvPred.total)}** | **${(gsvPred.total/parseNumber(gsvData.monthTarget)*100).toFixed(0)}%** |

## 2. ⚡ 每日灵魂拷问 (PUA Time)
> **警告：以下内容为 AI 模拟的高压反馈，旨在进行心理脱敏。请深呼吸。**

${puaText.replace(/^/gm, '> ')} 
*(引用结束)*

## 3. 我的反击 (复盘)
- **针对指责**：
- **下一步动作**：
`;
    
    // ... [写入文件逻辑保持不变] ...
}