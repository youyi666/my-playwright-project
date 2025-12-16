import cv2
import numpy as np
import os
import tkinter as tk
from tkinter import filedialog
from tkinter import messagebox

def cv_imread(file_path):
    """支持读取中文路径的图片"""
    try:
        cv_img = cv2.imdecode(np.fromfile(file_path, dtype=np.uint8), -1)
        return cv_img
    except Exception as e:
        print(f"读取文件出错: {e}")
        return None

def cv_imwrite(file_path, img):
    """支持保存图片到中文路径"""
    try:
        suffix = os.path.splitext(file_path)[1]
        is_success, im_buf_arr = cv2.imencode(suffix, img)
        if is_success:
            im_buf_arr.tofile(file_path)
            return True
        else:
            return False
    except Exception as e:
        print(f"保存文件出错: {e}")
        return False

def process_images_interactive_improved():
    # 1. 初始化文件选择
    root = tk.Tk()
    root.withdraw() # 隐藏主窗口

    print("--- 步骤 1: 选择图片 ---")
    file_paths = filedialog.askopenfilenames(
        title="选择要去除水印的图片（支持多选）",
        filetypes=[("Image files", "*.jpg *.jpeg *.png *.bmp *.tif")]
    )

    if not file_paths:
        print("未选择图片，程序退出。")
        root.destroy()
        return

    # 2. 读取第一张图片用于确定位置
    first_img_path = file_paths[0]
    first_img = cv_imread(first_img_path)

    if first_img is None:
        messagebox.showerror("错误", "无法读取第一张图片，请检查文件路径或格式。")
        root.destroy()
        return

    print("\n--- 步骤 2: 请在弹出的窗口中框选水印 ---")
    print("操作说明：")
    print("1. 鼠标左键按下并拖动，画一个矩形框，尽可能贴合地包住水印。")
    print("2. 画好后，按键盘上的【空格键】或【回车键】确认。")
    print("3. 如果画错了，按 'c' 键取消重画。")

    cv2.namedWindow("请框选水印 (按空格或回车确认)", cv2.WINDOW_NORMAL)
    # showCrosshair=True 显示准星有助于精确框选
    roi = cv2.selectROI("请框选水印 (按空格或回车确认)", first_img, showCrosshair=True, fromCenter=False)
    cv2.destroyAllWindows()

    x, y, w, h = roi

    if w == 0 or h == 0:
        print("未选择有效区域，程序退出。")
        root.destroy()
        return

    print(f"\n已锁定水印位置: x={x}, y={y}, 宽={w}, 高={h}")
    print("开始批量处理 (使用改进的算法)...")

    # 3. 批量处理所有图片
    success_count = 0
    for i, img_path in enumerate(file_paths):
        dir_name, full_file_name = os.path.split(img_path)
        file_base, file_ext = os.path.splitext(full_file_name)
        
        img = cv_imread(img_path)
        if img is None:
            continue

        img_h, img_w = img.shape[:2]
        if x + w > img_w or y + h > img_h:
            print(f"跳过 {full_file_name}: 图片尺寸太小。")
            continue

        # 创建掩膜
        mask = np.zeros(img.shape[:2], dtype="uint8")
        
        # 【改进点1】直接使用用户精确框选的矩形区域作为掩膜
        # 稍微向外扩展 3 个像素，确保覆盖边缘
        pad = 3
        mask[max(0, y-pad):min(img_h, y+h+pad), max(0, x-pad):min(img_w, x+w+pad)] = 255

        # 【改进点2】切换算法为 cv2.INPAINT_NS (基于纳维-斯托克斯方程)
        # 这种算法在处理带有流线型纹理的背景时，有时效果优于 Telea
        # 修复半径设置为 5，可以根据实际效果微调
        result = cv2.inpaint(img, mask, 5, cv2.INPAINT_NS)

        # 保存
        new_file_name = f"{file_base}_cleaned_ns{file_ext}"
        save_path = os.path.join(dir_name, new_file_name)
        
        if cv_imwrite(save_path, result):
            print(f"[{i+1}/{len(file_paths)}] 处理成功: {new_file_name}")
            success_count += 1
        else:
            print(f"[{i+1}/{len(file_paths)}] 保存失败: {full_file_name}")

    print("\n------------------------------------------------")
    messagebox.showinfo("完成", f"共处理 {len(file_paths)} 张图片\n成功保存 {success_count} 张\n请在原文件夹查看带有 '_cleaned_ns' 后缀的结果。")
    root.destroy()

if __name__ == "__main__":
    process_images_interactive_improved()