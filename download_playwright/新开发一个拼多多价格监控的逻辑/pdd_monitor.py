import uiautomator2 as u2
import time
import os

def pdd_dump_all_info():
    # --- 环境初始化 ---
    print("【系统日志】正在连接 iQOO Z10x 设备...")
    d = u2.connect('10AF8S30RS004CB')
    d.implicitly_wait(10.0)
    print("【系统日志】设备连接成功！")

    try:
        # --- 反爬与防风控策略 ---
        # 电商平台对静态页面的高频请求敏感，先做一次极其微小的滑动（像素级），骗过静止检测
        print("【防风控动作】执行像素级防风控微调滑动...")
        d.swipe(500, 1000, 500, 950, duration=0.2) 
        time.sleep(1) # 等待页面 UI 树刷新稳定
        
        print("【抓取动作】开始扫描当前屏幕所有文本节点...")
        start_time = time.time()
        
        # --- 核心抓取逻辑：无差别遍历 ---
        # 在安卓底层，绝大部分可见文本都存放在 className 为 android.widget.TextView 的节点中
        text_elements = d(className="android.widget.TextView")
        
        extracted_data = []
        for elem in text_elements:
            # 尝试提取文本，并去除前后空格
            text_content = elem.get_text().strip()
            # 过滤掉空字符串
            if text_content:
                extracted_data.append(text_content)
                
        end_time = time.time()
        
        # --- 结果输出 ---
        print(f"\n====== 抓取结果汇总 (耗时: {round(end_time - start_time, 2)}秒) ======")
        print(f"共发现 {len(extracted_data)} 条文本信息：\n")
        
        for i, info in enumerate(extracted_data, 1):
            # 打印抓取到的每一条信息，如果是价格、标签或标题，这里都会原形毕露
            print(f"节点 [{i:02d}]: {info}")
            
        print("\n=======================================================")

    except Exception as e:
        print(f"【异常报警】抓取过程中发生严重错误: {e}")
        # --- 容错与现场保留 ---
        error_img = f"error_dump_{int(time.time())}.png"
        try:
            d.screenshot(error_img)
            print(f"【现场保留】已保存崩溃截图至: {os.path.abspath(error_img)}")
        except Exception as snap_e:
            print(f"【严重错误】无法进行错误截图: {snap_e}")
            
        # 复杂 UI 阻挡处理建议：若因弹窗导致抓取不到底层，需定位弹窗的纯文本节点（如“残忍拒绝”）或关闭 icon
        print("【调试建议】请检查是否有全屏弹窗或浮层阻挡了底层 UI 树的渲染。")

    finally:
        print("【系统日志】无差别抓取验证任务结束。")

if __name__ == "__main__":
    pdd_dump_all_info()