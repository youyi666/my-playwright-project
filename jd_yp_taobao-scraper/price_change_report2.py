import sqlite3
import pandas as pd
from datetime import date
# 导入邮件相关的库
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


# --- 请在这里配置您的文件路径 ---
# 您的数据库文件
db_path = r'Z:\平台价格监控\Results\prices.db' 
# 您希望导出的CSV文件的保存路径和名称
today_str = date.today().strftime('%Y-%m-%d')
output_csv_path = f'Z:\\平台价格监控\\Results\\price_change_report_{today_str}.csv'

# 百补商品清单文件路径
products_excel_path = r'Z:\平台价格监控\products.xlsx'

# --- 邮件配置 ---
# !! 安全警告: 直接在代码中存储密码是不安全的做法。
# !! 建议使用环境变量、配置文件或在运行时输入等更安全的方式。
SMTP_SERVER = 'smtp.exmail.qq.com'
SMTP_PORT = 465
SENDER_EMAIL = 'luojunsheng@viomi.com'  # <--- 修改为您的发件人邮箱
SENDER_PASSWORD = 'HCXRGMx63n7hRt9W'      # <--- 修改为您的邮箱密码或授权码
RECIPIENT_EMAILS = ['luojunsheng@viomi.com', 'zhoulili@viomi.com']  # <--- 修改为多个收件人邮箱列表
# ---------------------------------


# 您的 SQL 查询语句 (无需改动)
sql_query = """
SELECT
    p.ProductName, 
    t1.id,
    t1.Platform,
    t1.URL,
    CAST(t1.Price AS REAL) AS latest_price,
    CAST(t2.Price AS REAL) AS previous_price,
    CAST(t1.Price AS REAL) - CAST(t2.Price AS REAL) AS price_change,
    CASE
        WHEN CAST(t1.Price AS REAL) < CAST(t2.Price AS REAL) AND CAST(t2.Price AS REAL) > 0 THEN
             printf('%.2f%%', (CAST(t2.Price AS REAL) - CAST(t1.Price AS REAL)) * 100.0 / CAST(t2.Price AS REAL))
        ELSE
             '--'
    END AS "降价幅度", -- --- 新增列 ---
    CASE
        WHEN CAST(t1.Price AS REAL) > CAST(t2.Price AS REAL) THEN '涨价'
        WHEN CAST(t1.Price AS REAL) < CAST(t2.Price AS REAL) THEN '注意，商品降价'
        ELSE 'No Change'
    END AS price_status
FROM
    price_data AS t1
JOIN
    price_data AS t2 ON t1.URL = t2.URL
JOIN
    products AS p ON t1.URL = p.URL 
WHERE
    t1.Scrape_Date = (SELECT MAX(Scrape_Date) FROM price_data)
    AND t2.Scrape_Date = (SELECT MAX(Scrape_Date) FROM price_data WHERE Scrape_Date < (SELECT MAX(Scrape_Date) FROM price_data))
    AND t1.Price <> t2.Price;
"""


def send_email_alert(alert_df):
    """
    发送邮件预警通知给多个收件人
    :param alert_df: 包含需要预警的商品信息的DataFrame
    """
    # 创建一个带附件的实例
    message = MIMEMultipart()
    message['From'] = SENDER_EMAIL
    message['To'] = ', '.join(RECIPIENT_EMAILS)  # 将多个收件人邮箱以逗号分隔
    message['Subject'] = f'【重要】多多百补商品降价预警 - {today_str}'

    # --- 邮件正文 ---
    # --- 修改处：将CSS样式中的 { 和 } 分别替换为 {{ 和 }} 来避免与 .format() 冲突 ---
    html_body = """
    <html>
    <head>
    <style>
      body {{font-family: Arial, sans-serif;}}
      table {{
        border-collapse: collapse;
        width: 100%;
        border: 1px solid #ddd;
      }}
      th, td {{
        text-align: left;
        padding: 8px;
        border-bottom: 1px solid #ddd;
      }}
      th {{
        background-color: #f2f2f2;
      }}
      tr:hover {{background-color: #f5f5f5;}}
      .price-down {{color: red; font-weight: bold;}}
    </style>
    </head>
    <body>
      <h3>您好，团队成员：</h3>
      <p>系统检测到以下【多多百补商品】出现了降价，请及时关注：</p>
      {table}
      <br>
      <p>此邮件由系统自动发送，请勿回复。</p>
    </body>
    </html>
    """.format(table=alert_df[['Platform','ProductName', 'latest_price', 'previous_price', '降价幅度', 'URL']].to_html(index=False))
    # --- 修改结束 ---

    # 将HTML内容附加到邮件中
    message.attach(MIMEText(html_body, 'html'))

    try:
        # 使用SSL连接到SMTP服务器
        print("正在连接到邮件服务器...")
        server = smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT)
        # 登录
        print("正在登录邮箱...")
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        # 发送邮件给多个收件人
        print("正在发送预警邮件...")
        server.sendmail(SENDER_EMAIL, RECIPIENT_EMAILS, message.as_string())
        print("邮件发送成功！")
    except Exception as e:
        print(f"邮件发送失败: {e}")
    finally:
        if 'server' in locals():
            server.quit()
            print("已断开与邮件服务器的连接。")


try:
    # 1. 连接到 SQLite 数据库
    conn = sqlite3.connect(db_path)

    # 2. 使用 pandas 执行 SQL 查询并将结果读入 DataFrame
    df = pd.read_sql_query(sql_query, conn)

    # 3. 将完整的价格变动报表保存为 CSV 文件
    df.to_csv(output_csv_path, index=False, encoding='utf-8-sig')
    print(f"成功！完整价格变动报表已导出到: {output_csv_path}")

    # 4. 执行价格预警逻辑
    if not df.empty:
        # 4.1 筛选出所有降价的商品
        df_decreased = df[df['price_status'] == '注意，商品降价'].copy()

        if not df_decreased.empty:
            print("检测到降价商品，正在匹配百补清单...")
            # 4.2 读取百补商品Excel清单
            try:
                df_products_excel = pd.read_excel(products_excel_path)
                
                # 4.3 将降价商品与百补清单进行合并（基于URL）
                alert_merged_df = pd.merge(
                    df_decreased,
                    df_products_excel[['URL', '多多百补商品']],
                    on='URL',
                    how='inner'
                )

                # 4.4 筛选出“多多百补商品”列为“是”的商品
                final_alert_df = alert_merged_df[alert_merged_df['多多百补商品'] == '是']

                # 4.5 如果存在需要预警的商品，则发送邮件
                if not final_alert_df.empty:
                    print(f"发现 {len(final_alert_df)} 个需要预警的百补降价商品，准备发送邮件...")
                    send_email_alert(final_alert_df)
                else:
                    print("所有降价商品均不在百补清单内，无需发送邮件。")

            except FileNotFoundError:
                print(f"错误：无法找到百补商品清单文件，路径: {products_excel_path}")
            except Exception as e:
                print(f"处理百补商品清单时出错: {e}")
        else:
            print("未检测到任何降价商品。")
    else:
        print("数据库中没有检测到任何价格变动。")


except Exception as e:
    print(f"脚本执行出现错误: {e}")

finally:
    # 5. 关闭数据库连接
    if 'conn' in locals() and conn:
        conn.close()