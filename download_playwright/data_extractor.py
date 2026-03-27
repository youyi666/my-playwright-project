import sqlite3
import pandas as pd
from datetime import datetime, timedelta
import os

def generate_markdown_table(df):
    """
    轻量级辅助函数：将 DataFrame 转换为 Markdown 表格，
    避免额外安装 tabulate 库导致报错。
    """
    if df.empty:
        return "*暂无数据*"
    headers = df.columns.tolist()
    md = "| " + " | ".join(headers) + " |\n"
    md += "|" + "|".join(["---"] * len(headers)) + "|\n"
    for _, row in df.iterrows():
        # 将数值型数据做简单格式化防止科学计数法
        row_str = [str(x) if not isinstance(x, float) else f"{x:.2f}" for x in row.values]
        md += "| " + " | ".join(row_str) + " |\n"
    return md


def get_ai_analysis_data(days_count=14, platforms=None):
    """
    提取并清洗数据库数据，返回自定义天数和指定平台的汇总数据，生成 Markdown 报表。
    
    :param days_count: 提取过去多少天的数据（不含今天，例如 14 表示过去 14 天）
    :param platforms: 平台列表，例如 ['京东', '天猫']。若传 None 或空列表，则提取全平台。
    """
    # 数据库路径：请根据你的实际目录层级微调
    db_path = os.path.join( '..', '..', '00_Shared_Database数据库', 'TmallDataCenter.db')
    
    if not os.path.exists(db_path):
        print(f"❌ 找不到数据库文件: {db_path}")
        return None

    # 计算日期边界 (统一格式 YYYY-MM-DD)
    today = datetime.now()
    end_date_str = (today - timedelta(days=1)).strftime('%Y-%m-%d')        # 昨天
    start_date_str = (today - timedelta(days=days_count)).strftime('%Y-%m-%d') # 自定义天数前

    # 动态构建平台过滤 SQL
    platform_sql = ""
    if platforms and isinstance(platforms, list):
        # 将列表转换为 SQL 的 IN 语法，如: '京东','天猫'
        places = ",".join([f"'{p}'" for p in platforms])
        platform_sql = f"AND platform IN ({places})"

    # 连接 SQLite 数据库
    conn = sqlite3.connect(db_path)
    
    try:
        # ---------------------------------------------------------
        # 1. 在 SQLite 层完成预过滤，减轻 Pandas 压力
        # 增量修改：引入了 dynamic date 和 platform_sql
        # ---------------------------------------------------------
        query = f"""
            SELECT 
                platform, barcode, product_name, category,
                sales_volume, sales_amount, visitor_count
            FROM sales_history
            WHERE record_date >= '{start_date_str}' AND record_date <= '{end_date_str}'
              {platform_sql}
              AND barcode IS NOT NULL 
              AND TRIM(barcode) != ''
              AND barcode NOT LIKE '%找不到%'
              AND product_name NOT LIKE '%空调%'
              AND category NOT LIKE '%空调%'
        """
        
        # 使用 pandas 直接读取 SQL 查询结果
        df = pd.read_sql_query(query, conn)
        
        if df.empty:
            print(f"⚠️ {start_date_str} 至 {end_date_str} 期间没有符合条件的有效 barcode 数据。")
            return None

        # ---------------------------------------------------------
        # 2. 自定义维度汇总 (聚合各个平台、各个 barcode 的表现)
        # ---------------------------------------------------------
        # 按 平台、barcode 和产品名称 分组，对销售额、销量、访客求和
        summary_df = df.groupby(['platform', 'barcode', 'product_name']).agg({
            'sales_amount': 'sum',
            'sales_volume': 'sum',
            'visitor_count': 'sum'
        }).reset_index()
        
        # 按平台和销售额降序排列，找出头部产品
        summary_df = summary_df.sort_values(by=['platform', 'sales_amount'], ascending=[True, False])

        # ---------------------------------------------------------
        # 3. 精简数据体积，剔除 0 销量，且每个平台仅保留 Top 20
        # ---------------------------------------------------------
        # 1. 绝对红线：直接剔除销售额为 0 或空值的占位产品
        summary_df = summary_df[summary_df['sales_amount'] > 0]

        # 2. 相对过滤：按平台分组，仅保留每个平台销售额最高的前 20 个破局潜力股
        if not summary_df.empty:
            summary_df = summary_df.groupby('platform').head(20)
            
        print(f"✂️ 终极瘦身完成：{days_count}日数据精简至 {len(summary_df)} 条。")
        
        # ---------------------------------------------------------
        # 4. 封装为变量 (输出为 Markdown 格式，专为 Obsidian/AI 优化)
        # ---------------------------------------------------------
        md_table = generate_markdown_table(summary_df)
        platform_name_str = "、".join(platforms) if platforms else "全部平台"
        
        # 拼接成自带排版的纯文本
        export_text = f"""## 📊 电商销售数据汇总报告

- **统计周期**：`{start_date_str}` 至 `{end_date_str}` (共 {days_count} 天)
- **涵盖平台**：{platform_name_str}
- **生成时间**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

### 🏆 各平台产品表现 (Top 20)
{md_table}

> *注：已自动在 SQLite 底层剔除无效 Barcode 与空调类目数据，并筛除了累计销量为 0 的款式。*
"""
        print(f"✅ 数据提取成功！获取了 {len(summary_df)} 条汇总明细。")
        return export_text

    except Exception as e:
        print(f"❌ 数据提取过程中发生错误: {e}")
        return None
        
    finally:
        conn.close()

# --- 测试运行与保存代码块 ---
if __name__ == "__main__":
    # ========================================
    # ⚙️ 在这里修改你的配置参数
    # ========================================
    TARGET_DAYS = 60                        # 设置汇总天数 (例如: 14)
    TARGET_PLATFORMS = ['拼多多']       # 设置平台，如果想看所有平台，请设为 None
    # ========================================

    ai_data = get_ai_analysis_data(days_count=TARGET_DAYS, platforms=TARGET_PLATFORMS)
    
    if ai_data:
        # 修改为保存 .md 后缀，方便 Obsidian 渲染表格
        export_path = os.path.join(os.path.dirname(__file__), 'sales_export.md')
        with open(export_path, 'w', encoding='utf-8') as f:
            f.write(ai_data)
        print(f"🚀 极简 Markdown 报表已导出至: {export_path}")