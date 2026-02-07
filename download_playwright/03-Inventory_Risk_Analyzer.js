// 03-Inventory_Risk_Analyzer.js - 库存风险智能诊断分析脚本 (V2: 修复 ESM 兼容性报错)
//
// 核心逻辑：
// 1. 读取最新的【库存数据】：从 viomi_central_inventory 表获取每个 69 码的当前可用库存。
// 2. 清洗并统计【销售数据】：从 pddorder 表读取订单，解析“订单号”里的日期，提取“商品规格”里的 69 码。
// 3. 计算【日均销量 (ADS)】：默认统计过去 30 天的销售数据，计算平均每天卖出多少。
// 4. 计算【周转天数 (DOS)】：当前库存 / 日均销量 = 还能卖几天。
// 5. 智能判定风险等级：输出“超卖预警”和“滞销预警”两份名单。

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs'; // 🟢 修正：使用 import 引入 fs 模块，替代 require
import { fileURLToPath } from 'url';

// --- 配置区域 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库路径 (请确保路径正确)
const DB_FILE = 'C:\\Users\\Administrator\\my-playwright-project\\download_playwright\\sql_data\\TmallDataCenter.db';

// 风险阈值设置 (你可以根据实际业务调整)
const CONFIG = {
    ANALYSIS_DAYS: 30,      // 分析周期：统计过去 30 天的销量来计算热度
    STOCKOUT_WARNING: 7,    // 超卖预警：如果库存只够卖 7 天，就报警
    SLOW_MOVING_WARNING: 90 // 滞销预警：如果库存够卖 90 天以上，就报警
};

// --- 工具函数 ---

// 将订单号前6位 (如 '260205') 转为 Date 对象
function parseOrderDate(orderIdStr) {
    if (!orderIdStr || orderIdStr.length < 6) return null;
    const yearStr = orderIdStr.substring(0, 2);
    const monthStr = orderIdStr.substring(2, 4);
    const dayStr = orderIdStr.substring(4, 6);
    // 假设是 20xx 年
    const fullYear = parseInt('20' + yearStr);
    return new Date(fullYear, parseInt(monthStr) - 1, parseInt(dayStr));
}

// 简单的 69 码提取器 (去除空白和非数字字符)
function cleanProductCode(specStr) {
    if (!specStr) return '未知商品';
    const match = String(specStr).match(/\d{13}/); 
    if (match) return match[0];
    
    const clean = String(specStr).replace(/\D/g, '').trim();
    return clean.length > 5 ? clean : '未知商品';
}

async function main() {
    console.log('📊 正在启动库存风险智能分析...');
    
    // 🟢 修正：直接使用导入的 fs 对象，不再使用 require
    if (!fs.existsSync(DB_FILE)) {
        console.error(`❌ 数据库文件不存在: ${DB_FILE}`);
        return;
    }

    const db = new Database(DB_FILE, { readonly: true }); // 只读模式，安全

    try {
        // --- 第一步：获取最新库存快照 ---
        console.log('1️⃣  正在读取最新库存数据...');
        
        // 找到数据库里最新的“查询日期”
        const lastDateRow = db.prepare('SELECT max(查询日期) as lastDate FROM viomi_central_inventory').get();
        if (!lastDateRow || !lastDateRow.lastDate) {
            console.error('❌ 数据库中没有库存记录，请先运行库存抓取脚本。');
            return;
        }
        const snapshotDate = lastDateRow.lastDate;
        console.log(`   -> 锁定库存快照日期: ${snapshotDate}`);

        // 获取该日期的所有库存
        const inventoryRows = db.prepare(`
            SELECT 商品69码 as code, sum(可用库存) as stock, 仓库名称 as warehouse
            FROM viomi_central_inventory 
            WHERE 查询日期 = ?
            GROUP BY 商品69码
        `).all(snapshotDate);

        // 建立库存映射 Map: Code -> Total Stock
        const inventoryMap = new Map();
        inventoryRows.forEach(row => {
            const code = String(row.code).trim();
            const current = inventoryMap.get(code) || 0;
            inventoryMap.set(code, current + row.stock);
        });
        console.log(`   -> 已加载 ${inventoryMap.size} 个商品的库存信息。`);


        // --- 第二步：统计过去 N 天的销量 ---
        console.log(`2️⃣  正在统计过去 ${CONFIG.ANALYSIS_DAYS} 天的销售数据...`);
        
        // 计算时间窗口
        const today = new Date();
        const startDate = new Date();
        startDate.setDate(today.getDate() - CONFIG.ANALYSIS_DAYS);
        
        // 读取所有订单
        const orderRows = db.prepare(`
            SELECT "订单号" as orderId, "商家编码_规格维度" as spec, "商品数量_件_" as qty 
            FROM pddorder
        `).all();

        const salesMap = new Map(); // Code -> 30天总销量

        let validOrderCount = 0;
        for (const row of orderRows) {
            const orderDate = parseOrderDate(String(row.orderId));
            
            // 过滤日期：只统计时间窗口内的
            if (orderDate && orderDate >= startDate && orderDate <= today) {
                const code = cleanProductCode(row.spec);
                const qty = parseFloat(row.qty) || 0;
                
                if (code !== '未知商品') {
                    const currentSales = salesMap.get(code) || 0;
                    salesMap.set(code, currentSales + qty);
                    validOrderCount++;
                }
            }
        }
        console.log(`   -> 分析了 ${validOrderCount} 条有效订单，涵盖 ${salesMap.size} 个商品。`);


        // --- 第三步：交叉分析与风险计算 ---
        console.log('3️⃣  正在进行交叉计算...');
        
        const report = [];
        // 合并所有出现过的商品（库存表里的 + 销售表里的）
        const allCodes = new Set([...inventoryMap.keys(), ...salesMap.keys()]);

        for (const code of allCodes) {
            const stock = inventoryMap.get(code) || 0;
            const sales30Days = salesMap.get(code) || 0;
            
            // 计算日均销量 (ADS)
            const dailySales = sales30Days / CONFIG.ANALYSIS_DAYS;
            
            // 计算预计可售天数 (Days of Supply)
            let daysToStockout = 9999; // 默认无限
            if (dailySales > 0) {
                daysToStockout = stock / dailySales;
            } else if (stock <= 0 && dailySales > 0) {
                daysToStockout = 0; // 没库存但有销量，理解为已断货
            }

            // 判定风险类型
            let riskType = 'NORMAL'; // 正常
            if (stock <= 0 && sales30Days > 0) riskType = 'OUT_OF_STOCK'; // 已断货
            else if (daysToStockout < CONFIG.STOCKOUT_WARNING) riskType = 'HIGH_RISK_OVERSOLD'; // 即将超卖
            else if (stock > 0 && sales30Days === 0) riskType = 'DEAD_STOCK'; // 死库存（不动销）
            else if (daysToStockout > CONFIG.SLOW_MOVING_WARNING) riskType = 'SLOW_MOVING'; // 滞销

            report.push({
                code,
                stock,
                sales30Days,
                dailySales: dailySales.toFixed(2),
                daysToStockout: daysToStockout === 9999 ? '∞' : daysToStockout.toFixed(1),
                riskType
            });
        }

        // --- 第四步：输出报告 ---
        console.log('\n===============================================================');
        console.log(`📊 库存健康度分析报告 (分析周期: 近 ${CONFIG.ANALYSIS_DAYS} 天)`);
        console.log('===============================================================\n');

        // 1. 🚨 高危：超卖/断货预警
        const urgentItems = report.filter(r => ['OUT_OF_STOCK', 'HIGH_RISK_OVERSOLD'].includes(r.riskType))
                                  .sort((a, b) => parseFloat(a.daysToStockout) - parseFloat(b.daysToStockout)); // 按可售天数升序

        if (urgentItems.length > 0) {
            console.log(`🔴 【高危预警】可能超卖/已断货 (共 ${urgentItems.length} 款)`);
            console.log(`   判定标准：库存不够卖 ${CONFIG.STOCKOUT_WARNING} 天`);
            console.log(`---------------------------------------------------------------`);
            console.log(`| 商品69码        | 当前库存 | 30天销量 | 日均销 | 还能卖(天) | 状态 |`);
            console.log(`|-----------------|----------|----------|--------|------------|------|`);
            urgentItems.forEach(item => {
                const status = item.riskType === 'OUT_OF_STOCK' ? '已断货!' : '即将断货';
                console.log(`| ${item.code.padEnd(15)} | ${String(item.stock).padStart(8)} | ${String(item.sales30Days).padStart(8)} | ${String(item.dailySales).padStart(6)} | ${String(item.daysToStockout).padStart(10)} | ${status} |`);
            });
            console.log('\n');
        }

        // 2. 🧊 滞销预警
        const slowItems = report.filter(r => ['DEAD_STOCK', 'SLOW_MOVING'].includes(r.riskType))
                                .sort((a, b) => b.stock - a.stock); // 按库存积压量降序

        if (slowItems.length > 0) {
            console.log(`🔵 【滞销预警】库存积压严重 (共 ${slowItems.length} 款)`);
            console.log(`   判定标准：库存够卖 ${CONFIG.SLOW_MOVING_WARNING} 天以上，或30天无销量`);
            console.log(`---------------------------------------------------------------`);
            console.log(`| 商品69码        | 当前库存 | 30天销量 | 日均销 | 还能卖(天) | 状态 |`);
            console.log(`|-----------------|----------|----------|--------|------------|------|`);
            // 只展示库存最多的前 20 个，避免刷屏
            slowItems.slice(0, 20).forEach(item => {
                const status = item.riskType === 'DEAD_STOCK' ? '死库存' : '严重滞销';
                console.log(`| ${item.code.padEnd(15)} | ${String(item.stock).padStart(8)} | ${String(item.sales30Days).padStart(8)} | ${String(item.dailySales).padStart(6)} | ${String(item.daysToStockout).padStart(10)} | ${status} |`);
            });
            if (slowItems.length > 20) console.log(`| ... 以及其他 ${slowItems.length - 20} 款 ...                         |`);
            console.log('\n');
        }

        console.log('✅ 分析结束。');

    } catch (err) {
        console.error('❌ 程序运行出错:', err);
    } finally {
        db.close();
    }
}

main();