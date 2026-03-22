import os

# 配置项：请将此处替换为你存放 50GB 漫画的真实根目录路径
# 例如：r"F:\my-playwright-project\Comic_Downloads"
TARGET_DIR = r"F:\my-playwright-project\Comic_Downloads\Finish_Category"
# 导出的清单文件名
OUTPUT_FILE = "manga_library_list.txt"

def scan_and_export_library(target_directory, output_filepath):
    """
    执行深度扫描，剥离无用文件，提取核心资产名称并持久化写入。
    """
    print(f"[*] 开始扫描目标雷达区域: {target_directory}")
    
    if not os.path.exists(target_directory):
        print(f"[!] 致命错误：路径 {target_directory} 不存在，请检查物理连结。")
        return

    manga_names = set() # 使用集合自动去重，防止同一个漫画的多个卷宗重复记录

    # 遍历根目录下的第一层子对象（通常漫画是以独立文件夹或单文件压缩包存在）
    try:
        for item in os.listdir(target_directory):
            item_path = os.path.join(target_directory, item)
            
            # 逻辑分支 1：如果是独立文件夹，文件夹名即为漫画名
            if os.path.isdir(item_path):
                manga_names.add(item)
                
            # 逻辑分支 2：如果是打包好的 CBZ/ZIP/CBR 文件，剥离后缀提取漫画名
            elif os.path.isfile(item_path) and item.lower().endswith(('.cbz', '.zip', '.cbr')):
                # 剥离最后的扩展名
                base_name = os.path.splitext(item)[0]
                # 有些打包习惯可能会加上 Chapter_x 等后缀，这里提取最原始的文件名
                manga_names.add(base_name)
                
    except PermissionError:
        print("[!] 权限拒绝：系统阻断了对该目录的读取。")
        return

    if not manga_names:
        print("[-] 扫描完毕，未发现有效资产。")
        return

    print(f"[+] 资产清点完成，共发现 {len(manga_names)} 个独立 IP。")
    print(f"[*] 正在将资产快照写入缓冲文件: {output_filepath}")

    # 持久化写入磁盘，强制使用 UTF-8 防止日文/繁体乱码
    try:
        with open(output_filepath, 'w', encoding='utf-8') as f:
            for name in sorted(manga_names): # 排序输出，符合人类阅读直觉
                f.write(f"{name}\n")
        print(f"[√] 快照生成成功，请在当前脚本目录下查看 {output_filepath}。")
    except Exception as e:
        print(f"[!] 写入失败，底层错误: {e}")

if __name__ == "__main__":
    scan_and_export_library(TARGET_DIR, OUTPUT_FILE)