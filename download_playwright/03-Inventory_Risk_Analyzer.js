// 03-Inventory_Risk_Analyzer.js - 库存风险智能诊断分析脚本 (V6: 修复 SQL 报错，改为 Excel 筛选)
//
// 核心逻辑：
// 1. 【预处理】：读取 D:\price_scraper\tasks.xlsx，提取 Platform='拼多多' 且 [T]=1 的 69 码作为“目标白名单”。
// 2. 读取最新的【库存数据】：从 viomi_central_inventory 获取所有库存，但仅保留“目标白名单”中的商品。
// 3. 清洗并统计【销售数据】：从 pddorder 表读取订单，解析“订单号”里的日期，提取“商品规格”里的 69 码。
// 4. 计算【日均销量 (ADS)】：默认统计过去 30 天的销售数据，计算平均每天卖出多少。
// 5. 计算【周转天数 (DOS)】：当前库存 / 日均销量 = 还能卖几天。
// 6. 智能判定风险等级：
//    - 只有在“目标白名单”且“库存表”里存在的商品才参与计算。
//    - 状态判定优化：库存>0 但无销量，视为“新品上架/久滞销”。

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs'; 
import xlsx from 'xlsx'; // 🟢 新增：需要读取 Excel 来筛选商品
import { fileURLToPath } from 'url';

// --- 配置区域 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库路径 (请确保路径正确)
const DB_FILE = path.join(__dirname, '..', '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db');
// 任务列表路径 (用于筛选 Platform 和 [T])
const TASKS_EXCEL_PATH = 'D:\\WorkSpace\\03_Dev_自动化开发\\002号爬虫文件-Price_Scraper\\tasks.xlsx';

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
    
    if (!fs.existsSync(DB_FILE)) {
        console.error(`❌ 数据库文件不存在: ${DB_FILE}`);
        return;
    }
    
    if (!fs.existsSync(TASKS_EXCEL_PATH)) {
        console.error(`❌ 任务列表文件不存在: ${TASKS_EXCEL_PATH}`);
        return;
    }

    const db = new Database(DB_FILE, { readonly: true }); // 只读模式，安全

    try {
        // --- 第零步：读取 Excel 建立筛选白名单 ---
        console.log('0️⃣  正在读取任务表 Excel 建立筛选白名单...');
        
        const workbook = xlsx.readFile(TASKS_EXCEL_PATH);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const taskRows = xlsx.utils.sheet_to_json(sheet);
        
        // 建立白名单 Set (存放 69 码)
        const targetCodesSet = new Set();
        
        taskRows.forEach(row => {
            const platform = row['Platform'] ? String(row['Platform']).trim() : '';
            const tValue = row['[T]']; // 读取 [T] 列
            // 判断逻辑：Platform='拼多多' 且 [T]=1 (兼容数字和字符串)
            if (platform === '拼多多' && (tValue == 1 || String(tValue).trim() === '1')) {
                const code = String(row['ProductID']).trim();
                if (code && code.length > 5) {
                    targetCodesSet.add(code);
                }
            }
        });
        
        console.log(`   -> 筛选条件: Platform='拼多多' & [T]=1`);
        console.log(`   -> 符合条件的商品共: ${targetCodesSet.size} 款`);

        if (targetCodesSet.size === 0) {
            console.error('❌ 错误：在 Excel 中未找到符合条件的商品，脚本停止。');
            return;
        }

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

        // 获取该日期的所有库存 (这里不再在 SQL 里筛选 Platform，改为在 JS 里对比白名单)
        const inventoryRows = db.prepare(`
            SELECT 商品69码 as code, sum(可用库存) as stock, 仓库名称 as warehouse
            FROM viomi_central_inventory 
            WHERE 查询日期 = ?
            GROUP BY 商品69码
        `).all(snapshotDate);

        // 建立库存映射 Map: Code -> Total Stock
        // 🟢 关键修改：只加载在 targetCodesSet 白名单里的商品
        const inventoryMap = new Map();
        
        inventoryRows.forEach(row => {
            const code = String(row.code).trim();
            // 只有当这个 69 码存在于 Excel 筛选出的白名单中时，才处理
            if (targetCodesSet.has(code)) {
                const current = inventoryMap.get(code) || 0;
                inventoryMap.set(code, current + row.stock);
            }
        });
        
        console.log(`   -> 数据库中匹配到库存记录的商品: ${inventoryMap.size} / ${targetCodesSet.size} 款`);
        if (inventoryMap.size < targetCodesSet.size) {
            console.log(`   (注: 有 ${targetCodesSet.size - inventoryMap.size} 款商品在白名单中，但数据库今日未抓取到库存或已下架)`);
        }


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
                
                // 优化：只统计白名单内的商品销量 (虽然全统计也不影响，但这样更严谨)
                if (code !== '未知商品' && targetCodesSet.has(code)) {
                    const currentSales = salesMap.get(code) || 0;
                    salesMap.set(code, currentSales + qty);
                    validOrderCount++;
                }
            }
        }
        console.log(`   -> 分析了 ${validOrderCount} 条相关订单。`);


        // --- 第三步：交叉分析与风险计算 ---
        console.log('3️⃣  正在进行交叉计算...');
        
        const report = [];
        
        // 🔴【核心维持】：仅分析在 inventoryMap (库存表) 中存在的 69 码。
        // 逻辑：白名单 -> 且数据库有库存记录 -> 纳入分析。
        // 如果白名单里有，但数据库没抓到（InventoryMap里没有），则直接忽略（视为已下架）。
        const allCodes = new Set(inventoryMap.keys());

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
            
            if (stock <= 0 && sales30Days > 0) {
                // 只有当库存表里有记录（qty=0）且有销量时，才算“断货”。
                riskType = 'OUT_OF_STOCK'; 
            }
            else if (daysToStockout < CONFIG.STOCKOUT_WARNING) {
                riskType = 'HIGH_RISK_OVERSOLD'; // 即将超卖
            }
            else if (stock > 0 && sales30Days === 0) {
                // 🔴 提示：有库存，但30天没销量。
                riskType = 'DEAD_STOCK_OR_NEW'; 
            }
            else if (daysToStockout > CONFIG.SLOW_MOVING_WARNING) {
                riskType = 'SLOW_MOVING'; // 滞销
            }

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
        console.log(`📊 库存健康度分析报告 (Platform=拼多多, [T]=1, 周期: 近 ${CONFIG.ANALYSIS_DAYS} 天)`);
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

        // 2. 🧊 滞销/新品预警 (合并展示)
        const slowItems = report.filter(r => ['DEAD_STOCK_OR_NEW', 'SLOW_MOVING'].includes(r.riskType))
                                .sort((a, b) => b.stock - a.stock); // 按库存积压量降序

        if (slowItems.length > 0) {
            console.log(`🔵 【滞销/新品预警】库存积压严重 (共 ${slowItems.length} 款)`);
            console.log(`   判定标准：库存够卖 ${CONFIG.SLOW_MOVING_WARNING} 天以上，或 有库存但30天无销量`);
            console.log(`---------------------------------------------------------------`);
            console.log(`| 商品69码        | 当前库存 | 30天销量 | 日均销 | 还能卖(天) | 状态 |`);
            console.log(`|-----------------|----------|----------|--------|------------|------|`);
            // 只展示库存最多的前 20 个，避免刷屏
            slowItems.slice(0, 20).forEach(item => {
                let status = '严重滞销';
                if (item.riskType === 'DEAD_STOCK_OR_NEW') status = '新品/死库存'; 
                
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