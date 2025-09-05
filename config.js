// config.js
// 这是你的应用“大脑”，所有文件处理规则都在这里定义。
// 未来新增报表，主要就是在这里添加一个新的配置对象。

const path = require('path');
const xlsx = require('xlsx'); 
const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
const REFERENCE_TABLE_PATH = 'Z:/天猫生意参谋/天猫商品对照表.xlsx';

const fileProcessingRules = {
    "商品报表_": {
        destination: "Z:/天猫生意参谋/推广_商品数据",
        tableName: "推广 商品数据",
        isCentral: true, // 这个文件的数据要合并到中央数据库
        primaryKeys: ["统计日期", "商品ID"],
        // Excel解析阶段的特殊选项
        parserOptions: {
            // 针对性的修复'主体ID'科学计数法问题
            beforeParse: (worksheet) => {
                const range = xlsx.utils.decode_range(worksheet['!ref']);
                let idColumnIndex = -1;
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cell = worksheet[xlsx.utils.encode_cell({c: C, r: range.s.r})];
                    if (cell && cell.v && String(cell.v).trim() === '主体ID') {
                        idColumnIndex = C;
                        break;
                    }
                }
                if (idColumnIndex > -1) {
                    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                        const cellRef = xlsx.utils.encode_cell({c: idColumnIndex, r: R});
                        const cell = worksheet[cellRef];
                        if (cell && cell.t === 'n') {
                            cell.t = 's';
                            cell.v = String(cell.v);
                            delete cell.w;
                        }
                    }
                }
            }
        },
        // 数据转换阶段的规则
        transformations: {
            // 字段重命名
            rename: {
                '主体ID': '商品ID',
                '日期': '统计日期',
            },
            // 定义哪些列需要转换为数值类型
            numericColumns: ["点击量", "花费", "总成交金额", "总成交笔数", "投入产出比", "总收藏加购成本", "总成交成本", "宝贝收藏成本", "宝贝收藏加购成本"],
            // 自定义转换函数，用于处理更复杂的逻辑
            custom: (row) => {
                // 这里可以添加更多自定义的数据处理逻辑
                return row;
            }
        }
    },
    "【生意参谋平台】商品_全部_": {
        destination: "Z:/天猫生意参谋/商品_商品排行",
        tableName: "生意参谋平台 商品 全部",
        isCentral: true,
        primaryKeys: ["统计日期", "商品ID"],
        parserOptions: {
            range: 4 // 从第5行开始读取
        },
        transformations: {
            rename: {},
            numericColumns: ["商品访客数", "商品浏览量", "平均停留时长", "商品详情页跳出率", "商品收藏人数", "商品加购件数", "商品加购人数", "下单买家数", "下单件数", "下单金额", "下单转化率", "支付买家数", "支付件数", "支付金额", "商品支付转化率", "支付新买家数", "支付老买家数", "老买家支付金额", "聚划算支付金额", "访客平均价值", "成功退款金额", "竞争力评分", "搜索引导访客数", "搜索引导支付买家数", "实付金额", "支付单价"],
            // 计算派生列
            custom: (row) => {
                const paidAmount = row['支付金额'];
                const refundAmount = row['成功退款金额'];
                const paidItems = row['支付件数'];

                row['实付金额'] = (paidAmount !== null && refundAmount !== null) ? paidAmount - refundAmount : null;
                row['支付单价'] = (paidAmount !== null && paidItems !== null && paidItems > 0) ? paidAmount / paidItems : null;

                return row;
            }
        }
    },
    "products_": {
        destination: "Z:/平台价格监控/Results",
        tableName: "products",
        isCentral: false, // 这个文件数据存在各自文件夹的独立数据库中
        // 主键由文件的前三列动态决定
        getPrimaryKeys: (headers) => {
            if (headers.length >= 8) {
                return [headers[0], headers[1], headers[7]];
            }
            // 容错处理
            return [headers[0]];
        },
        parserOptions: {},
        transformations: {
            rename: {},
            numericColumns: [], // 假设这个文件没有需要特殊处理的数字列
            custom: (row) => row
        }
    }
};

// 将配置和常量导出
module.exports = {
    CENTRAL_DB_PATH,
    REFERENCE_TABLE_PATH,
    fileProcessingRules,
    DESTINATION_MAP: Object.keys(fileProcessingRules).reduce((map, key) => {
        map[key] = fileProcessingRules[key].destination;
        return map;
    }, {})
};