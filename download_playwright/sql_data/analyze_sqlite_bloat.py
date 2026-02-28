import sqlite3
import os

def analyze_sqlite_bloat(db_path):
    if not os.path.exists(db_path):
        print(f"错误: 找不到文件 {db_path}")
        return

    print(f"正在分析数据库: {db_path} (当前大小: {os.path.getsize(db_path) / 1024 / 1024:.2f} MB)...")
    print("-" * 60)

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # 获取所有表名
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()

    for table_name_tuple in tables:
        table_name = table_name_tuple[0]
        
        # 跳过 SQLite 内部表
        if table_name.startswith('sqlite_'):
            continue

        print(f"【表名: {table_name}】")
        
        # 获取行数
        try:
            cursor.execute(f"SELECT COUNT(*) FROM '{table_name}'")
            row_count = cursor.fetchone()[0]
            print(f"  - 总行数: {row_count}")
        except Exception as e:
            print(f"  - 读取行数失败: {e}")
            continue

        if row_count == 0:
            print("  - 空表")
            print("-" * 60)
            continue

        # 获取所有列信息
        cursor.execute(f"PRAGMA table_info('{table_name}')")
        columns = cursor.fetchall() # (cid, name, type, ...)

        # 分析每一列的平均大小
        print("  - 字段体积分析 (Top 3 占用):")
        column_stats = []
        
        for col in columns:
            col_name = col[1]
            # 计算该列数据的平均长度（字节）
            # length(cast(col as blob)) 是为了准确计算字节数
            sql = f"SELECT avg(length(cast(\"{col_name}\" as blob))), max(length(cast(\"{col_name}\" as blob))) FROM '{table_name}'"
            cursor.execute(sql)
            avg_len, max_len = cursor.fetchone()
            
            if avg_len is None: avg_len = 0
            if max_len is None: max_len = 0
            
            column_stats.append({
                "name": col_name,
                "avg": avg_len,
                "max": max_len,
                "total_est": avg_len * row_count / 1024 / 1024 # 估算该列总占用 MB
            })

        # 按总占用大小排序，取前3
        column_stats.sort(key=lambda x: x['total_est'], reverse=True)

        for stat in column_stats[:3]:
            print(f"    * {stat['name']}: 平均 {stat['avg']:.1f} 字节/行 | 最大 {stat['max']} 字节 | 估算总重: {stat['total_est']:.2f} MB")
        
        print("-" * 60)

    conn.close()

if __name__ == "__main__":
    # 请修改这里为你的数据库文件名
    db_file = "TmallDataCenter.db" 
    analyze_sqlite_bloat(db_file)