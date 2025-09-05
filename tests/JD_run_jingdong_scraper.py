# -*- coding: utf-8 -*-
# ================================================================================
# 京东平台 价格监控脚本 (v10.1 - SQLite UPSERT版)
#
# 更新日志 (v10.1):
# 1. [核心改造] 重写 save_results_to_db 函数，放弃 pandas.to_sql 和手动DELETE去重。
# 2. [功能增强] 采用 SQLite 的 INSERT...ON CONFLICT...DO UPDATE 逻辑 (UPSERT)。
# 3. [业务逻辑] 实现“如果某商品当天已有记录，则更新其价格为最新抓取的价格”，满足了新需求。
# 4. [健壮性] 新逻辑不再依赖 'id' 列进行操作，从根本上解决了最初的 'no such column' 崩溃问题。
# ================================================================================
import pandas as pd
import os
import time
import re
import json
import sqlite3
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# ============================================================================
# --- 配置区 (保持和您原来的一致) ---
# ============================================================================
EXCEL_TASK_FILE_PATH = 'Z:\\平台价格监控\\products.xlsx'
# 结果文件：所有平台的数据都将写入这个统一的数据库文件
DB_OUTPUT_PATH = 'Z:\\平台价格监控\\Results\\prices.db'

URL_COLUMN_HEADER = "URL"
PLATFORM_COLUMN_HEADER = "Platform"
PLATFORM_NAME = "京东"

# 数据库表中的列名
PRICE_COLUMN_HEADER = "Price"
DATE_COLUMN_HEADER = "Scrape_Date" # 修改列名以示区分
SKU_COLUMN_HEADER = "SKU_Identifier" # 新增统一的SKU列

def setup_database(db_path):
    """
    确保数据库和表存在。如果不存在，则创建。
    (此函数与您的原始代码完全相同)
    """
    output_dir = os.path.dirname(db_path)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"   创建了新目录: {output_dir}")
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    # 创建一个能兼容所有爬虫结果的表结构
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS price_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            Platform TEXT,
            URL TEXT,
            SKU_Identifier TEXT,
            Price TEXT,
            Scrape_Date TEXT,
            Main_Image_URL TEXT,
            -- 保留原始任务文件中的所有列，以防需要
            -- 使用 ALTER TABLE 在需要时添加更多列
            UNIQUE(Platform, URL, SKU_Identifier, Scrape_Date)
        )
    ''')
    conn.commit()
    conn.close()

# ================================================================================
# --- 这里是本次修改的核心区域 ---
# ================================================================================
def save_results_to_db(db_path, new_records):
    """
    将数据通过 UPSERT (Update or Insert) 方式写入到SQLite数据库。
    - 如果记录不存在（基于UNIQUE约束），则插入新行。
    - 如果记录已存在，则只更新其 'Price' 字段为新值。
    :param db_path: 目标数据库文件路径
    :param new_records: 本次需要追加的新数据 (一个字典列表)
    """
    if not new_records:
        print("   没有新的记录需要保存。")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 定义SQL的UPSERT语句
    # 核心逻辑:
    # 1. INSERT OR IGNORE: 先尝试插入，如果UNIQUE约束冲突（记录已存在），则忽略插入，避免报错。
    #    这一步是为了确保所有本次抓取的商品在数据库中都有一条记录。
    # 2. ON CONFLICT(...) DO UPDATE...: 这是SQLite处理冲突的语法。
    #    - ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date): 定义了判断冲突的唯一键。
    #    - DO UPDATE SET Price = excluded.Price: 如果冲突发生，执行更新操作。
    #      `excluded.Price` 是一个特殊语法，代表了试图插入但失败了的那条数据中的 `Price` 值。
    sql_upsert = '''
        INSERT INTO price_data (Platform, URL, SKU_Identifier, Price, Scrape_Date, Main_Image_URL)
        VALUES (:Platform, :URL, :SKU_Identifier, :Price, :Scrape_Date, :Main_Image_URL)
        ON CONFLICT(Platform, URL, SKU_Identifier, Scrape_Date) 
        DO UPDATE SET Price = excluded.Price;
    '''
    
    try:
        # 使用 executemany 可以高效地执行多次相同的SQL语句，它会自动遍历列表中的每个字典
        # 字典的key会自动匹配SQL语句中 `:key` 格式的占位符
        cursor.executemany(sql_upsert, new_records)
        conn.commit()
        # cursor.rowcount 会返回受影响的总行数（包括插入和更新）
        print(f"   数据库操作成功: {cursor.rowcount} 条记录被插入或更新。")
    except Exception as e:
        print(f"   写入数据库时发生错误: {e}")
    finally:
        conn.close()
# ================================================================================
# --- 核心修改区域结束 ---
# ================================================================================


def main():
    """
    主执行函数 (此函数与您的原始代码完全相同)
    """
    print(f"--- 京东监控脚本 (v10.1 - SQLite UPSERT版) 启动 ---")
    
    # 0. 初始化数据库
    setup_database(DB_OUTPUT_PATH)
    print(f"[PREP] 数据库 '{DB_OUTPUT_PATH}' 已准备就绪。")
    
    # 1. 读取任务文件
    try:
        all_tasks_df = pd.read_excel(EXCEL_TASK_FILE_PATH)
        print(f"[1/4] 成功从 '{EXCEL_TASK_FILE_PATH}' 读取 {len(all_tasks_df)} 条总任务。")
    except FileNotFoundError:
        print(f"致命错误: 任务文件未找到! 请检查路径: '{EXCEL_TASK_FILE_PATH}'")
        return
    except Exception as e:
        print(f"错误: 读取任务文件时出错: {e}")
        return

    # 2. 筛选平台任务
    platform_tasks_df = all_tasks_df[all_tasks_df[PLATFORM_COLUMN_HEADER] == PLATFORM_NAME].copy()
    if platform_tasks_df.empty:
        print(f"任务文件中没有找到平台为“{PLATFORM_NAME}”的任务，脚本结束。")
        return
    
    tasks_to_run = platform_tasks_df.to_dict('records')
    print(f"   筛选出 {len(tasks_to_run)} 条 “{PLATFORM_NAME}” 平台的任务。")
    
    # 3. 准备浏览器和会话
    today_str = datetime.now().strftime('%Y-%m-%d')
    new_records_this_session = []

    try:
        with sync_playwright() as p:
            print("[2/4] 正在连接到已登录的浏览器...")
            browser = p.chromium.connect_over_cdp("http://localhost:9222")
            context = browser.contexts[0]
            page = context.new_page()
            print("SUCCESS: 浏览器连接成功。\n")

            print(f"[3/4] 开始处理商品... (日期: {today_str})")
            for index, task in enumerate(tasks_to_run):
                url = task.get(URL_COLUMN_HEADER)
                if not isinstance(url, str) or not url.startswith('http'):
                    print(f"--- 跳过第 {index + 1} 行: URL '{url}' 无效 ---")
                    continue
                
                print(f"--- 正在处理第 {index + 1}/{len(tasks_to_run)} 行: {url[:60]}... ---")
                
                # 构建符合数据库结构的记录
                # 注意：这里的key (如'Platform') 必须和上面的SQL语句中的占位符 (:Platform) 完全对应
                new_record = {
                    'Platform': task.get(PLATFORM_COLUMN_HEADER),
                    'URL': url,
                    'SKU_Identifier': 'default',
                    'Price': 'Error', 
                    'Scrape_Date': today_str,
                    'Main_Image_URL': None
                }
                
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    
                    final_price = "Not Found"
                    price_found_by_css = False
                    
                    selectors_to_try = [
                        ("#J_FinalPrice .price", "促销价"),
                        (".J-presale-price", "预售价"),
                        (".p-price .price", "日常价")
                    ]
                    
                    for selector, price_type in selectors_to_try:
                        try:
                            price_element = page.locator(selector).first
                            price_text = price_element.text_content(timeout=2000)
                            if price_text and price_text.strip():
                                final_price = price_text.strip()
                                print(f"   [OK] 价格 ({price_type}定位): {final_price}")
                                price_found_by_css = True
                                break
                        except PlaywrightTimeoutError:
                            continue

                    if not price_found_by_css:
                        print(f"   INFO: 所有CSS定位失败, 启动最终方案 (源码解析)...")
                        try:
                            page_source = page.content()
                            match = re.search(r'var pageConfig = ({.*?});', page_source, re.S)
                            if match:
                                json_str = re.sub(r'//.*', '', match.group(1))
                                page_data = json.loads(json_str)
                                price = page_data.get('price', {}).get('p')
                                if price:
                                    final_price = price
                                    print(f"   [OK] 价格 (源码解析): {final_price}")
                            else:
                                final_price = "Not Found (Config)"
                        except Exception:
                             final_price = "Error (Source Parse)"

                    new_record['Price'] = final_price

                except PlaywrightTimeoutError as e:
                    print(f"   [ERROR] 页面加载超时: {e.message.splitlines()[0]}")
                    new_record['Price'] = "Page Timeout"
                except Exception as e:
                    print(f"   [ERROR] 页面处理失败: {str(e).splitlines()[0]}")
                    new_record['Price'] = "Page Error"
                
                new_records_this_session.append(new_record)

    except Exception as e:
        print(f"\n--- 任务循环中发生严重错误 ---: {e}")
        print("提示：请确保您已通过修改后的快捷方式启动Edge浏览器，并且不要关闭它。")
    
    finally:
        print("\n[4/4] 正在执行最终保存操作...")
        save_results_to_db(DB_OUTPUT_PATH, new_records_this_session)
        # 这里修改了最终的输出信息，使其更清晰
        print(f"[SUCCESS] 脚本执行完毕。本次抓取的 {len(new_records_this_session)} 条记录已成功同步至数据库 '{DB_OUTPUT_PATH}'。")


if __name__ == '__main__':
    # input(">>> 请确认已启动调试模式的Edge浏览器并手动登录，然后按Enter键开始执行脚本...")
    main()