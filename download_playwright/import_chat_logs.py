import sqlite3
import json
import os
import glob
from datetime import datetime

# ================= 配置区域 =================
# 目标文件夹路径
DATA_DIR = r"D:\chat-scrap\daily_raw_logs"
# 数据库文件名 (将保存在同一目录下)
DB_NAME = "chat_logs.db"
# ===========================================

def init_db(cursor):
    """
    初始化数据库结构
    设计思路：
    1. sessions 表作为主表，存储会话维度的信息。
    2. messages 表作为从表，存储每一条消息，通过 session_id 关联。
    """
    # 创建 Sessions 表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            date TEXT,
            customer_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # 创建 Messages 表
    # 使用 message_order 确保在按时间排序相同的情况下，能保持原始数组的顺序
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            time TEXT,
            sender TEXT,
            role TEXT,
            content TEXT,
            message_order INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    ''')
    
    # 创建索引以加速查询
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)')

def process_file(file_path, conn, cursor):
    """
    读取单个 JSONL 文件并写入数据库
    """
    filename = os.path.basename(file_path)
    print(f"正在处理文件: {filename}...")
    
    insert_session_sql = '''
        INSERT OR IGNORE INTO sessions (session_id, date, customer_name)
        VALUES (?, ?, ?)
    '''
    
    insert_message_sql = '''
        INSERT INTO messages (session_id, time, sender, role, content, message_order)
        VALUES (?, ?, ?, ?, ?, ?)
    '''
    
    record_count = 0
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    data = json.loads(line)
                except json.JSONDecodeError as e:
                    print(f"  [警告] JSON 解析失败，跳过该行: {e}")
                    continue

                # 1. 提取并插入 Session 数据
                session_id = data.get('sessionId')
                date = data.get('date')
                customer_name = data.get('customerName')
                
                if not session_id:
                    continue

                cursor.execute(insert_session_sql, (session_id, date, customer_name))
                
                # 检查是否插入成功（如果 IGNORE 了，rowcount 可能为 0）
                # 如果 Session 已存在，我们通常不需要再次插入 Message，除非你需要合并数据
                # 这里逻辑为：只有当 Session 是新的，或者是为了补全 Message，才插入 Message
                # 为简单起见，这里假设若 Session 存在则跳过 Message 插入，避免重复
                # 如果你需要覆盖，请修改 INSERT OR IGNORE 为 REPLACE
                
                # 2. 提取并插入 Messages 数据
                # 获取该 session_id 是否已存在于 messages 表中，如果存在则跳过以防重复
                cursor.execute("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (session_id,))
                if cursor.fetchone():
                    continue

                messages = data.get('messages', [])
                if messages:
                    msg_data = []
                    for idx, msg in enumerate(messages):
                        msg_data.append((
                            session_id,
                            msg.get('time'),
                            msg.get('sender'),
                            msg.get('role'),
                            msg.get('content'),
                            idx  # 记录原始顺序
                        ))
                    
                    cursor.executemany(insert_message_sql, msg_data)
                    record_count += 1

        conn.commit()
        print(f"  完成。新增会话数: {record_count}")

    except Exception as e:
        print(f"  [错误] 处理文件 {filename} 时发生异常: {e}")
        conn.rollback()

def main():
    db_path = os.path.join(DATA_DIR, DB_NAME)
    
    # 连接数据库
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # 初始化表结构
        init_db(cursor)
        print(f"数据库初始化成功: {db_path}")
        
        # 查找所有 .jsonl 文件
        jsonl_files = glob.glob(os.path.join(DATA_DIR, "*.jsonl"))
        
        if not jsonl_files:
            print(f"在 {DATA_DIR} 未找到 .jsonl 文件。")
            return

        # 遍历处理
        for file_path in jsonl_files:
            process_file(file_path, conn, cursor)
            
    except Exception as e:
        print(f"发生严重错误: {e}")
    finally:
        if 'conn' in locals():
            conn.close()
            print("数据库连接已关闭。")

if __name__ == "__main__":
    main()