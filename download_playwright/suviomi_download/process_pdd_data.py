# -*- coding: utf-8 -*-
import os
import pandas as pd
from sqlalchemy import create_engine, text
import sys

# --- 1. 配置区域 ---
# 源文件夹路径，存放所有拼多多相关的xlsx表格
SOURCE_FOLDER_PATH = r"Z:\sky.viomi.com.cn\运营分析\平台获取-商品销售流量\拼多多"
# 目标数据库文件路径
DB_FILE_PATH = r"Z:\天猫生意参谋\TmallDataCenter.db"
# 目标数据表名称
TABLE_NAME = "pinduoduo_sales_flow"
# 主键列名
PRIMARY_KEYS = ["日期", "商品ID"]

# --- 脚本主逻辑 ---

def main():
    """
    脚本的主执行函数
    """
    print("--- 脚本开始执行 ---")

    # 检查源文件夹是否存在
    if not os.path.exists(SOURCE_FOLDER_PATH):
        print(f"错误：源文件夹不存在，请检查路径配置！\n路径: {SOURCE_FOLDER_PATH}")
        sys.exit(1) # 退出脚本

    # 检查数据库文件夹是否存在，如果不存在则创建
    db_dir = os.path.dirname(DB_FILE_PATH)
    if not os.path.exists(db_dir):
        print(f"提示：数据库所在文件夹不存在，将自动创建。\n路径: {db_dir}")
        os.makedirs(db_dir)

    # 2. 扫描文件夹，找到所有xlsx文件
    excel_files = [f for f in os.listdir(SOURCE_FOLDER_PATH) if f.lower().endswith('.xlsx')]

    if not excel_files:
        print(f"在文件夹 '{SOURCE_FOLDER_PATH}' 中没有找到任何 .xlsx 文件。")
        return

    print(f"找到 {len(excel_files)} 个 .xlsx 文件，准备处理...")

    # 3. 逐个读取Excel文件并合并到一个DataFrame中
    all_dataframes = []
    for file in excel_files:
        file_path = os.path.join(SOURCE_FOLDER_PATH, file)
        try:
            print(f"正在读取文件: {file}")
            # 使用 openpyxl 引擎读取 xlsx 文件
            df = pd.read_excel(file_path, engine='openpyxl')
            all_dataframes.append(df)
        except Exception as e:
            print(f"读取文件 '{file}' 时发生错误: {e}")
            # 如果某个文件读取失败，可以选择跳过或终止，这里选择跳过
            continue
    
    # 如果没有成功读取任何文件，则退出
    if not all_dataframes:
        print("错误：所有文件都读取失败，脚本终止。")
        return

    # 将所有DataFrame合并成一个
    print("正在合并所有Excel文件的数据...")
    combined_df = pd.concat(all_dataframes, ignore_index=True)
    
    # 检查主键列是否存在
    for key in PRIMARY_KEYS:
        if key not in combined_df.columns:
            print(f"错误：数据中缺少主键列 '{key}'，请检查Excel文件。")
            print(f"所有列名: {combined_df.columns.tolist()}")
            return
            
    print(f"合并完成，总共 {len(combined_df)} 条记录。")

    # 4. 数据去重
    # 根据主键去除重复行，保留最后出现的记录（通常是最新文件里的）
    print(f"根据主键 {PRIMARY_KEYS} 进行数据去重...")
    original_rows = len(combined_df)
    combined_df.drop_duplicates(subset=PRIMARY_KEYS, keep='last', inplace=True)
    deduplicated_rows = len(combined_df)
    print(f"去重完成，移除了 {original_rows - deduplicated_rows} 条重复记录。剩余 {deduplicated_rows} 条唯一记录。")

    # 5. 连接数据库并写入数据
    # 使用 SQLAlchemy 创建数据库引擎
    # 'sqlite:///' 是连接SQLite数据库的标准格式
    engine = create_engine(f'sqlite:///{DB_FILE_PATH}')
    
    print(f"正在连接数据库并写入数据到表 '{TABLE_NAME}'...")
    try:
        # 使用 to_sql 方法将数据写入数据库
        # if_exists='replace' 表示如果表已存在，则删除旧表，创建新表并写入数据
        # index=False 表示不将DataFrame的索引写入数据库
        combined_df.to_sql(TABLE_NAME, engine, if_exists='replace', index=False, chunksize=1000)
        print("数据写入成功！")

        # 6. 设置主键（通过创建唯一索引实现）
        # to_sql 不直接支持复合主键，最佳实践是之后执行SQL语句来创建唯一索引
        # 这可以确保 "日期" 和 "商品ID" 的组合是唯一的，功能上等同于复合主键
        index_name = f"idx_{TABLE_NAME}_pk"
        
        # --- 代码修改开始 ---
        # 改动说明：
        # 将原先复杂的f-string拆分为两步，以避免语法错误。
        # 1. 先生成带双引号的列名字符串，例如："日期", "商品ID"
        quoted_keys = ", ".join([f'"{k}"' for k in PRIMARY_KEYS])
        # 2. 然后将这个简单的字符串变量插入到最终的SQL语句中
        create_index_sql_string = f'CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {TABLE_NAME} ({quoted_keys});'
        create_index_sql = text(create_index_sql_string)
        # --- 代码修改结束 ---

        with engine.connect() as connection:
            print(f"正在为列 {PRIMARY_KEYS} 创建唯一索引以作为主键...")
            connection.execute(create_index_sql)
            connection.commit() # 提交事务
            print("主键（唯一索引）设置成功！")

    except Exception as e:
        print(f"写入数据库或设置主键时发生严重错误: {e}")
        return

    print("--- 脚本执行完毕 ---")

if __name__ == "__main__":
    main()