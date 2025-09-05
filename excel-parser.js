// excel-parser.js
const xlsx = require('xlsx');

/**
 * 通用数据清洗和转换函数
 * @param {object[]} rawData 从Excel直接导出的原始JSON数组
 * @param {object} config 对应文件类型的转换配置
 */
function transformData(rawData, config) {
    if (!config || rawData.length === 0) return rawData;
    
    const { rename = {}, numericColumns = [], custom } = config;

    const toNumeric = (val) => {
        if (val === null || val === undefined || val === "-") return null;
        const num = parseFloat(String(val).replace(/,/g, ''));
        return isNaN(num) ? null : num;
    };
    
    // 准备一个ID列清单，用于将数字ID转为字符串，防止精度丢失
    const idColumns = ['商品ID', '主商品ID'];

    return rawData.map(rawRow => {
        let processedRow = {};

        // 1. 清理列名中的空格
        for (const key in rawRow) {
            processedRow[key.trim()] = rawRow[key];
        }

        // 2. 字段重命名
        for (const oldName in rename) {
            if (processedRow.hasOwnProperty(oldName)) {
                processedRow[rename[oldName]] = processedRow[oldName];
                delete processedRow[oldName];
            }
        }
        
        // 3. 将ID列强制转换为字符串
        idColumns.forEach(colName => {
            if (processedRow.hasOwnProperty(colName) && typeof processedRow[colName] === 'number') {
                processedRow[colName] = String(processedRow[colName]);
            }
        });

        // 4. 将指定的列转换为数值类型
        numericColumns.forEach(col => {
            if (processedRow.hasOwnProperty(col)) {
                processedRow[col] = toNumeric(processedRow[col]);
            }
        });

        // 5. 执行自定义的转换逻辑（如计算派生列）
        if (typeof custom === 'function') {
            processedRow = custom(processedRow);
        }

        // 6. 统一处理日期列，确保为 YYYY-MM-DD 格式
        //    我们信任 xlsx 的 dateNF 选项，这里主要是做最后的格式保障
        const dateColumn = processedRow['统计日期'] ? '统计日期' : '日期';
        if (processedRow[dateColumn]) {
             // 假设 dateNF 已经处理好，如果仍需处理，可在此添加逻辑
             if (typeof processedRow[dateColumn] === 'string') {
                processedRow[dateColumn] = processedRow[dateColumn].substring(0, 10);
             }
        }
        
        return processedRow;
    });
}


/**
 * 解析Excel文件
 * @param {string} filePath 文件路径
 * @param {object} [options={}] 解析选项
 * @returns {object[]} 解析并清理后的JSON数据数组
 */
function parseExcel(filePath, options = {}) {
    try {
        const workbook = xlsx.readFile(filePath, { codepage: 936 }); // 默认使用GBK编码读取
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // 在解析为JSON前，执行预处理钩子 (例如修复'主体ID'问题)
        if (typeof options.beforeParse === 'function') {
            options.beforeParse(worksheet);
        }

        const jsonOptions = {
            raw: false,
            dateNF: 'yyyy-mm-dd', // ⭐ 核心：将所有日期格式化
            range: options.range,
        };

        let rawData = xlsx.utils.sheet_to_json(worksheet, jsonOptions);

        return transformData(rawData, options.transformations);

    } catch (error) {
        console.error(`Error parsing Excel file ${filePath}:`, error);
        throw error; // 将错误向上抛出，由主流程捕获
    }
}

module.exports = { parseExcel };