const categoryMapping = require('./category_mapping.json');

/**
 * 核心转换引擎：将京东的脏数据转化为拼多多的标准数据
 */
function translateJdToPdd(jdData, categoryName) {
    const rules = categoryMapping[categoryName];
    if (!rules) {
        console.log(`⚠️ 字典中未找到【${categoryName}】的映射规则，跳过转换。`);
        return {};
    }

    let pddData = {};

    jdData.forEach(jdItem => {
        const jdKey = jdItem.labelName || '';
        const jdVal = jdItem.labelValue || '';

        // 1. 处理一对一映射
        for (const rule of rules.direct_mapping) {
            if (rule.jd_keywords.some(keyword => jdKey.includes(keyword))) {
                
                if (rule.action === 'extract_number') {
                    // 提取纯数字 (含小数点)
                    const match = jdVal.match(/[\d\.]+/);
                    if (match) pddData[rule.pdd_key] = match[0];
                } 
                else if (rule.action === 'replace') {
                    // 替换多余文字
                    let cleanVal = jdVal;
                    for (const [badWord, goodWord] of Object.entries(rule.replace_rule)) {
                        cleanVal = cleanVal.replace(badWord, goodWord);
                    }
                    pddData[rule.pdd_key] = cleanVal;
                } 
                else {
                    // direct：原样照搬
                    pddData[rule.pdd_key] = jdVal;
                }
                break; 
            }
        }

        // 2. 处理尺寸拆分的复合映射
        if (rules.complex_mapping && rules.complex_mapping.dimensions) {
            const dimRule = rules.complex_mapping.dimensions;
            if (jdKey.includes(dimRule.jd_keyword)) {
                // 利用正则匹配 "长897mm 宽375mm 高645mm"
                const lengthMatch = jdVal.match(/长(\d+)/);
                const widthMatch = jdVal.match(/宽(\d+)/);
                const heightMatch = jdVal.match(/高(\d+)/);

                if (lengthMatch && dimRule.pdd_keys["长"]) pddData[dimRule.pdd_keys["长"]] = lengthMatch[1];
                if (widthMatch && dimRule.pdd_keys["宽"]) pddData[dimRule.pdd_keys["宽"]] = widthMatch[1];
                if (heightMatch && dimRule.pdd_keys["高"]) pddData[dimRule.pdd_keys["高"]] = heightMatch[1];
            }
        }
    });

    return pddData;
}

// ==========================================
// 模拟从京东抓取到的原始数据（直接抄自你的截图）
// ==========================================
const mockJdData = [
    {"labelName": "品牌", "labelValue": "云米 (VIOMI)"},
    {"labelName": "能效网规格型号", "labelValue": "CXW-180-VK807"},
    {"labelName": "半消声室噪声", "labelValue": "53.5dB(A)"},
    {"labelName": "爆炒风量(短时升速)", "labelValue": "28m³/min"},
    {"labelName": "烟机面板材质", "labelValue": "钢化玻璃"},
    {"labelName": "能效等级", "labelValue": "一级能效"},
    {"labelName": "烟机外机尺寸", "labelValue": "长897mm 宽375mm 高645mm"},
    {"labelName": "出风口径", "labelValue": "180mm"} // 这个字段拼多多不需要，用来测试引擎会不会自动过滤它
];

console.log("⚙️ [数据清洗引擎] 启动...");
console.log("📥 原始京东数据 (带各种恶心单位和不需要的字段) :");
console.log(mockJdData);

const finalPddData = translateJdToPdd(mockJdData, "油烟机");

console.log("\n===========================================");
console.log("✨ [清洗完毕] 准备喂给 UI 填表引擎的极简 JSON：");
console.log(finalPddData);
console.log("===========================================\n");