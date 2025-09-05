// database-service.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class DatabaseService {
    constructor(dbPath) {
        // 确保数据库文件所在的目录存在
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
    }

    /**
     * 获取表的列信息
     * @param {string} tableName 表名
     * @returns {string[]} 列名数组
     */
    getTableColumns(tableName) {
        try {
            return this.db.prepare(`PRAGMA table_info("${tableName}")`).all().map(col => col.name);
        } catch (e) {
            return []; // 表不存在时会报错，返回空数组
        }
    }
    
    /**
     * 规范化列名，移除特殊字符
     * @param {string} header 原始列名
     * @returns {string} 清理后的列名
     */
    sanitize(header) {
        return header.replace(/[\s\.\-\/\\()]/g, '_');
    }

    /**
     * 确保表和列存在，如果不存在则创建或添加
     * @param {string} tableName 表名
     * @param {object[]} data 数据
     * @param {string[]} primaryKeys 主键
     * @param {string[]} numericColumns 需要设为REAL类型的列
     */
    ensureTable(tableName, data, primaryKeys, numericColumns = []) {
        if (data.length === 0) return;

        const headers = Object.keys(data[0]);
        const sanitizedHeaders = headers.map(this.sanitize);
        const sanitizedPrimaryKeys = primaryKeys.map(this.sanitize);
        const getColumnType = (header) => numericColumns.includes(header) ? 'REAL' : 'TEXT';

        const existingColumns = this.getTableColumns(tableName);

        if (existingColumns.length === 0) {
            const createTableSQL = `
                CREATE TABLE "${tableName}" (
                    ${headers.map(h => `"${this.sanitize(h)}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${sanitizedPrimaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `;
            this.db.exec(createTableSQL);
        } else {
            const newHeaders = headers.filter(h => !existingColumns.includes(this.sanitize(h)));
            if (newHeaders.length > 0) {
                const alterStmts = newHeaders.map(h => 
                    this.db.prepare(`ALTER TABLE "${tableName}" ADD COLUMN "${this.sanitize(h)}" ${getColumnType(h)}`)
                );
                this.db.transaction(() => {
                    alterStmts.forEach(stmt => stmt.run());
                })();
            }
        }
    }

    /**
     * 使用 INSERT...ON CONFLICT...DO UPDATE 插入或更新数据 (Upsert)
     * @param {string} tableName 表名
     * @param {object[]} data 要插入的数据
     * @param {string[]} primaryKeys 主键
     */
    upsert(tableName, data, primaryKeys) {
        if (data.length === 0) return;

        const finalTableColumns = this.getTableColumns(tableName);
        const sanitizedPrimaryKeys = primaryKeys.map(this.sanitize);
        const columnsToUpdate = finalTableColumns.filter(h => !sanitizedPrimaryKeys.includes(h));

        const insertQuery = `
            INSERT INTO "${tableName}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
            VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
            ON CONFLICT(${sanitizedPrimaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
            ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
        `;
        const insertStmt = this.db.prepare(insertQuery);

        this.db.transaction(() => {
            for (const row of data) {
                const dataToInsert = {};
                const sanitizedCurrentRow = {};
                for(const key in row) {
                    sanitizedCurrentRow[this.sanitize(key)] = row[key];
                }

                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                insertStmt.run(dataToInsert);
            }
        })();
    }

    /**
     * 完全重置并插入新数据，用于对照表同步
     * @param {string} tableName
     * @param {object[]} data
     * @param {string} primaryKey
     */
    replaceTable(tableName, data, primaryKey) {
        if (data.length === 0) return;

        const headers = Object.keys(data[0]);
        const sanitizedHeaders = headers.map(this.sanitize);
        const sanitizedPrimaryKey = this.sanitize(primaryKey);

        this.db.exec(`DROP TABLE IF EXISTS "${tableName}";`);
        this.db.exec(`
            CREATE TABLE "${tableName}" (
                ${sanitizedHeaders.map(h => `"${h}" TEXT`).join(', ')},
                PRIMARY KEY ("${sanitizedPrimaryKey}")
            );
        `);

        const insert = this.db.prepare(`
            INSERT INTO "${tableName}" (${sanitizedHeaders.map(h => `"${h}"`).join(', ')})
            VALUES (${sanitizedHeaders.map(h => `@${h}`).join(', ')});
        `);
        
        this.db.transaction(() => {
            for (const row of data) {
                const sanitizedRow = {};
                for (const key in row) {
                    sanitizedRow[this.sanitize(key)] = row[key] !== null && row[key] !== undefined ? String(row[key]) : null;
                }
                insert.run(sanitizedRow);
            }
        })();
    }


    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = DatabaseService;