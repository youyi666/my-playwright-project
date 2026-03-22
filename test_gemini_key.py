import google.generativeai as genai
import os
import time

# 代理配置
os.environ['http_proxy'] = "http://127.0.0.1:7897"
os.environ['https_proxy'] = "http://127.0.0.1:7897"

genai.configure(api_key="AIzaSyDaOVNeJtdgjonuUtcRLq465Mfeu31hqBo")
model = genai.GenerativeModel('gemini-2.5-flash')

def long_term_test(duration_minutes=5):
    print(f"⏳ 开始执行 {duration_minutes} 分钟长效测试...")
    start_time = time.time()
    end_time = start_time + (duration_minutes * 60)
    
    total_success = 0
    total_attempts = 0
    
    # 建议设置一个略低于测得 RPM 的间隔，比如 5 秒一次 (12 RPM)
    # 看看在 5 分钟内是否能持续稳定
    interval = 5 

    while time.time() < end_time:
        total_attempts += 1
        try:
            # 模拟稍微复杂一点的问题，测试稳定性
            response = model.generate_content("请简短回答：1+1等于几？", request_options={"timeout": 15})
            total_success += 1
            elapsed = time.time() - start_time
            print(f"[{int(elapsed)}s] ✅ 成功 {total_success}/{total_attempts}")
        except Exception as e:
            print(f"[{int(time.time()-start_time)}s] ❌ 失败: {e}")
            if "429" in str(e):
                print("⚠️ 触发频率限制，正在冷却 10 秒...")
                time.sleep(10)
        
        time.sleep(interval)

    print("\n" + "="*30)
    print(f"🏁 测试结束！")
    print(f"统计：5分钟内成功请求 {total_success} 次")
    print(f"平均有效频率: {total_success / duration_minutes} RPM")
    print("="*30)

long_term_test(5)