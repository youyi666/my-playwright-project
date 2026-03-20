import os
import hashlib
from collections import defaultdict

# ================= 配置区 =================
# 1. 需要扫描的文件夹（与你的监控目录保持一致）
SCAN_DIRS = [
    r"C:\Users\Administrator\Desktop",
    r"C:\Users\Administrator\Downloads"
]

# 2. 报告输出路径
REPORT_PATH = r"C:\Users\Administrator\Desktop\重复文件核实报告.md"
# ==========================================

def get_file_md5(filepath, chunk_size=8192):
    """计算文件的 MD5 唯一特征码，分块读取防止大文件撑爆内存"""
    hasher = hashlib.md5()
    try:
        with open(filepath, 'rb') as f:
            for chunk in iter(lambda: f.read(chunk_size), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except Exception as e:
        print(f"  > [警告] 无法读取文件 {filepath}: {e}")
        return None

def format_size(size_bytes):
    """将字节数转换为人类可读的格式"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.2f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"

def scan_and_report():
    print("🔍 第一阶段：按文件大小进行初步分组...")
    size_dict = defaultdict(list)
    total_files = 0
    
    for directory in SCAN_DIRS:
        if not os.path.exists(directory):
            print(f"❌ 找不到目录: {directory}")
            continue
            
        for root, _, files in os.walk(directory):
            for filename in files:
                filepath = os.path.join(root, filename)
                try:
                    # 忽略生成的报告文件本身和之前的数据库
                    if filename in ["重复文件核实报告.md", "desktop_index.db"]:
                        continue
                        
                    file_size = os.path.getsize(filepath)
                    # 忽略 0 字节的空文件
                    if file_size > 0:
                        size_dict[file_size].append(filepath)
                        total_files += 1
                except Exception as e:
                    pass

    print(f"* 共扫描到 {total_files} 个有效文件。")
    
    # 筛选出大小相同的文件组（只有大小相同，才可能内容相同）
    potential_duplicates = {size: paths for size, paths in size_dict.items() if len(paths) > 1}
    print(f"🔍 第二阶段：发现 {len(potential_duplicates)} 组大小相同的文件，正在计算 MD5 特征码进行精准比对...")

    exact_duplicates = defaultdict(list)
    for size, paths in potential_duplicates.items():
        for filepath in paths:
            file_md5 = get_file_md5(filepath)
            if file_md5:
                # 以 "文件大小_MD5" 作为绝对唯一标识
                unique_key = f"{size}_{file_md5}"
                exact_duplicates[unique_key].append(filepath)

    # 过滤出真正重复的文件（MD5相同的路径数量 > 1）
    final_duplicates = {k: v for k, v in exact_duplicates.items() if len(v) > 1}
    
    print(f"\n✅ 扫描完成！共发现 {len(final_duplicates)} 组完全重复的文件。")
    print(f"📝 正在生成 Markdown 报告: {REPORT_PATH}")
    
    # 生成排版精良的 Markdown 报告
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as f:
            f.write("# 📂 本地重复文件核实报告\n\n")
            f.write("> **强烈提醒**：本报告仅为扫描结果，尚未执行任何删除操作。<br>\n")
            f.write("> 请核实以下表格，确认无误后，我们将使用保留策略（如保留最早创建的文件）进行自动清理。\n\n")
            
            if not final_duplicates:
                f.write("🎉 **太棒了！您的文件夹中没有发现完全重复的文件。**\n")
                return

            group_num = 1
            for key, paths in final_duplicates.items():
                size_bytes = int(key.split("_")[0])
                formatted_size = format_size(size_bytes)
                
                f.write(f"### 🛑 重复组 {group_num} (文件大小: {formatted_size})\n")
                f.write("| 状态建议 | 文件名 | 创建时间 | 快捷操作 |\n")
                f.write("| :--- | :--- | :--- | :--- |\n")
                
                # 按文件创建时间排序，方便后续保留最早的“源文件”
                paths.sort(key=lambda x: os.path.getctime(x))
                
                for i, filepath in enumerate(paths):
                    filename = os.path.basename(filepath)
                    ctime = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getctime(filepath)))
                    # 生成本地可点击的文件链接格式 file:///
                    safe_path = filepath.replace('\\', '/')
                    file_link = f"[点击核实](file:///{safe_path})"
                    
                    if i == 0:
                        status = "🟢 <font color='green'>建议保留 (最早创建)</font>"
                    else:
                        status = "🔴 <font color='red'>建议删除</font>"
                        
                    f.write(f"| {status} | `{filename}` | {ctime} | {file_link} |\n")
                
                f.write("\n---\n\n")
                group_num += 1
                
    except Exception as e:
        print(f"❌ 写入报告失败: {e}")

if __name__ == "__main__":
    import time
    scan_and_report()