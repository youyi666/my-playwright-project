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
    "拼多多商品销售流量_": "Z:/sky.viomi.com.cn/运营分析/平台获取-商品销售流量/拼多多",
    "pdd_promotion_report": "Z:/天猫生意参谋/推广_商品数据/拼多多",   
};

const CENTRAL_DB_PATH = 'Z:/天猫生意参谋/TmallDataCenter.db';
const REFERENCE_TABLE_PATH = 'Z:/天猫生意参谋/天猫商品对照表.xlsx'; // 新增：商品对照表路径
const MERGE_INTO_CENTRAL_DB = new Set([
    "商品报表_",
    "【生意参谋平台】商品_全部_"
]);

// 定义需要转换为数字的列，完全参照您的Power Query脚本
const sycmNumericColumns = ["商品访客数", "商品浏览量", "平均停留时长", "商品详情页跳出率", "商品收藏人数", "商品加购件数", "商品加购人数", "下单买家数", "下单件数", "下单金额", "下单转化率", "支付买家数", "支付件数", "支付金额", "商品支付转化率", "支付新买家数", "支付老买家数", "老买家支付金额", "聚划算支付金额", "访客平均价值", "成功退款金额", "竞争力评分", "搜索引导访客数", "搜索引导支付买家数", "实付金额", "支付单价"];
// --- [新增] 为 pdd_promotion_report 文件定义需要转为数字的列 ---
// 注意：这里的列名需要与您CSV文件解析后的表头完全一致。
const pddPromoNumericColumns = ["花费(元)", "订单数", "成交金额(元)", "投产比", "点击量", "点击率(%)", "千次展现花费(元)"];
// --- [结束] ---
const promoNumericColumns = ["点击量", "花费", "总成交金额", "总成交笔数", "投入产出比", "总收藏加购成本", "总成交成本", "宝贝收藏成本", "宝贝收藏加购成本"];


class FileProcessor {
    // ... FileProcessor 类的 saveToDatabase, syncReferenceTable, constructor, updateProgress, processFile 等函数与上一版完全相同 ...
    saveToDatabase(xlsxPath, targetFolder, tableName, fileKey, logTarget, fileDate = null) {
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
            
            const workbook = xlsx.readFile(xlsxPath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            if (fileKey === "商品报表_") {
                const range = xlsx.utils.decode_range(worksheet['!ref']);
                let idColumnIndex = -1;
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellRef = xlsx.utils.encode_cell({c: C, r: range.s.r});
                    const cell = worksheet[cellRef];
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

            const jsonOptions = { 
                raw: false,
                dateNF: 'yyyy-mm-dd'
            }; 
            
            if (fileKey === "【生意参谋平台】商品_全部_") {
                jsonOptions.range = 4;
            }

            let rawData = xlsx.utils.sheet_to_json(worksheet, jsonOptions);

            if (rawData.length === 0) {
                logTarget.push({ file: path.basename(xlsxPath), status: 'Skipped' });
                return;
            }

            const formatDate = (dateInput) => {
                if (dateInput === null || dateInput === undefined) {
                    return null;
                }
                if (typeof dateInput === 'number') {
                    const dateParts = xlsx.SSF.parse_date_code(dateInput);
                    if (dateParts && dateParts.y && dateParts.m && dateParts.d) {
                        const year = dateParts.y;
                        const month = String(dateParts.m).padStart(2, '0');
                        const day = String(dateParts.d).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    }
                }
                if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)) {
                    return dateInput.substring(0, 10);
                }
                if (dateInput instanceof Date && !isNaN(dateInput)) {
                    const year = dateInput.getUTCFullYear();
                    const month = String(dateInput.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(dateInput.getUTCDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                }
                return dateInput;
            };
            
            const processedData = rawData.map(rawRow => {
                const finalRow = {};
                for (const key in rawRow) {
                    finalRow[key.trim()] = rawRow[key];
                }
                if (fileKey === "商品报表_") {
                    finalRow['商品ID'] = finalRow['主体ID'];
                    delete finalRow['主体ID'];
                    finalRow['统计日期'] = finalRow['日期'];
                    delete finalRow['日期'];
                }
                if (fileKey === "pdd_promotion_report" && fileDate) {
                    finalRow['统计日期'] = fileDate;
                }
                if (finalRow['统计日期']) {
                    finalRow['统计日期'] = formatDate(finalRow['统计日期']);
                } 
                else if (finalRow['日期']) {
                    finalRow['日期'] = formatDate(finalRow['日期']);
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
                    const num = parseFloat(String(val).replace(/[,%]/g, ''));
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
                } else if (fileKey === "pdd_promotion_report") {
                    pddPromoNumericColumns.forEach(col => {
                        if (finalRow.hasOwnProperty(col)) {
                           if (col === '点击率(%)') {
                               finalRow[col] = toNumeric(finalRow[col]) / 100;
                           } else {
                               finalRow[col] = toNumeric(finalRow[col]);
                           }
                        }
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
            
            if (processedData.length === 0) {
                logTarget.push({ file: path.basename(xlsxPath), status: 'Skipped (No Data)' });
                return;
            }

            const currentFileHeaders = Object.keys(processedData[0]);
            const sanitizedHeaders = currentFileHeaders.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
            
            let primaryKeys;
            if (fileKey === "【生意参谋平台】商品_全部_" || fileKey === "商品报表_") {
                const pk1 = '统计日期'.replace(/[\s\.\-\/\\()]/g, '_');
                const pk2 = '商品ID'.replace(/[\s\.\-\/\\()]/g, '_');
                primaryKeys = [pk1, pk2];
            } else if (fileKey === "products_") {
                if (sanitizedHeaders.length >= 2) {
                    const pk1 = sanitizedHeaders[0];
                    const pk2 = sanitizedHeaders[1];
                    const pk3 = sanitizedHeaders[5];
                    primaryKeys = [pk1, pk2, pk3];
                } else {
                    this.log.errors.push({ filename: path.basename(xlsxPath), error: `文件列数不足，无法创建联合主键。` });
                    primaryKeys = [sanitizedHeaders[0]];
                } 
            } else if (fileKey ==="拼多多商品销售流量_") {
                if (sanitizedHeaders.length >= 2) {
                    const pk1 = sanitizedHeaders[0];
                    const pk2 = sanitizedHeaders[1];
                    primaryKeys = [pk1, pk2];
                } else {
                    this.log.errors.push({ filename: path.basename(xlsxPath), error: `“拼多多”文件列数不足两列，无法创建联合主键。` });
                    primaryKeys = [sanitizedHeaders[0]];
                }
            } else if (fileKey === "pdd_promotion_report") {
                if (currentFileHeaders.includes('统计日期') && currentFileHeaders.includes('商品ID')) {
                    const pk1 = '统计日期'.replace(/[\s\.\-\/\\()]/g, '_');
                    const pk2 = '商品ID'.replace(/[\s\.\-\/\\()]/g, '_');
                    primaryKeys = [pk1, pk2];
                } else {
                    this.log.errors.push({ filename: path.basename(xlsxPath), error: `文件缺少 '统计日期' 或 '商品ID' 列，无法创建联合主键。` });
                    primaryKeys = [sanitizedHeaders[0]];
                }
            } else {
                 primaryKeys = [sanitizedHeaders[0]];
            }

            const getColumnType = (header) => {
                let numericList = [];
                if (fileKey === "【生意参谋平台】商品_全部_") {
                    numericList = sycmNumericColumns;
                } else if (fileKey === "商品报表_") {
                    numericList = promoNumericColumns;
                } else if (fileKey === "pdd_promotion_report") {
                    numericList = pddPromoNumericColumns;
                }
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

    syncReferenceTable() {
        if (!fs.existsSync(REFERENCE_TABLE_PATH)) {
            return;
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
            const primaryKey = sanitizedHeaders[0];
            const tableName = "商品对照表";

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
        if (this.totalFiles > 0) {
            const progress = Math.round((this.processedFiles / this.totalFiles) * 100);
            mainWindow.webContents.send('progress-update', { progress, message });
        } else {
             mainWindow.webContents.send('progress-update', { progress: 100, message });
        }
    }

    // --- [修改] 升级巡检功能，使其能够处理CSV文件 ---
    scanAndSyncFolders(filesToScan) {
        for (const file of filesToScan) {
            let { fullPath, folderPath, fileKey, tableName } = file;
            let processedPath = fullPath;       // 将用于数据库导入的路径，默认为原始路径
            let originalCsvPathToDelete = null; // 用于标记转换成功后需要删除的原始CSV文件

            // 如果巡检到的是CSV文件，则先进行转换
            if (fullPath.toLowerCase().endsWith('.csv')) {
                const xlsxFilename = path.basename(fullPath, path.extname(fullPath)) + '.xlsx';
                const xlsxPath = path.join(folderPath, xlsxFilename);
                
                try {
                    this.updateProgress(`转换巡检文件: ${path.basename(fullPath)}`);
                    
                    const readOptions = {};
                    // 同样应用 processFile 中的 codepage 逻辑以确保兼容性
                    if (fileKey === "商品报表_") {
                        readOptions.codepage = 936;
                    }
                    const workbook = xlsx.readFile(fullPath, readOptions);
                    xlsx.writeFile(workbook, xlsxPath);

                    // 转换成功后，更新处理路径为新的xlsx文件路径
                    processedPath = xlsxPath;
                    // 并标记原始CSV文件以便处理后删除
                    originalCsvPathToDelete = fullPath;

                } catch (e) {
                    this.log.errors.push({ filename: path.basename(fullPath), error: `巡检中CSV转换失败: ${e.message}` });
                    continue; // 如果转换失败，则跳过此文件
                }
            }

            // 对原始的 .xlsx 文件或由 .csv 转换而来的 .xlsx 文件执行统一的后续操作
            this.updateProgress(`巡检同步: ${path.basename(processedPath)}`);
            
            let fileDate = null;
            const dateMatch = path.basename(processedPath).match(/\d{4}-\d{2}-\d{2}/);
            if (dateMatch) {
                fileDate = dateMatch[0];
            }

            this.saveToDatabase(processedPath, folderPath, tableName, fileKey, this.log.dbSyncFromFolderScan, fileDate);

            // 如果原始文件是CSV且已成功处理，此时将其删除，避免下次重复处理
            if (originalCsvPathToDelete) {
                try {
                    fs.unlinkSync(originalCsvPathToDelete);
                } catch (e) {
                     this.log.errors.push({ filename: path.basename(originalCsvPathToDelete), error: `删除原始CSV失败: ${e.message}` });
                }
            }
        }
    }
    // --- [结束] ---

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
            
            let fileDate = null;
            const dateMatch = originalFilename.match(/\d{4}-\d{2}-\d{2}/);
            if (dateMatch) {
                fileDate = dateMatch[0];
            }

            this.saveToDatabase(destinationPath, targetFolder, tableName, fileKey, this.log.dbSyncFromUserFiles, fileDate);
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
                    userSelectedFiles.push(filePath); 
                }
            }
        }
        
        for (const [fileKey, folderPath] of Object.entries(DESTINATION_MAP)) {
            if (fs.existsSync(folderPath)) {
                // --- [修改] 扩大扫描范围，使其包含 .csv 文件 ---
                const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.csv'));
                // --- [结束] ---
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
        
        this.syncReferenceTable();

        if (this.totalFiles === 0 && userSelectedFiles.length === 0) {
             mainWindow.webContents.send('processing-complete', this.log);
             return;
        }

        userSelectedFiles.forEach(file => this.processFile(file));
        this.scanAndSyncFolders(folderScanFiles);

        mainWindow.webContents.send('processing-complete', this.log);
    }
}

async function startFileProcessing() {
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
}

ipcMain.on('ui-ready', () => {
    startFileProcessing();
});