// main.js (主进程)
// 负责所有后台文件处理、数据库操作，并与渲染进程通信以更新进度条。
//
// --- v21 版本更新日志 ---
// 1. [彻底修复] 引入智能数据类型。脚本现在会为数据库的每一列设置最合适的类型（数字列为REAL，其他为TEXT），
//    彻底解决了数值被存为文本，导致在Excel中无法直接计算的问题。

const { app, dialog, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');
const { createExtractorFromFile } = require('node-unrar-js');
const os = require('os');
const Database = require('better-sqlite3');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 600,
        height: 400,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });
    mainWindow.loadFile('index.html');
    // mainWindow.webContents.openDevTools(); // 取消注释以进行调试
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- 核心业务逻辑 ---

const DESTINATION_MAP = {
    "商品报表_": "Z:/天猫生意参谋/推广_商品数据",
    "【生意参谋平台】商品_全部_": "Z:/天猫生意参谋/商品_商品排行",
    "products_": "Z:/平台价格监控/Results",
};

const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
const REFERENCE_TABLE_PATH = 'Z:/天猫生意参谋/天猫商品对照表.xlsx'; // 新增：商品对照表路径
const MERGE_INTO_CENTRAL_DB = new Set([
    "商品报表_",
    "【生意参谋平台】商品_全部_"
]);

// 定义需要转换为数字的列，完全参照您的Power Query脚本
const sycmNumericColumns = ["商品访客数", "商品浏览量", "平均停留时长", "商品详情页跳出率", "商品收藏人数", "商品加购件数", "商品加购人数", "下单买家数", "下单件数", "下单金额", "下单转化率", "支付买家数", "支付件数", "支付金额", "商品支付转化率", "支付新买家数", "支付老买家数", "老买家支付金额", "聚划算支付金额", "访客平均价值", "成功退款金额", "竞争力评分", "搜索引导访客数", "搜索引导支付买家数", "实付金额", "支付单价"];
const promoNumericColumns = ["点击量", "花费", "总成交金额", "总成交笔数", "投入产出比", "总收藏加购成本", "总成交成本", "宝贝收藏成本", "宝贝收藏加购成本"];


class FileProcessor {
    saveToDatabase(xlsxPath, targetFolder, tableName, fileKey, logTarget) {
        let dbPath;
        let dbName;

        if (MERGE_INTO_CENTRAL_DB.has(fileKey)) {
            dbPath = CENTRAL_DB_PATH;
            dbName = path.basename(CENTRAL_DB_PATH);
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        } else {
            dbName = path.basename(targetFolder) + '.db';
            dbPath = path.join(targetFolder, dbName);
        }

        let db;
        try {
            db = new Database(dbPath);
            
            // 读取文件时不再需要 cellDates: true 这个选项
            const workbook = xlsx.readFile(xlsxPath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            // --- ⭐ 问题修复开始 ---
            // 在转换为JSON之前，强制将"商品报表"的"主体ID"列视为文本，以防止科学计数法问题。
            // 这个问题只影响"商品报表_"，所以我们只对它进行特殊处理。
            if (fileKey === "商品报表_") {
                const range = xlsx.utils.decode_range(worksheet['!ref']);
                let idColumnIndex = -1;

                // 1. 动态查找 "主体ID" 所在的列索引 (C)
                //    我们假定表头在第一行 (range.s.r)
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellRef = xlsx.utils.encode_cell({c: C, r: range.s.r});
                    const cell = worksheet[cellRef];
                    if (cell && cell.v && String(cell.v).trim() === '主体ID') {
                        idColumnIndex = C;
                        break;
                    }
                }

                // 2. 如果找到了该列，则遍历并修改该列所有数字单元格的类型
                if (idColumnIndex > -1) {
                    // 从表头的下一行开始遍历 (range.s.r + 1)
                    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                        const cellRef = xlsx.utils.encode_cell({c: idColumnIndex, r: R});
                        const cell = worksheet[cellRef];
                        
                        // 如果单元格存在且类型为数字 ('n')
                        if (cell && cell.t === 'n') {
                            cell.t = 's'; // 将单元格类型强制更改为字符串 ('s')
                            cell.v = String(cell.v); // **至关重要**: 同时将单元格的值也转换为字符串
                            
                            // 删除 .w 属性 (格式化文本)，这样 sheet_to_json 会直接使用我们修改后的 .v 值
                            delete cell.w; 
                        }
                    }
                }
            }
            // 在将工作表转换为JSON时，使用 dateNF 选项强制格式化日期为字符串
            const jsonOptions = { 
                raw: false, // raw: false 确保格式化生效
                dateNF: 'yyyy-mm-dd' // ⭐ 核心：将所有日期单元格转换为 'YYYY-MM-DD' 格式的字符串
            }; 
            
            if (fileKey === "【生意参谋平台】商品_全部_") {
                jsonOptions.range = 4;
            }
            // 此时，rawData 中所有日期都已经是 'YYYY-MM-DD' 格式的字符串了
            let rawData = xlsx.utils.sheet_to_json(worksheet, jsonOptions);

            // --- ⭐ 关键改动结束 ---

            if (rawData.length === 0) {
                logTarget.push({ file: path.basename(xlsxPath), status: 'Skipped' });
                return;
            }

            // 完整替换旧的 formatDate 函数
            const formatDate = (dateInput) => {
                // 处理 null 或 undefined 的情况
                if (dateInput === null || dateInput === undefined) {
                    return null;
                }
            
                // 1. 处理 Excel 的数字日期格式 (此部分本身是安全的)
                if (typeof dateInput === 'number') {
                    const dateParts = xlsx.SSF.parse_date_code(dateInput);
                    if (dateParts && dateParts.y && dateParts.m && dateParts.d) {
                        const year = dateParts.y;
                        const month = String(dateParts.m).padStart(2, '0');
                        const day = String(dateParts.d).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    }
                }
            
                // 2. 处理已经是 "YYYY-MM-DD" 格式的字符串 (此部分是安全的)
                if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)) {
                    return dateInput.substring(0, 10);
                }
            
                // 3. 处理 JavaScript 的 Date 对象 (这是修正后的安全版本)
                if (dateInput instanceof Date && !isNaN(dateInput)) {
                    const year = dateInput.getUTCFullYear(); // 使用 UTC 年份
                    const month = String(dateInput.getUTCMonth() + 1).padStart(2, '0'); // 使用 UTC 月份 (月份从0开始，所以要+1)
                    const day = String(dateInput.getUTCDate()).padStart(2, '0'); // 使用 UTC 日期
                    return `${year}-${month}-${day}`;
                }
            
                // 如果以上都不是，返回原始输入
                return dateInput;
            };
            
            const processedData = rawData.map(rawRow => {
                const cleanRow = {};
                for (const key in rawRow) {
                    cleanRow[key.trim()] = rawRow[key];
                }

                const finalRow = {};
                
                for (const key in cleanRow) {
                    if (key !== '主体ID' && key !== '日期') {
                        finalRow[key] = cleanRow[key];
                    }
                }

                if (fileKey === "商品报表_") {
                    finalRow['商品ID'] = cleanRow['主体ID'];
                    finalRow['统计日期'] = cleanRow['日期'];
                }

                if (finalRow['统计日期']) {
                    finalRow['统计日期'] = formatDate(finalRow['统计日期']);
                }

                const idColumns = ['商品ID', '主商品ID'];
                idColumns.forEach(colName => {
                    if (finalRow.hasOwnProperty(colName) && typeof finalRow[colName] === 'number') {
                        try {
                            finalRow[colName] = BigInt(finalRow[colName]).toString();
                        } catch (e) {
                            finalRow[colName] = String(finalRow[colName]);
                        }
                    }
                });

                const toNumeric = (val) => {
                    if (val === null || val === undefined || val === "-") return null;
                    const num = parseFloat(String(val).replace(/,/g, ''));
                    return isNaN(num) ? null : num;
                };

                if (fileKey === "【生意参谋平台】商品_全部_") {
                    sycmNumericColumns.forEach(col => {
                        if (finalRow.hasOwnProperty(col)) finalRow[col] = toNumeric(finalRow[col]);
                    });
                } else if (fileKey === "商品报表_") {
                     promoNumericColumns.forEach(col => {
                        if (finalRow.hasOwnProperty(col)) finalRow[col] = toNumeric(finalRow[col]);
                    });
                }
                
                if (fileKey === "【生意参谋平台】商品_全部_") {
                    const paidAmount = finalRow['支付金额'];
                    const refundAmount = finalRow['成功退款金额'];
                    finalRow['实付金额'] = (paidAmount !== null && refundAmount !== null) ? paidAmount - refundAmount : null;

                    const paidItems = finalRow['支付件数'];
                    finalRow['支付单价'] = (paidAmount !== null && paidItems !== null && paidItems > 0) ? paidAmount / paidItems : null;
                }

                return finalRow;
            });

            const currentFileHeaders = Object.keys(processedData[0]);
            const sanitizedHeaders = currentFileHeaders.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
            
            let primaryKeys;
            if (fileKey === "【生意参谋平台】商品_全部_" || fileKey === "商品报表_") {
                const pk1 = '统计日期'.replace(/[\s\.\-\/\\()]/g, '_');
                const pk2 = '商品ID'.replace(/[\s\.\-\/\\()]/g, '_');
                primaryKeys = [pk1, pk2];
            
            } else if (fileKey === "products_") { // <--- 步骤 1: 在这里添加新的条件
    
                // 确保文件至少有两列，这是一个安全的做法
                if (sanitizedHeaders.length >= 2) {
                    const pk1 = sanitizedHeaders[0]; // 获取清理后的第一列名
                    const pk2 = sanitizedHeaders[1]; // 获取清理后的第二列名
                    const pk3 = sanitizedHeaders[5]; // 获取清理后的第二列名
                    primaryKeys = [pk1, pk2, pk3];       // <--- 步骤 2: 将它们设置为联合主键
                } else {
                    // 如果文件列数少于2，则记录一个错误，并回退到默认的单主键行为，防止程序崩溃
                    this.log.errors.push({ filename: path.basename(xlsxPath), error: `文件列数不足，无法创建联合主键。` });
                    primaryKeys = [sanitizedHeaders[0]];
                } 

            } else {
                 primaryKeys = [sanitizedHeaders[0]];
            }

            // --- v19: 智能判断列类型 ---
            const getColumnType = (header) => {
                const numericList = (fileKey === "【生意参谋平台】商品_全部_") ? sycmNumericColumns : promoNumericColumns;
                return numericList.includes(header) ? 'REAL' : 'TEXT';
            };

            const existingColumns = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(col => col.name);

            if (existingColumns.length === 0) {
                db.exec(`
                    CREATE TABLE "${tableName}" (
                        ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                        PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                    );
                `);
            } else {
                const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
                if (newHeaders.length > 0) {
                    db.transaction(() => {
                        for (const header of newHeaders) {
                            db.prepare(`ALTER TABLE "${tableName}" ADD COLUMN "${header.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(header)}`).run();
                        }
                    })();
                }
            }

            const finalTableColumns = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(col => col.name);
            const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
            const insertQuery = `
                INSERT INTO "${tableName}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
                VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
                ON CONFLICT(${primaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
                ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
            `;
            const insertStmt = db.prepare(insertQuery);

            db.transaction((rows) => {
                for (const row of rows) {
                    const dataToInsert = {};
                    const sanitizedCurrentRow = {};
                    for(const key in row) {
                        sanitizedCurrentRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key];
                    }

                    for (const tableCol of finalTableColumns) {
                        dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                    }
                    insertStmt.run(dataToInsert);
                }
            })(processedData);
            
            logTarget.push({ file: path.basename(xlsxPath), status: 'Success' });

        } catch (e) {
            this.log.errors.push({ filename: path.basename(xlsxPath), error: `数据库操作失败: ${e.message}` });
        } finally {
            if (db) db.close();
        }
    }
    // --- 新增：同步商品对照表的方法 ---
    syncReferenceTable() {
        if (!fs.existsSync(REFERENCE_TABLE_PATH)) {
            return; // 如果对照表不存在，则静默跳过
        }
        this.updateProgress(`同步商品对照表...`);
        let db;
        try {
            db = new Database(CENTRAL_DB_PATH);
            const workbook = xlsx.readFile(REFERENCE_TABLE_PATH);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { raw: true });

            if (data.length === 0) return;

            // 清理并准备数据
            const processedData = data.map(row => {
                const cleanRow = {};
                for (const key in row) {
                    const cleanKey = key.trim();
                    cleanRow[cleanKey] = row[key];
                }
                if (cleanRow['商品ID']) {
                    cleanRow['商品ID'] = String(cleanRow['商品ID']).replace(/\s/g, '');
                }
                return cleanRow;
            });

            const headers = Object.keys(processedData[0]);
            const sanitizedHeaders = headers.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
            const primaryKey = sanitizedHeaders[0]; // 假设对照表的第一列（商品ID）是主键
            const tableName = "商品对照表";

            // 直接删除旧表，插入新表，确保对照表总是最新的
            db.exec(`DROP TABLE IF EXISTS "${tableName}";`);
            db.exec(`
                CREATE TABLE "${tableName}" (
                    ${sanitizedHeaders.map(h => `"${h}" TEXT`).join(', ')},
                    PRIMARY KEY ("${primaryKey}")
                );
            `);

            const insert = db.prepare(`
                INSERT INTO "${tableName}" (${sanitizedHeaders.map(h => `"${h}"`).join(', ')})
                VALUES (${sanitizedHeaders.map(h => `@${h}`).join(', ')});
            `);

            db.transaction((rows) => {
                for (const row of rows) {
                    const sanitizedRow = {};
                    for (const key in row) {
                        sanitizedRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key] !== null && row[key] !== undefined ? String(row[key]) : null;
                    }
                    insert.run(sanitizedRow);
                }
            })(processedData);

        } catch (e) {
            this.log.errors.push({ filename: '天猫商品对照表.xlsx', error: `同步失败: ${e.message}` });
        } finally {
            if (db) db.close();
        }
    }

    constructor() {
        this.log = {
            fileOperations: [],
            dbSyncFromUserFiles: [],
            dbSyncFromFolderScan: [],
            unmatched: [],
            errors: []
        };
        this.totalFiles = 0;
        this.processedFiles = 0;
    }

    updateProgress(message) {
        this.processedFiles++;
        // 增加一个判断，避免在同步对照表时除以0
        if (this.totalFiles > 0) {
            const progress = Math.round((this.processedFiles / this.totalFiles) * 100);
            mainWindow.webContents.send('progress-update', { progress, message });
        } else {
             mainWindow.webContents.send('progress-update', { progress: 100, message });
        }
    }
    updateProgress(message) {
        this.processedFiles++;
        const progress = Math.round((this.processedFiles / this.totalFiles) * 100);
        mainWindow.webContents.send('progress-update', { progress, message });
    }

    scanAndSyncFolders(filesToScan) {
        for (const file of filesToScan) {
            const { fullPath, folderPath, fileKey, tableName } = file;
            this.updateProgress(`巡检同步: ${path.basename(fullPath)}`);
            this.saveToDatabase(fullPath, folderPath, tableName, fileKey, this.log.dbSyncFromFolderScan);
        }
    }

    processFile(filePath) {
        const originalFilename = path.basename(filePath);
        this.updateProgress(`处理新文件: ${originalFilename}`);
        try {
            let targetFolder = null;
            let fileKey = null;
            for (const key in DESTINATION_MAP) {
                if (originalFilename.includes(key)) {
                    targetFolder = DESTINATION_MAP[key];
                    fileKey = key;
                    break;
                }
            }
            if (!targetFolder) {
                this.log.unmatched.push(originalFilename);
                return;
            }
            fs.mkdirSync(targetFolder, { recursive: true });
            const newFilename = path.basename(originalFilename, path.extname(originalFilename)) + '.xlsx';
            const destinationPath = path.join(targetFolder, newFilename);

            if (path.extname(filePath).toLowerCase() !== '.xlsx') {
                const readOptions = {  };
                if (fileKey === "商品报表_") {
                    readOptions.codepage = 936;
                }
                const workbook = xlsx.readFile(filePath, readOptions);
                xlsx.writeFile(workbook, destinationPath);
                if (!filePath.startsWith(os.tmpdir())) fs.unlinkSync(filePath);
            } else {
                fs.renameSync(filePath, destinationPath);
            }
            this.log.fileOperations.push({ original: originalFilename });
            const tableName = fileKey.replace(/【|】|-/g, '').replace(/_/g, ' ').trim();
            this.saveToDatabase(destinationPath, targetFolder, tableName, fileKey, this.log.dbSyncFromUserFiles);
        } catch (e) {
            this.log.errors.push({ filename: originalFilename, error: e.message });
        }
    }

    async run(userChoice) {
        let userSelectedFiles = [];
        let folderScanFiles = [];

        if (userChoice === 0) {
            const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
            if (!canceled && filePaths.length > 0) {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-proc-'));
                for (const filePath of filePaths) {
                    // 实际应处理解压
                    userSelectedFiles.push(filePath); 
                }
            }
        }
        
        for (const [fileKey, folderPath] of Object.entries(DESTINATION_MAP)) {
            if (fs.existsSync(folderPath)) {
                const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.xlsx'));
                files.forEach(f => folderScanFiles.push({
                    fullPath: path.join(folderPath, f),
                    folderPath,
                    fileKey,
                    tableName: fileKey.replace(/【|】|-/g, '').replace(/_/g, ' ').trim()
                }));
            }
        }

        this.totalFiles = userSelectedFiles.length + folderScanFiles.length;
        this.processedFiles = 0;
        
        // --- 变更：在所有操作之前，先同步对照表 ---
this.syncReferenceTable();

        if (this.totalFiles === 0) {
            mainWindow.webContents.send('processing-complete', this.log);
            return;
        }

        userSelectedFiles.forEach(file => this.processFile(file));
        this.scanAndSyncFolders(folderScanFiles);

        mainWindow.webContents.send('processing-complete', this.log);
    }
}

ipcMain.on('start-processing', async () => {
    const processor = new FileProcessor();
    const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['是，选择新文件', '否，仅巡检文件夹', '取消'],
        defaultId: 0, cancelId: 2, title: '操作确认',
        message: '是否有新的文件需要归档和更新？'
    });

    if (response === 2) {
        app.quit();
    } else {
        await processor.run(response);
    }
});
