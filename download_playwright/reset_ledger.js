import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SQL_DATA_DIR = path.join(path.dirname(__filename), 'sql_data');
const dbFiles = fs.readdirSync(SQL_DATA_DIR).filter(f => f.endsWith('.db'));

for (const file of dbFiles) {
    try {
        const db = new Database(path.join(SQL_DATA_DIR, file));
        db.exec("DROP TABLE IF EXISTS _neon_sync_ledger;");
        console.log(`✅ 已清除 [${file}] 中的污染账本`);
        db.close();
    } catch (e) { console.error(e.message); }
}