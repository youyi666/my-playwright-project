// =================================================================
// 淘宝搜索结果页爬虫 (Node.js + Playwright 版) - v2.3 多关键词遍历版
//
// 更新日志 (v2.3):
// 1. [核心改造] 支持遍历多个搜索关键词，实现批量爬取任务。
// 2. [配置更新] 将`SEARCH_KEYWORD`字符串改为`SEARCH_KEYWORDS`数组。
// 3. [逻辑重构] 主执行流程改为循环结构，为每个关键词创建独立爬虫实例，确保数据隔离。
// 4. [动态输出] Excel文件名和数据内的"品类"字段会根据当前关键词动态生成。
// =================================================================

const { chromium } = require('playwright-extra');
const { expect } = require('@playwright/test');
const stealth = require('puppeteer-extra-plugin-stealth')();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

chromium.use(stealth);

const CONFIG = {
    // --- 核心配置 ---
    // [改动] 将单一关键词改为关键词数组，以便遍历。您可以在此数组中添加任意数量的关键词。,'燃气热水器','智能门锁','油烟机'
    SEARCH_KEYWORDS: ['净水器1000G'], 
    AUTH_FILE_PATH: 'C:\\Users\\Administrator\\my-playwright-project\\auth.json',
    
    // --- [更新] 输出路径配置 ---
    OUTPUT_DIR_PATH: 'Z:\\平台价格监控\\Results\\平台价格', // Excel文件保存目录
    DB_PATH: 'Z:\\平台价格监控\\Results\\prices.db', // 数据库文件路径
    PREVIOUS_DATA_FILE: './商品列表数据-历史.xlsx', 
    
    // --- 抓取逻辑控制 ---
    shouldAggregateData: true, 
    minPriceFilter: 100,       
    stopSalesCount: 20,        
    maxPagesToScrape: 10,      

    // --- 行为参数 ---
    isHeadless: false,         
    scrollWaitTime: 500,       
    pageLoadTimeout: 30000,
    navigationTimeout: 60000,
};

// ... BRAND_LIBRARY 和 其他辅助方法保持不变 ...
const BRAND_LIBRARY = {
    // 燃气热水器品牌
    "卡萨帝": ["Casarte", "卡萨帝"], "美的": ["美的", "Midea"], "海尔": ["海尔", "Haier"],
    "万和": ["万和", "Vanward"], "万家乐": ["万家乐", "Macro"], "小米": ["小米", "Xiaomi"],
    "米家": ["米家", "MIJIA"], "Leader": ["Leader"], "华帝": ["华帝", "Vatti"],
    "方太": ["方太", "Fotile"], "老板": ["老板", "ROBAM"], "史密斯": ["史密斯", "A.O.Smith"],
    "林内": ["林内", "Rinnai"], "能率": ["能率", "Noritz"], "云米": ["云米", "Viomi"],
    "新飞": ["新飞", "Frestec"], "志高": ["志高", "CHIGO", "Chigo"], "奥克斯": ["奥克斯", "AUX"],
    "东芝": ["东芝", "Toshiba"], "樱花": ["樱花", "Sakura"], "百乐满": ["百乐满", "Paloma"],
    "前锋": ["前锋", "Qianfeng"], "半球": ["半球", "Pesko"], "好太太": ["好太太", "Haotaitai"],
    "迅达": ["迅达", "Xunda"], "百惠德": ["百惠德", "BHD"], "苏泊尔": ["苏泊尔", "Supor"],
    "先科": ["先科", "SAST"], "荣事达": ["荣事达", "Royalstar"], "帅康": ["帅康", "Sacon"],
    "樱雪": ["樱雪", "Inse"], "四季沐歌": ["四季沐歌", "Micoe"], "容声": ["容声", "Ronshen"],
    "冈田": ["冈田", "Okada"], "卡奇田": ["卡奇田", "Kaqitian"], "国美": ["国美", "gome"],
    "COLMO": ["科莫", "COLMO"],
    // 新增的门锁品牌
    "TCL": ["TCL", "TCL"], "爵象": ["爵象", "Juexiang"], "萤石": ["萤石", "EZVIZ"],
    "德力西": ["德力西", "DELIXI"], "云漫": ["云漫", "Yunman"], "德施曼": ["德施曼", "DESSMANN"],
    "康佳": ["康佳", "KONKA"], "博克": ["博克", "beck"], "邦臣": ["邦臣", "Bangchen"],
    "公牛": ["公牛", "BULL"], "凯迪仕": ["凯迪仕", "Kaadas"], "欧时特": ["欧时特", "Oshite"],
    "安成泰": ["安成泰", "Anchengtai"], "安将军": ["安将军", "Anjiangjun"], "murldyare": ["murldyare", "murldyare"],
    "龙霆": ["龙霆", "Longting"], "康廷": ["康廷", "Kangting"], "欧铂睿丰": ["欧铂睿丰", "Ouboruifeng"],
    "海康威视": ["海康威视", "Hikvision"], "陈光德力": ["陈光德力", "Chenguangdeli"], "乐橙": ["乐橙", "Lechange"],
    "华为": ["华为", "HUAWEI"], "柏嘉利": ["柏嘉利", "Baijiali"], "幻侣": ["幻侣", "Huanlv"],
    "卡伦玛仕": ["卡伦玛仕", "Kalunmashi"], "凌仕": ["凌仕", "Lingshi"], "乔安": ["乔安", "JOOAN"],
    "戴司": ["戴司", "Daisi"], "阿西姆": ["阿西姆", "Acimu"], "cardoria": ["cardoria", "cardoria"],
    "星吉伦": ["星吉伦", "Xingjilun"], "日翔": ["日翔", "Rixiang"], "王力": ["王力", "WONLY"],
    "慕尼森": ["慕尼森", "Munisen"], "爱国者": ["爱国者", "aigo"], "智门星": ["智门星", "ZhiMenXing"],
    "VOC": ["VOC", "VOC"], "双声": ["双声", "Shuangsheng"], "鹿客": ["鹿客", "Lockin"],
    "苏宁": ["苏宁", "Suning"], "亿联": ["亿联", "Yilian"], "班利浦": ["班利浦", "Banlipu"],
    "艾仕臣": ["艾仕臣", "Aishichen"], "索玛仕": ["索玛仕", "Suomashi"], "方舟鱼": ["方舟鱼", "Fangzhouyu"],
    "小益": ["小益", "Xiaoyi"], "实誉": ["实誉", "Shiyu"], "海尔斯特": ["海尔斯特", "Haierste"],
    "阿尔法极光": ["阿尔法极光", "Alpha Aurora"], "慧锁": ["慧锁", "HSHUISO"], "欧加斯": ["欧加斯", "Oujiasi"],
    "dorlo": ["dorlo", "dorlo"], "fivepears": ["fivepears", "fivepears"], "力利凡": ["力利凡", "Lilifan"],
    "深安捷": ["深安捷", "Shenanjie"], "锁米优品": ["锁米优品", "Suomiyoupin"], "咏洛": ["咏洛", "Yongluo"],
    "石将军": ["石将军", "Shijiangjun"], "今融": ["今融", "Jinrong"], "飞熊": ["飞熊", "Feixiong"],
    "苏宁甄选": ["苏宁甄选", "Suning Pro"], "纳智德": ["纳智德", "Nazhide"],
    // 新增的净水品牌
    "352": ["352"], "3M": ["3M"], "ACEX": ["ACEX", "阿赛克斯"], "BALLY": ["巴俐", "BALLY"], "BKA": ["BKA"],
    "BRITA": ["碧然德", "BRITA"], "BWT": ["倍世", "BWT"], "Buydeem": ["北鼎", "Buydeem"], "Casdon": ["凯度", "Casdon"],
    "Cicot": ["斯科特", "Cicot"], "Corekang": ["科尔康", "Corekang"], "Culligan": ["康丽根", "Culligan"], "Edenpure": ["宜盾普", "Edenpure"],
    "ELKAY": ["艾肯", "ELKAY"], "GOOTHO": ["库硕", "GOOTHO"], "GREE": ["格力", "GREE"], "Hunsdon": ["汉斯顿", "Hunsdon"],
    "Joyoung": ["九阳", "Joyoung"], "LESSO": ["联塑", "LESSO"], "Philips": ["飞利浦", "Philips"], "PUREZA": ["PUREZA"],
    "Reg": ["雷哲", "Reg"], "Rheem": ["瑞美", "Rheem"], "TASOR": ["TASOR"], "Tineco": ["添可", "Tineco"],
    "Tupperware": ["特百惠", "Tupperware"], "Unities": ["有逸", "Unities"], "Wheelton": ["惠尔顿", "Wheelton"], "WISESKY": ["韦思卡尔", "WISESKY"],
    "Wowmom": ["Wowmom"], "Zbei": ["造贝", "Zbei"], "爱贝源": ["爱贝源"], "爱华普": ["爱华普"], "爱惠浦": ["爱惠浦", "Everpure"],
    "安吉尔": ["安吉尔", "Angel"], "安之星": ["安之星"], "邦德莱斯": ["邦德莱斯"], "倍世康": ["倍世康"], "必诺": ["必诺"],
    "碧云泉": ["碧云泉"], "碧云泽": ["碧云泽"], "滨浦丽": ["滨浦丽"], "滨特尔": ["滨特尔", "Pentair"], "博乐宝": ["博乐宝", "BluePro"],
    "博世": ["博世", "Bosch"], "长虹": ["长虹", "Changhong"], "创碧源": ["创碧源"], "道尔顿": ["道尔顿", "Doulton"],
    "德克": ["德克"], "德克西": ["德克西"], "东丽": ["东丽", "TORAY"], "法莱尼": ["法莱尼"], "沣澜": ["沣澜"],
    "戈力思": ["戈力思"], "顾家": ["顾家"], "果麦": ["果麦"], "海士星": ["海士星"], "惠安特": ["惠安特"],
    "霍尼韦尔": ["霍尼韦尔", "Honeywell"], "佳德净": ["佳德净"], "家里泉": ["家里泉"], "金美泉": ["金美泉"], "京倍": ["京倍"],
    "精瑞特": ["精瑞特"], "净恩泉": ["净恩泉"], "净健": ["净健"], "净妙泉": ["净妙泉"], "净派森": ["净派森"],
    "净小能": ["净小能"], "净小新": ["净小新"], "聚蓝": ["聚蓝", "Bluetech"], "康富乐": ["康富乐"], "科勒": ["科勒", "Kohler"],
    "科罗菲": ["科罗菲"], "科琦恩": ["科琦恩"], "可菱水": ["可菱水", "Cleansui"], "蓝宝": ["蓝宝", "BLAUPUNKT"], "乐天鹅": ["乐天鹅"],
    "立升": ["立升", "Litree"], "美菱": ["美菱", "Meiling"], "美息": ["美息", "Vercy"], "三菱": ["三菱", "Mitsubishi"],
    "耐瑞浦": ["耐瑞浦"], "欧德西": ["欧德西"], "普尼客思": ["普尼客思", "poolicos"], "潜水艇": ["潜水艇"], "乔治史帝夫": ["乔治史帝夫"],
    "勤沃": ["勤沃"], "沁园": ["沁园", "Qinyuan"], "泉临门": ["泉临门"], "萨奇": ["萨奇"], "三鼎": ["三鼎"],
    "世韩": ["世韩"], "时代沃顿": ["时代沃顿"], "松下": ["松下", "Panasonic"], "特姆沃尔": ["特姆沃尔"], "恬净": ["恬净", "Tendge"],
    "卫霖": ["卫霖"], "西门子": ["西门子", "Siemens"], "西屋": ["西屋", "Westinghouse"], "夏新": ["夏新", "Amoisonic"],
    "小熊": ["小熊", "Bear"], "小鱼儿": ["小鱼儿"], "小澎": ["小澎"], "新体验": ["新体验"], "信浦": ["信浦", "Xinpu"],
    "氧芬": ["氧芬"], "耀龙泉": ["耀龙泉"], "易开得": ["易开得"], "亿美沁": ["亿美沁"], "益之源": ["益之源"],
    "溢思源": ["溢思源"], "溢泰": ["溢泰"], "怡口": ["怡口", "ECOWATER"], "宜米": ["宜米"], "优倍纯": ["优倍纯"],
    "优品泉": ["优品泉"], "羽燕": ["羽燕"], "豫宁": ["豫宁"], "宅小净": ["宅小净"], "钻芯": ["钻芯"]
};

class WebScraper {
    // [改动] 构造函数增加了 keyword 参数
    constructor(config, brandMap, keyword) {
        this.config = config;
        this.brandMap = brandMap;
        this.keyword = keyword; // [新增] 保存当前任务的关键词
        this.rawScrapedItems = [];
        this.previousDataMap = new Map();
        this.db = null;
    }
    
    randomSleep = (min, max) => {
        const ms = Math.random() * (max - min) + min;
        return new Promise(resolve => setTimeout(resolve, ms));
    };

    // ... 其他辅助方法和数据处理方法保持不变 ...
    parseSales = (text) => {
        if (typeof text !== 'string') return text;
        const numberMatch = text.match(/(\d+(\.\d+)?)/);
        if (!numberMatch) return null;
        let number = parseFloat(numberMatch[0]);
        if (text.includes('万')) number *= 10000;
        return number;
    };
    extractBrand = (text, brandMap) => {
        const lowerText = text.toLowerCase();
        for (const [canonicalBrand, aliases] of Object.entries(brandMap)) {
            for (const alias of aliases) {
                if (lowerText.includes(alias.toLowerCase())) return canonicalBrand;
            }
        }
        return "未识别";
    };
    loadPreviousData() {
        if (!fs.existsSync(this.config.PREVIOUS_DATA_FILE)) {
            console.log(`[提示] 未找到历史数据文件 '${this.config.PREVIOUS_DATA_FILE}'，将作为首次抓取运行。`);
            return;
        }
        try {
            const workbook = XLSX.readFile(this.config.PREVIOUS_DATA_FILE);
            const ws = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(ws);
            jsonData.forEach(item => {
                const id = item['商品ID'] ? String(item['商品ID']) : null;
                if (id) this.previousDataMap.set(id, item);
            });
            console.log(`[成功] 已加载 ${this.previousDataMap.size} 条旧数据用于比对。`);
        } catch (err) {
            console.error(`[错误] 解析历史数据文件 '${this.config.PREVIOUS_DATA_FILE}' 失败。`, err);
        }
    }
    async autoScroll(page) {
        console.log('   -> 自动滚动页面以加载所有商品...');
        await page.evaluate(async (scrollWaitTime) => {
            await new Promise(resolve => {
                let totalHeight = 0;
                const distance = window.innerHeight;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, scrollWaitTime);
            });
        }, this.config.scrollWaitTime);
        console.log('   -> 滚动完成。');
    }
    async scrapeRawPageData(page, pageNum) {
        console.log(`   -> 开始抓取第 ${pageNum} 页的原始数据...`);
        const items = await page.evaluate((pageNum_in_browser) => {
            const extractIdFromUrl = (url) => {
                if (!url) return null;
                let match = url.match(/item\.(taobao|tmall)\.com\/item\.htm.*?[?&]id=(\d+)/) || url.match(/[?&]id=(\d+)/);
                return match ? match[2] || match[1] : null;
            };
            const parseSales = (text) => {
                if (typeof text !== 'string') return text;
                const numberMatch = text.match(/(\d+(\.\d+)?)/);
                if (!numberMatch) return null;
                let number = parseFloat(numberMatch[0]);
                if (text.includes('万')) number *= 10000;
                return number;
            };
            const pageItems = [];
            const productCards = document.querySelectorAll('a.doubleCardWrapperAdapt--mEcC7olq');
            productCards.forEach(card => {
                try {
                    const adIdentifier = card.querySelector('img.mainP4pPic--RlLduUci, img.mainP4pPic--jbnK3QAX');
                    const isAd = !!adIdentifier;
                    const salesText = card.querySelector('.realSales--XZJiepmt')?.innerText || '';
                    const sales = isAd ? null : parseSales(salesText);

                    const productInfo = {
                        '页码': pageNum_in_browser,
                        '商品ID': extractIdFromUrl(card.href),
                        '商品标题': card.querySelector('.title--qJ7Xg_90')?.innerText.trim() || 'N/A',
                        '国补后价格': parseFloat((card.querySelector('.priceInt--yqqZMJ5a')?.innerText || '0') + (card.querySelector('.priceFloat--XpixvyQ1')?.innerText || '')),
                        '店铺名称': card.querySelector('.shopNameText--DmtlsDKm')?.innerText.trim() || 'N/A',
                        '商品链接': card.href,
                        '付款人数': isAd ? salesText : sales,
                        '付款金额': 'N/A',
                        '品牌': 'N/A',
                        '备注': '',
                    };
                    pageItems.push({ isAd: isAd, data: productInfo });
                } catch (e) {
                    console.warn('处理某个商品卡片时出错: ', e, card);
                }
            });
            return pageItems;

        }, pageNum);
        return items;
    }
    processFinalData(rawItems) {
        console.log("   -> 开始数据后处理，应用高级广告逻辑...");
        const organicProductIds = new Set(rawItems.filter(item => !item.isAd).map(item => item.data['商品ID']));
        const finalData = [];

        for (let i = 0; i < rawItems.length; i++) {
            const item = rawItems[i];
            if (!item.isAd) {
                finalData.push(item.data);
                continue;
            }

            if (organicProductIds.has(item.data['商品ID'])) {
                console.log(`     - 广告商品 ${item.data['商品ID']} 已作为正常商品存在，予以剔除。`);
                continue;
            }

            let estimatedSales = 0;
            let remark = '销量为估算值; ';
            if (i === 0) {
                const nextOrganic = rawItems.find(p => !p.isAd && typeof p.data['付款人数'] === 'number');
                if (nextOrganic) {
                    estimatedSales = Math.round(nextOrganic.data['付款人数'] * 1.2);
                }
            } else {
                const prevOrganicSales = rawItems.slice(0, i).reverse().find(p => !p.isAd && typeof p.data['付款人数'] === 'number')?.data['付款人数'];
                const nextOrganicSales = rawItems.slice(i + 1).find(p => !p.isAd && typeof p.data['付款人数'] === 'number')?.data['付款人数'];

                if (prevOrganicSales != null && nextOrganicSales != null) {
                    estimatedSales = Math.round((prevOrganicSales + nextOrganicSales) / 2);
                } else {
                    estimatedSales = prevOrganicSales || nextOrganicSales || 0;
                }
            }
            console.log(`     - 广告商品 ${item.data['商品ID']}，估算销量为: ${estimatedSales}`);
            item.data['付款人数'] = estimatedSales;
            item.data['备注'] += remark;
            finalData.push(item.data);
        }

        finalData.forEach(p => {
            const searchStringForBrand = p['商品标题'] + ' ' + p['店铺名称'];
            p['品牌'] = this.extractBrand(searchStringForBrand, this.brandMap);
            if (typeof p['国补后价格'] === 'number' && typeof p['付款人数'] === 'number') {
                p['付款金额'] = p['国补后价格'] * p['付款人数'];
            }
        });

        return finalData;
    }
    aggregateByBrandAndPrice(data) {
        const groups = new Map();
        data.forEach(product => {
            const sales = typeof product['付款人数'] === 'number' ? product['付款人数'] : 0;
            const amount = typeof product['付款金额'] === 'number' ? product['付款金额'] : 0;
            const groupKey = `${product['品牌']}-${product['国补后价格']}`;

            if (!groups.has(groupKey)) {
                groups.set(groupKey, { totalSales: 0, totalAmount: 0, count: 0, products: [] });
            }
            const groupData = groups.get(groupKey);
            groupData.totalSales += sales;
            groupData.totalAmount += amount;
            groupData.count += 1;
            groupData.products.push(product);
        });

        const aggregatedResult = [];
        for (const groupData of groups.values()) {
            const representativeProduct = groupData.products.reduce((max, p) => (p['付款人数'] > max['付款人数'] ? p : max), groupData.products[0]);

            const finalProduct = { ...representativeProduct };
            finalProduct['付款人数'] = groupData.totalSales;
            finalProduct['付款金额'] = groupData.totalAmount;
            if (groupData.count > 1) {
                finalProduct['备注'] += `合并了${groupData.count}个相似商品; `;
            }
            aggregatedResult.push(finalProduct);
        }
        return aggregatedResult;
    }
    deduplicateById(data) {
        return Array.from(new Map(data.map(p => [p['商品ID'], p])).values());
    }
    mergeWithPreviousData(currentData) {
        currentData.sort((a, b) => (b['付款人数'] || 0) - (a['付款人数'] || 0));
        currentData.forEach((item, index) => {
            item['本次排名'] = index + 1;
        });

        if (this.previousDataMap.size === 0) {
            console.log("无历史数据，将作为首次抓取运行。");
            const today = new Date();
            const dateStr = `${today.getMonth() + 1}-${today.getDate()}`;
            currentData.forEach(item => {
                item['备注'] = '新品; ' + (item['备注'] || '');
                item['最新价格'] = item['国补后价格'];
                item['最新付款人数'] = item['付款人数'];
                item[`${dateStr}_价格`] = item['国补后价格'];
                item[`${dateStr}_付款人数`] = item['付款人数'];
                item['上次排名'] = 'N/A';
                item['排名变化'] = '新品';
            });
            return currentData;
        }

        console.log("开始与最新数据进行比对和合并...");
        const newDataMap = new Map(currentData.map(item => [item['商品ID'], item]));
        const mergedData = [];
        const today = new Date();
        const dateStr = `${today.getMonth() + 1}-${today.getDate()}`;
        const priceDateColumn = `${dateStr}_价格`;
        const salesDateColumn = `${dateStr}_付款人数`;

        for (const [id, oldItem] of this.previousDataMap.entries()) {
            const newItem = newDataMap.get(id);
            const mergedItem = { ...oldItem };

            if (newItem) {
                const lastPrice = parseFloat(oldItem['最新价格'] || oldItem['国补后价格']);
                const lastSales = parseFloat(oldItem['最新付款人数'] || oldItem['付款人数']);
                const newPrice = parseFloat(newItem['国补后价格']);
                const newSales = parseFloat(newItem['付款人数']);
                mergedItem[priceDateColumn] = newPrice !== lastPrice ? newPrice : '同上';
                mergedItem[salesDateColumn] = newSales !== lastSales ? newSales : '同上';
                const lastRank = parseInt(oldItem['本次排名']);
                const currentRank = newItem['本次排名'];
                mergedItem['上次排名'] = isNaN(lastRank) ? 'N/A' : lastRank;
                mergedItem['本次排名'] = currentRank;

                if (isNaN(lastRank)) {
                    mergedItem['排名变化'] = '新品入榜';
                } else {
                    const rankChange = lastRank - currentRank;
                    if (rankChange > 0) mergedItem['排名变化'] = `上涨${rankChange}`;
                    else if (rankChange < 0) mergedItem['排名变化'] = `下降${Math.abs(rankChange)}`;
                    else mergedItem['排名变化'] = '持平';
                }
                mergedItem['最新价格'] = newPrice;
                mergedItem['最新付款人数'] = newSales;
                mergedItem['备注'] = newItem['备注'];
                mergedItem['付款金额'] = newItem['付款金额'];
                newDataMap.delete(id);
            } else {
                mergedItem[priceDateColumn] = '未找到';
                mergedItem[salesDateColumn] = '未找到';
                mergedItem['本次排名'] = 'N/A';
                mergedItem['排名变化'] = '掉榜';
            }
            mergedData.push(mergedItem);
        }

        for (const [id, newItem] of newDataMap.entries()) {
            console.log(` -> 发现新品: ${id}`);
            newItem['备注'] = '新品; ' + (newItem['备注'] || '');
            newItem['最新价格'] = newItem['国补后价格'];
            newItem['最新付款人数'] = newItem['付款人数'];
            newItem[priceDateColumn] = newItem['国补后价格'];
            newItem[salesDateColumn] = newItem['付款人数'];
            newItem['上次排名'] = 'N/A';
            newItem['排名变化'] = '新品';
            mergedData.push(newItem);
        }
        console.log("数据合并完成。");
        return mergedData;
    }

    // --- [新增] 数据格式化模块 ---
    formatFinalData(data) {
        console.log("   -> 格式化数据以满足最终输出要求...");
        const todayStr = new Date().toISOString().split('T')[0];
        const requiredColumns = [
            '日期', '商品ID', '本次排名', '品类', '品牌', '店铺名称',
            '商品链接', '商品标题', '备注', '国补后价格', '付款人数', '付款金额'
        ];

        return data.map(item => {
            const newItem = {
                '日期': todayStr,
                // [改动] 使用 this.keyword 填充品类，而不是写死的配置
                '品类': this.keyword, 
                '商品ID': item['商品ID'],
                '本次排名': item['本次排名'],
                '品牌': item['品牌'],
                '店铺名称': item['店铺名称'],
                '商品链接': item['商品链接'],
                '商品标题': item['商品标题'],
                '备注': item['备注'],
                '国补后价格': item['国补后价格'],
                '付款人数': item['付款人数'],
                '付款金额': item['付款金额'],
            };
            return newItem;
        });
    }

    // --- [更新] 文件保存模块 ---
    saveToExcel(data) {
        if (data.length === 0) {
            console.log('[文件] 没有数据可以保存到Excel。');
            return;
        }
        
        // 确保目录存在
        if (!fs.existsSync(this.config.OUTPUT_DIR_PATH)) {
            fs.mkdirSync(this.config.OUTPUT_DIR_PATH, { recursive: true });
        }
        
        const todayStr = new Date().toISOString().split('T')[0];
        // [改动] 文件名现在根据 this.keyword 动态生成
        const fileName = `Tmall_${this.keyword}_${todayStr}.xlsx`;
        const fullPath = path.join(this.config.OUTPUT_DIR_PATH, fileName);

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Tmall商品数据');

        XLSX.writeFile(workbook, fullPath);
        console.log(`[成功] Excel文件已生成并保存到: ${fullPath}`);
    }

    // --- [新增] 数据库交互模块 ---
    async setupDatabase() {
        return new Promise((resolve, reject) => {
            const dbDir = path.dirname(this.config.DB_PATH);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }
            this.db = new sqlite3.Database(this.config.DB_PATH, (err) => {
                if (err) return reject(err);
                console.log(`[数据库] 成功连接到SQLite数据库: ${this.config.DB_PATH}`);
                
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS Tmarket_price_data (
                        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                        "日期" TEXT,
                        "商品ID" TEXT,
                        "本次排名" INTEGER,
                        "品类" TEXT,
                        "品牌" TEXT,
                        "店铺名称" TEXT,
                        "商品链接" TEXT,
                        "商品标题" TEXT,
                        "备注" TEXT,
                        "国补后价格" REAL,
                        "付款人数" INTEGER,
                        "付款金额" REAL,
                        UNIQUE("日期", "商品ID")
                    )
                `, (err) => {
                    if (err) return reject(err);
                    console.log("[数据库] 'Tmarket_price_data' 表已准备就绪。");
                    resolve();
                });
            });
        });
    }

    async saveToDatabase(data) {
        if (data.length === 0) {
            console.log('[数据库] 没有数据可以写入。');
            return;
        }
        if (!this.db) {
            console.error('[数据库] 数据库未连接，无法写入。');
            return;
        }

        const sql = `
            INSERT INTO Tmarket_price_data (
                "日期", "商品ID", "本次排名", "品类", "品牌", "店铺名称",
                "商品链接", "商品标题", "备注", "国补后价格", "付款人数", "付款金额"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT("日期", "商品ID") DO UPDATE SET
                "本次排名"=excluded."本次排名",
                "品牌"=excluded."品牌",
                "店铺名称"=excluded."店铺名称",
                "商品标题"=excluded."商品标题",
                "备注"=excluded."备注",
                "国补后价格"=excluded."国补后价格",
                "付款人数"=excluded."付款人数",
                "付款金额"=excluded."付款金额"
        `;

        // 使用 Promise 封装 db.run 以便在循环中使用 await
        const runQuery = (record) => {
            return new Promise((resolve, reject) => {
                const params = [
                    record['日期'], record['商品ID'], record['本次排名'], record['品类'], record['品牌'], record['店铺名称'],
                    record['商品链接'], record['商品标题'], record['备注'], record['国补后价格'], record['付款人数'], record['付款金额']
                ];
                this.db.run(sql, params, function(err) {
                    if (err) return reject(err);
                    resolve(this.changes);
                });
            });
        };
        
        let recordsAffected = 0;
        console.log(`[数据库] 准备将 ${data.length} 条记录写入或更新到数据库...`);
        for (const record of data) {
            try {
                const changes = await runQuery(record);
                if (changes > 0) recordsAffected++;
            } catch (err) {
                console.error(`[数据库] 写入失败: ${err.message}`, record);
            }
        }
        console.log(`[数据库] 操作完成，共新增或更新了 ${recordsAffected} 条记录。`);
    }

    async closeDatabase() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) return reject(err);
                    console.log('[数据库] 数据库连接已关闭。');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }


    async run() {
        // [改动] 日志输出当前正在处理的关键词
        console.log(`\n\n--- 爬虫任务启动: [${this.keyword}] (v2.3) ---`);

        if (!fs.existsSync(this.config.AUTH_FILE_PATH)) {
            console.error(`[致命错误] 登录文件 ${this.config.AUTH_FILE_PATH} 未找到！脚本终止。`);
            return;
        }

        await this.setupDatabase(); // 在所有操作前准备好数据库
        this.loadPreviousData();

        const browser = await chromium.launch({ headless: this.config.isHeadless });
        const context = await browser.newContext({ storageState: this.config.AUTH_FILE_PATH });
        const page = await context.newPage();
        page.setDefaultTimeout(this.config.pageLoadTimeout);
        page.setDefaultNavigationTimeout(this.config.navigationTimeout);

        try {
            // [改动] 使用 this.keyword 来构建搜索URL
            const encodedKeyword = encodeURIComponent(this.keyword);
            const searchUrl = `https://s.taobao.com/search?page=1&q=${encodedKeyword}&tab=all`;
            
            console.log(`[1/4] 导航到搜索页: ${searchUrl}`);
            await page.goto(searchUrl, { waitUntil: 'load' });
            console.log("   -> 页面加载完成。");

            console.log("[2/4] 按指令进行筛选和排序 (人性化模拟)...");
            
            const tmallTab = page.getByText('天猫', { exact: true });
            await tmallTab.hover();
            await this.randomSleep(300, 800);
            await tmallTab.click();
            console.log("   -> 已点击【天猫】进行筛选。");
            await this.randomSleep(1500, 2500);

            const salesTab = page.getByRole('tab', { name: '销量' });
            await salesTab.hover(); 
            await this.randomSleep(400, 900);
            await salesTab.click();
            console.log("   -> 已点击【销量】进行排序。");
            
            await expect(salesTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
            console.log("   -> 销量排序结果已加载。准备开始抓取...");

            let currentPage = 1;
            while (true) {
                if (this.config.maxPagesToScrape > 0 && currentPage > this.config.maxPagesToScrape) {
                    console.log(`已达到设定的最大页数 (${this.config.maxPagesToScrape})，任务终止。`);
                    break;
                }
                console.log(`\n- 正在处理第 ${currentPage} 页...`);

                await this.autoScroll(page);
                const pageItems = await this.scrapeRawPageData(page, currentPage);

                if (pageItems.length === 0) {
                    console.warn(`   -> 警告：在第 ${currentPage} 页没有抓取到任何商品项。页面可能未正常加载或结构已改变。`);
                } else {
                    this.rawScrapedItems.push(...pageItems);
                    console.log(`   > 本页成功记录 ${pageItems.length} 条原始项目。`);
                }

                const organicProducts = pageItems.filter(p => !p.isAd && typeof p.data['付款人数'] === 'number');
                if (pageItems.length > 0 && this.config.stopSalesCount > 0 && organicProducts.some(p => p.data['付款人数'] <= this.config.stopSalesCount)) {
                    console.log(`[触发熔断] 检测到销量低于或等于 ${this.config.stopSalesCount} 的商品，停止翻页。`);
                    break;
                }

                const nextPageButton = page.locator('button:has-text("下一页")');
                if (await nextPageButton.count() === 0 || await nextPageButton.isDisabled()) {
                    console.log('[任务结束] 找不到“下一页”按钮或按钮已禁用，爬取结束。');
                    break;
                }
                
                await nextPageButton.hover();
                await this.randomSleep(500, 1000);
                await nextPageButton.click();
                
                const nextpageNumStr = (currentPage + 1).toString();
                console.log(`   -> 点击下一页，等待第 ${nextpageNumStr} 页加载...`);
                await page.waitForSelector(`button.next-current:has-text("${nextpageNumStr}")`, { timeout: 15000 });
                console.log(`   -> 第 ${nextpageNumStr} 页加载成功。`);
                currentPage++;
            }

        } catch (err) {
            console.error(`❌ [${this.keyword}] 任务主流程发生严重错误:`, err);
        } finally {
            console.log(`\n[4/4] 抓取流程结束，正在关闭浏览器...`);
            await browser.close();
        }

        console.log(`\n--- ✅ [${this.keyword}] 数据后处理与保存 ---`);
        console.log(`总共抓取到 ${this.rawScrapedItems.length} 条原始项目。`);

        let processedData = this.processFinalData(this.rawScrapedItems);
        processedData = processedData.filter(p => p['国补后价格'] >= this.config.minPriceFilter);
        console.log(`应用价格筛选后剩余 ${processedData.length} 条。`);

        let aggregatedData = this.config.shouldAggregateData
            ? this.aggregateByBrandAndPrice(processedData)
            : this.deduplicateById(processedData);

        let finalData = this.mergeWithPreviousData(aggregatedData);
        finalData.sort((a, b) => (a['本次排名'] || Infinity) - (b['本次排名'] || Infinity));

        // [新增] 格式化数据并保存
        const formattedData = this.formatFinalData(finalData);
        if (formattedData.length > 0) {
            this.saveToExcel(formattedData);
            await this.saveToDatabase(formattedData);
        } else {
            console.log("[提示] 最终没有符合条件的数据可供保存。");
        }
        
        await this.closeDatabase();
        console.log(`🎉🎉🎉 [${this.keyword}] 任务完成！ 🎉🎉🎉`);
    }
}

// --- [改动] 脚本入口：重构为循环执行多任务 ---
(async () => {
    console.log("--- 批量爬取脚本启动 (v2.3) ---");
    const keywordsToScrape = CONFIG.SEARCH_KEYWORDS;
    
    if (!keywordsToScrape || keywordsToScrape.length === 0) {
        console.error("错误：请在 CONFIG.SEARCH_KEYWORDS 数组中至少配置一个关键词。");
        return;
    }
    
    console.log(`计划任务: 将按顺序爬取 ${keywordsToScrape.length} 个关键词: [${keywordsToScrape.join(', ')}]`);

    // 使用 for...of 循环确保任务按顺序依次执行
    for (const keyword of keywordsToScrape) {
        try {
            // 为每个关键词创建一个新的、干净的爬虫实例
            const scraper = new WebScraper(CONFIG, BRAND_LIBRARY, keyword);
            await scraper.run();
        } catch (err) {
            console.error(`❌ 在处理关键词 [${keyword}] 时发生致命错误，跳过此任务:`, err);
        }
    }
    
    console.log("\n\n--- 所有关键词任务均已执行完毕 ---");
})();