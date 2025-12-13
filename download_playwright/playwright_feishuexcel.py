import pandas as pd
import pyperclip  # 用于操作剪贴板
from playwright.sync_api import sync_playwright
import time
import os

# ================= 配置区域 =================
# 1. 本地Excel路径 (请改为你的实际路径)
LOCAL_EXCEL_PATH = r"D:\我的数据\data.xlsx" 

# 2. 飞书表格的网址 (打开你的飞书表格，直接复制浏览器地址栏)
FEISHU_URL = "https://gcnvnjknbgm5.feishu.cn/wiki/CnAGwVCjJihkGRkMxFPcbyNMnnd?from=from_copylink"

# 3. 浏览器缓存路径 
# 脚本会自动创建这个文件夹来保存你的登录状态
# 注意：不要指向你系统默认的 Edge User Data，否则会报错
USER_DATA_DIR = r"D:\feishu_edge_data" 
# ===========================================

def sync_excel_to_feishu():
    # --- 第一步：读取本地 Excel 并转为剪贴板格式 ---
    print("正在读取本地 Excel...")
    try:
        # 读取 Excel
        df = pd.read_excel(LOCAL_EXCEL_PATH, header=None)
        # 将 NaN (空值) 替换为空字符串
        df = df.fillna("")
        
        # 转为制表符分隔文本 (模拟 Excel 复制)
        # header=False 表示不包含表头，如果你想连表头一起更新，改为 True
        copy_text = df.to_csv(sep='\t', index=False, header=False)
        
        # 写入剪贴板
        pyperclip.copy(copy_text)
        print(f"已读取 {len(df)} 行数据并复制到剪贴板。")
    except Exception as e:
        print(f"读取 Excel 失败，请检查路径: {e}")
        return

    # --- 第二步：启动 Edge 浏览器 ---
    print("正在启动 Edge 浏览器...")
    with sync_playwright() as p:
        # 关键修改点：channel="msedge" 指定使用 Edge
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR, 
            channel="msedge",  # <--- 这里指定使用 Edge
            headless=False,    # 显示浏览器界面
            args=["--start-maximized"], # 启动时最大化
            no_viewport=True   # 禁用默认视口大小限制
        )
        
        page = context.pages[0]
        
        # 访问飞书表格
        print(f"正在打开飞书表格: {FEISHU_URL}")
        page.goto(FEISHU_URL, timeout=60000, wait_until='domcontentloaded')
        
        # --- 第三步：人工介入环节 (仅第一次需要) ---
        print("等待页面加载...")
        # 给足时间检查登录状态
        # 如果你运行脚本发现页面跳到了登录页，请在15秒内手动扫码/输入密码
        # 登录成功后，下次运行这里就会直接跳过
        time.sleep(5) 

        # --- 第四步：定位并操作表格 ---
        try:
            print("正在定位表格区域...")
            
            # 【核心修改点 1】：调整坐标
            # Wiki 页面上方有标题，左边有目录。
            # 我们尝试点击屏幕偏右下方的位置，比如 x=600, y=500
            # 这样大概率能点中正文里的表格
            page.mouse.click(600, 500) 
            time.sleep(1)
            
            # 【核心修改点 2】：增加一次点击，确保激活
            # 有时候点一下只是选中了文档块，再点一下才能进入表格编辑模式
            page.mouse.click(600, 500)
            time.sleep(1)

            # 1. 尝试回到左上角
            page.keyboard.press("Control+Home")
            time.sleep(1)

            # --- 增加一个人工确认时间 ---
            print("【请看屏幕】是否已经选中了表格里的单元格？(等待5秒)")
            time.sleep(1) 
            # 如果你这时候看屏幕，发现光标不在表格里，赶紧手动点一下表格！

            # 2. 全选 (Ctrl + A)
            print("正在清空旧数据...")
            page.keyboard.press("Control+A")
            time.sleep(0.5)
            page.keyboard.press("Control+A") # Wiki 表格有时候需要按两次
            time.sleep(0.5)
            
            # 3. 删除
            page.keyboard.press("Backspace") 
            time.sleep(1)
            
            # 4. 回到 A1 准备粘贴
            page.keyboard.press("Control+Home")
            time.sleep(1)
            
            # --- 第五步：粘贴 ---
            print("正在粘贴...")
            page.keyboard.press("Control+V")
            
            # 数据量大时，Wiki 的同步比普通表格慢，多等一会儿
            print("等待飞书保存...")
            time.sleep(10) 
            
            print("同步完成！")

        except Exception as e:
            print(f"操作飞书时出错: {e}")
            # 截图保存错误现场，方便调试
            page.screenshot(path="error_screenshot.png")
        
        # 脚本运行结束后关闭浏览器
        # 如果你想保留窗口查看结果，可以把下面这行注释掉
        context.close() 

if __name__ == "__main__":
    sync_excel_to_feishu()