import sqlite3
import pandas as pd
import os
import sys
import io
from typing import List, Optional

# 强制重设Python的标准输出流为'utf-8'编码
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def analyze_platform_strategy(db_path: str, output_filename: str, excluded_categories: Optional[List[str]] = None):
    """
    生成以平台(渠道)为核心的、分年份的宏观战略报告，并导出到Excel。
    此版本包含所有商品（共有品+专供品）的分析。
    专供品默认其所有销售日均为“最低价”。

    :param db_path: SQLite数据库文件的完整路径。
    :param output_filename: 输出的Excel文件名。
    :param excluded_categories: 需要从分析中排除的品类列表。
    """
    if not os.path.exists(db_path):
        print(f"错误：找不到数据库文件，请检查路径是否正确: {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        print("数据库连接成功！")

        # =========================【代码改动位置 9 - SQL查询】=========================
        # 删除了之前用于筛选“共有商品”的 `WITH CommonProducts` 子句。
        # 现在，我们直接拉取所有商品的销售数据，后续在Python中处理。
        query = """
        SELECT "日期", "渠道类型", "类目", "商品69码", "商品名称", "支付金额", "支付数量"
        FROM "10销售额TOP20";
        """
        print("正在拉取【全量】商品每日销售明细数据，请稍候...")
        df_daily = pd.read_sql_query(query, conn)

    except sqlite3.Error as e:
        print(f"数据库错误: {e}")
        return
    finally:
        if 'conn' in locals() and conn:
            conn.close()
            print("数据库连接已关闭。")

    if df_daily.empty:
        print("\n分析结果：数据库中没有找到销售数据。")
        return

    print("数据拉取完毕，开始进行包含专供品的深度分析...")

    # 1. 基础数据清洗
    if excluded_categories:
        print(f"正在从分析中排除以下品类: {', '.join(excluded_categories)}")
        original_rows = len(df_daily)
        df_daily = df_daily[~df_daily['类目'].isin(excluded_categories)]
        print(f"已排除 {original_rows - len(df_daily)} 行相关数据。")
    
    df_daily['支付金额'] = pd.to_numeric(df_daily['支付金额'], errors='coerce')
    df_daily['支付数量'] = pd.to_numeric(df_daily['支付数量'], errors='coerce')
    df_daily.dropna(subset=['支付金额', '支付数量'], inplace=True)
    df_daily = df_daily[(df_daily['支付数量'] > 0) & (df_daily['支付金额'] >= 0)].copy()
    
    df_daily['日期'] = df_daily['日期'].astype(str).str.extract(r'(\d{4}-\d{2}-\d{2})', expand=False)
    df_daily.dropna(subset=['日期'], inplace=True)
    
    if df_daily.empty:
        print("\n分析结果：清洗或筛选后，没有找到任何有效的分析数据。")
        return
        
    df_daily['年份'] = pd.to_datetime(df_daily['日期']).dt.year
    df_daily['商品名称'] = df_daily['商品名称'].str.replace('\xa0', ' ', regex=False).str.strip()
    
    # =========================【代码改动位置 10 - 核心逻辑重构】=========================
    # 2. 智能区分“共有商品”和“专供商品”
    product_channel_counts = df_daily.groupby('商品69码')['渠道类型'].transform('nunique')
    df_common = df_daily[product_channel_counts > 1].copy()
    df_exclusive = df_daily[product_channel_counts == 1].copy()
    print(f"数据识别完成：共有商品 {df_common['商品69码'].nunique()} 个，专供商品 {df_exclusive['商品69码'].nunique()} 个。")

    # 3. 分别处理两类商品的价格优势
    # 3.1 对“共有商品”进行逐日比价
    if not df_common.empty:
        df_common['每日单价'] = df_common['支付金额'] / df_common['支付数量']
        min_daily_prices = df_common.groupby(['日期', '商品69码'])['每日单价'].transform('min')
        df_common['是否最低价'] = df_common['每日单价'].round(5) == min_daily_prices.round(5)
    
    # 3.2 对“专供商品”直接认定为价格优势
    if not df_exclusive.empty:
        df_exclusive['是否最低价'] = True

    # 4. 合并所有商品数据
    df_processed = pd.concat([df_common, df_exclusive], ignore_index=True)
    
    # 5. 创建Excel写入器
    with pd.ExcelWriter(output_filename, engine='openpyxl') as writer:
        print(f"准备将报告写入到Excel文件: {output_filename}")
        
        unique_years = sorted(df_processed['年份'].unique())
        
        # 6. 按年份生成独立的宏观报告
        for year in unique_years:
            print(f"正在处理 {year} 年的数据...")
            df_year = df_processed[df_processed['年份'] == year].copy()

            if df_year.empty: continue

            # 7. 按“渠道类型”聚合，计算平台级核心指标
            platform_summary = df_year.groupby('渠道类型').agg(
                平台总销售额=('支付金额', 'sum'),
                平台总销量=('支付数量', 'sum'),
                总计最低价天数=('是否最低价', 'sum')
            ).reset_index()

            total_sales_in_year = platform_summary['平台总销售额'].sum()
            total_lowest_price_days_in_year = platform_summary['总计最低价天数'].sum()

            if total_sales_in_year == 0 or total_lowest_price_days_in_year == 0: continue

            # 8. 计算占比和平均指标
            platform_summary['平台销售额占比(%)'] = (platform_summary['平台总销售额'] / total_sales_in_year) * 100
            platform_summary['平台价格优势度(%)'] = (platform_summary['总计最低价天数'] / total_lowest_price_days_in_year) * 100
            platform_summary['平台整体平均售价'] = platform_summary['平台总销售额'] / platform_summary['平台总销量']

            # 9. 整理并排序输出
            final_report = platform_summary.sort_values(by='平台总销售额', ascending=False)[[
                '渠道类型', '平台总销售额', '平台销售额占比(%)', '平台价格优势度(%)',
                '平台整体平均售价', '总计最低价天数', '平台总销量'
            ]]

            # 10. 写入Excel工作表
            sheet_name = f"{year}年度报告"
            final_report.to_excel(writer, sheet_name=sheet_name, index=False)
            print(f"  -> {year}年的报告已成功写入到工作表: {sheet_name}")
            
    # =========================【核心逻辑结束】=========================
    
    print(f"\n报告已成功生成，请在脚本同目录下查看Excel文件: {output_filename}")


if __name__ == '__main__':
    database_file_path = r"Z:\sky.viomi.com.cn\运营分析\suviom2.db"
    
    # --- 任务1: 生成包含所有品类的完整报告 ---
    print("--- 开始生成【全品类】战略报告 (包含专供品分析) ---")
    analyze_platform_strategy(
        db_path=database_file_path,
        output_filename="平台年度战略报告_全品类(含专供品).xlsx",
        excluded_categories=None
    )
    print("--- 【全品类】战略报告生成完毕 ---\n")

    # --- 任务2: 生成排除三大白电品类的专项报告 ---
    print("--- 开始生成【排除大家电】的专项报告 (包含专供品分析) ---")
    categories_to_exclude = ['空调', '冰箱', '洗衣机']
    analyze_platform_strategy(
        db_path=database_file_path,
        output_filename="平台年度战略报告_排除大家电(含专供品).xlsx",
        excluded_categories=categories_to_exclude
    )
    print("--- 【排除大家电】的专项报告生成完毕 ---")