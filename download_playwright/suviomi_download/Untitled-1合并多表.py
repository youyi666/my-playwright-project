# -*- coding: utf-8 -*-

import pandas as pd
import sqlite3
from sqlalchemy import create_engine
from pathlib import Path
import re

# --- 配置区域 ---

# 1. 源文件夹路径：存放所有 .xlsx 文件的文件夹
SOURCE_FOLDER_PATH = r"Z:\sky.viomi.com.cn\运营分析\平台获取-商品销售流量\渠道品类流量分布-多表版"

# 2. 目标数据库文件路径：如果不存在，脚本会自动创建
DATABASE_PATH = r"Z:\sky.viomi.com.cn\运营分析\suviom2.db"

# 3. 主键规则定义
# 格式：'Excel中的Sheet名': ('数据库中的主键字段1', '主键字段2', ...)
# 注意：这里定义的字段名必须与Excel中的列名或新增的“月份”字段完全一致
PRIMARY_KEY_RULES = {
    "1-商品概况": ("月份",),
    "2-交易流量趋势": ("日期",),
    "3-访客数分布": ("月份", "渠道类型"),
    "4-支付用户数分布": ("月份", "渠道类型"),
    "5-支付金额分布": ("月份", "渠道类型"),
    "6-支付件数分布": ("月份", "渠道类型"),
    "7-销售流量分布": ("月份", "渠道类型"),
    "8-转化率分布": ("月份", "渠道类型"),
    "9-类目销售流量分布": ("月份", "产品公司"),
    "10-销售额TOP20": ("月份", "渠道类型"),
    "11-渠道品类流量分布": ("月份", "渠道类型"),
}

# --- 脚本核心逻辑 ---

def clean_table_name(sheet_name):
    """
    清理工作表名称，使其成为一个合法的SQL表名。
    移除前导数字和连字符，并替换特殊字符为下划线。
    例如：'1-商品概况' -> '商品概况'
    """
    # 移除非法字符
    name = re.sub(r'[^\w\u4e00-\u9fa5]', '_', sheet_name)
    # 移除可能的前导数字和下划线
    name = re.sub(r'^\d+_?', '', name)
    return name

def process_files(source_dir, db_engine):
    """
    处理指定目录下的所有Excel文件，并将数据导入数据库。
    """
    source_path = Path(source_dir)
    # 查找所有 .xlsx 文件，忽略以 ~$ 开头的临时文件
    excel_files = [f for f in source_path.glob("*.xlsx") if not f.name.startswith("~$")]

    if not excel_files:
        print(f"警告：在目录 '{source_dir}' 中没有找到任何 .xlsx 文件。")
        return

    print(f"找到 {len(excel_files)} 个 .xlsx 文件，开始处理...")

    for file_path in excel_files:
        print(f"\n--- 正在处理文件: {file_path.name} ---")
        try:
            # 1. 提取“月份”信息
            # 首先读取“2-交易流量趋势”表来获取日期
            df_trend = pd.read_excel(file_path, sheet_name="2-交易流量趋势", engine='openpyxl')
            if df_trend.empty or '日期' not in df_trend.columns:
                print(f"  [错误] 文件 '{file_path.name}' 的 '2-交易流量趋势' 工作表为空或缺少'日期'列，跳过此文件。")
                continue
            
            # 将日期列转换为datetime对象，并获取第一个非空日期的月份
            df_trend['日期'] = pd.to_datetime(df_trend['日期'], errors='coerce')
            first_valid_date = df_trend['日期'].dropna().iloc[0]
            month_str = first_valid_date.strftime('%Y-%m')
            print(f"  提取到月份: {month_str}")

            # 2. 读取文件中的所有工作表
            all_sheets = pd.read_excel(file_path, sheet_name=None, engine='openpyxl')

            # 3. 遍历每个工作表进行处理和导入
            for sheet_name, df in all_sheets.items():
                if sheet_name not in PRIMARY_KEY_RULES:
                    print(f"  - 工作表 '{sheet_name}' 没有配置主键规则，跳过。")
                    continue

                if df.empty:
                    print(f"  - 工作表 '{sheet_name}' 为空，跳过。")
                    continue
                
                table_name = clean_table_name(sheet_name)
                print(f"  - 正在处理工作表 '{sheet_name}' -> 数据库表 '{table_name}'...")

                # 4. 根据规则添加“月份”字段
                pk_fields = PRIMARY_KEY_RULES.get(sheet_name, [])
                if "月份" in pk_fields:
                    df["月份"] = month_str

                # 5. 将数据追加到数据库表中
                # 使用 `if_exists='append'` 来追加数据，而不是覆盖
                # `index=False` 表示不将DataFrame的索引写入数据库
                df.to_sql(table_name, db_engine, if_exists='append', index=False)
                print(f"    成功将 {len(df)} 行数据追加到表 '{table_name}'。")

        except FileNotFoundError:
            print(f"  [错误] 文件不存在: {file_path}")
        except Exception as e:
            print(f"  [严重错误] 处理文件 '{file_path.name}' 时发生未知错误: {e}")
    
    print("\n--- 所有文件的数据已导入完毕 ---")


def create_unique_indexes(db_path, rules):
    """
    在数据导入后，为指定的表创建唯一索引，功能上等同于设置主键。
    使用 "CREATE UNIQUE INDEX IF NOT EXISTS" 确保脚本可重复运行。
    """
    print("\n--- 开始创建唯一索引 (模拟主键) ---")
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        for sheet_name, pk_fields in rules.items():
            table_name = clean_table_name(sheet_name)
            index_name = f"idx_{table_name}_pk"
            # 将主键字段用逗号连接起来，例如："月份", "渠道类型" -> "月份, 渠道类型"
            columns_str = ", ".join([f'"{col}"' for col in pk_fields])
            
            sql_statement = f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table_name} ({columns_str});"
            
            try:
                print(f"  为表 '{table_name}' 在字段 ({columns_str}) 上创建唯一索引...")
                cursor.execute(sql_statement)
            except sqlite3.OperationalError as e:
                # 捕获可能因表或列不存在而引发的错误
                print(f"    [警告] 无法为表 '{table_name}' 创建索引。可能是表或列不存在。错误: {e}")

        conn.commit()
        print("--- 所有唯一索引创建完毕 ---")

    except Exception as e:
        print(f"[严重错误] 连接数据库或创建索引时出错: {e}")
    finally:
        if conn:
            conn.close()


def main():
    """
    主函数，协调整个流程。
    """
    print("脚本启动...")
    
    # SQLAlchemy引擎用于pandas的to_sql函数，它能更好地处理数据类型
    # 'sqlite:///...' 是标准的连接字符串格式
    db_engine = create_engine(f'sqlite:///{DATABASE_PATH}')
    
    # 第一步：处理文件并将数据写入数据库
    process_files(SOURCE_FOLDER_PATH, db_engine)
    
    # 第二步：数据写入完成后，创建唯一索引来强制主键约束
    create_unique_indexes(DATABASE_PATH, PRIMARY_KEY_RULES)
    
    print("\n所有任务已完成！")


# --- 脚本入口 ---
if __name__ == "__main__":
    main()