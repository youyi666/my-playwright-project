import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timedelta

# --- 设置中文字体 (请根据你的系统调整) ---
# Windows 用户通常使用 SimHei 或 Microsoft YaHei
plt.rcParams['font.sans-serif'] = ['SimHei'] 
# Mac 用户请取消下一行的注释:
# plt.rcParams['font.sans-serif'] = ['Arial Unicode MS'] 
plt.rcParams['axes.unicode_minus'] = False

def draw_optimized_roadmap_v3():
    # 1. 画布设置 (加宽画布比例，适合PPT)
    fig, ax = plt.subplots(figsize=(18, 9)) 

    # 2. 数据配置 (修正日期错误：2026年2月只有28天)
    tasks = [
        {
            "phase": "第一阶段: 首发测款",
            "start": datetime(2025, 12, 1),
            "end": datetime(2025, 12, 31),
            "color": "#F4B183",  # 柔和橙
            "content": "战略: 练内功 / 测模型\n动作: 站内推广 + 评价维护\n目标: 1,500 台"
        },
        {
            "phase": "第二阶段: 年货爆发",
            "start": datetime(2026, 1, 1),
            "end": datetime(2026, 2, 28), # 修正：2026年不是闰年，改为28日
            "color": "#8FAADC",  # 柔和蓝
            "content": "战略: 抢红利 / 冲爆发\n动作: 年货心智 + 节后租房 + 百补\n目标: 8,500 台"
        },
        {
            "phase": "第三阶段: 全渠道放量",
            "start": datetime(2026, 3, 1),
            "end": datetime(2026, 12, 31),
            "color": "#A9D18E",  # 柔和绿
            "content": "战略: 扩地盘 / 冲销量\n动作: 站外种草 + 品牌大促 + 线下分销\n目标: 140,000 台"
        }
    ]

    # 3. 绘图参数
    y_positions = [3, 2, 1]  # Y轴位置
    bar_height = 0.7         # 增加高度

    # 4. 循环绘制
    for i, task in enumerate(tasks):
        start_date_num = mdates.date2num(task["start"])
        end_date_num = mdates.date2num(task["end"])
        duration_num = end_date_num - start_date_num
        
        # 绘制矩形条
        ax.barh(y_positions[i], duration_num, left=start_date_num, height=bar_height,
                align='center', color=task["color"], edgecolor='white', alpha=0.9)
        
        # --- 文字处理优化 ---
        
        # A. 阶段标题 (放在条形图上方，加粗)
        ax.text(start_date_num, y_positions[i] + bar_height/2 + 0.08, 
                task["phase"],
                fontsize=13, fontweight='bold', color='#333333', ha='left', va='bottom')
        
        # B. 详细内容 (放在条形图内部)
        # 动态调整字体大小
        content_font_size = 9.5 
        content_x_offset = 0
        
        if task["phase"] == "第一阶段: 首发测款": 
            content_font_size = 9 
            content_x_offset = 1.5 
        elif task["phase"] == "第二阶段: 年货爆发": 
            content_font_size = 9.5
            content_x_offset = 1 
        else: 
            content_font_size = 10 
            content_x_offset = 3 

        ax.text(start_date_num + content_x_offset, y_positions[i],
                task["content"],
                fontsize=content_font_size, color='black', ha='left', va='center', linespacing=1.6)

    # 5. X轴时间轴格式化
    ax.set_xlim([mdates.date2num(datetime(2025, 11, 25)), mdates.date2num(datetime(2027, 1, 5))]) 
    ax.xaxis.set_major_locator(mdates.MonthLocator())            
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))  
    plt.xticks(rotation=0, fontsize=10)

    # 6. 美化图表
    ax.set_yticks([]) 
    ax.set_ylim(0.5, 3.5) 
    
    ax.spines['top'].set_visible(False)    
    ax.spines['right'].set_visible(False)  
    ax.spines['left'].set_visible(False)   
    ax.spines['bottom'].set_color('gray') 
    ax.tick_params(axis='x', colors='gray') 

    ax.grid(True, axis='x', linestyle='--', alpha=0.4, color='lightgray')

    plt.title('499元战略新品分阶段上市节奏规划 (2025.12 - 2026.12)', fontsize=18, pad=30, fontweight='bold', color='#333333')

    plt.tight_layout()
    
    plt.savefig('roadmap_optimized_v3.png', dpi=300)
    print("修正后的图片已生成: roadmap_optimized_v3.png")
    plt.show()

if __name__ == "__main__":
    draw_optimized_roadmap_v3()