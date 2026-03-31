import os
import time
import asyncio
import requests
import zipfile
import shutil  
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

# 配置项
BASE_URL = "https://comic.hmgal.com"
CATEGORY_URL = "https://comic.hmgal.com/index.php/category/finish/2"
ROOT_SAVE_DIR = r"D:\commic"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Referer": "https://comic.hmgal.com/"
}

# ================= 保持原有的底层处理功能不变 =================

async def download_image(img_url, path, session, current_idx, total, semaphore):
    """
    【增量模块：AOE高并发引擎】加入信号量控制与原生异步线程池封装
    """
    # 信号量控制：拿到通行证的才能进行下载，防止瞬间并发过高被服务器拉黑
    async with semaphore:
        try:
            # 必须用 asyncio.to_thread 把阻塞的 requests.get 扔进后台线程，彻底释放事件循环的性能
            resp = await asyncio.to_thread(session.get, img_url, headers=HEADERS, timeout=15)
            if resp.status_code == 200:
                with open(path, 'wb') as f:
                    f.write(resp.content)
                # 打印日志（注：并发情况下此处的打印大概率是乱序的）
                print(f"    [+] 下载完成 {current_idx:03d}/{total} ...")
                return True
        except Exception as e:
            print(f"    [X] 下载失败 {img_url}: {e}")
    return False

def package_to_cbz(source_dir, output_filename):
    """
    【基座代码】：将下载的散装图片文件夹打包为标准的 CBZ 漫画格式，便于多设备同步和沉浸式观看。
    """
    print(f"\n[打包阶段] 正在将 {source_dir} 封装为 {output_filename}...")
    try:
        with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as cbz:
            for root, _, files in os.walk(source_dir):
                for file in sorted(files):
                    if file.endswith(('.jpg', '.png', '.webp', '.jpeg')):
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path, source_dir)
                        cbz.write(file_path, arcname)
        print(f"[打包完成] 您现在可以将 {output_filename} 发送到任何设备上观看了。")
        
        try:
            shutil.rmtree(source_dir)
            print(f"[清理完成] 🧹 已彻底删除散装图片源文件夹，释放硬盘空间: {source_dir}")
        except Exception as del_e:
            print(f"[清理异常] 无法删除文件夹 {source_dir}，错误信息: {del_e}")

    except Exception as e:
        print(f"[打包失败] 错误信息: {e}")

# ================= 大规模调度与断点续传逻辑 =================

async def parse_comic_detail_to_chapters(page, comic_url):
    """
    【基座代码】解析漫画详情页，提取所有章节链接，并处理排序。
    """
    print(f"  [-] 正在解析漫画详情页，准备提取章节: {comic_url}")
    await page.goto(comic_url, wait_until="domcontentloaded")
    await page.wait_for_timeout(2000) 
    
    content = await page.content()
    soup = BeautifulSoup(content, 'html.parser')
    
    chapter_urls = []
    links = soup.find_all('a', class_='j-chapter-link')
    for link in links:
        href = link.get('href')
        if href:
            chapter_urls.append(BASE_URL + href)
            
    chapter_urls.reverse()
    return chapter_urls

async def process_single_chapter(page, session, chapter_url, save_dir, cbz_path):
    """
    章节处理核心机制。
    """
    # 【基座代码】：章节级防重复
    if os.path.exists(cbz_path):
        print(f"  [*] 发现已存在完整归档 {cbz_path}，彻底跳过该章节。")
        return

    if not os.path.exists(save_dir):
        os.makedirs(save_dir)

    print(f"  [>] 正在请求章节: {chapter_url}")
    
    try:
        await page.goto(chapter_url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(1000) 
        
        content = await page.content()
        soup = BeautifulSoup(content, 'html.parser')
        
        images = soup.find_all('img', class_='lazy-read')
        
        if not images:
            print(f"    [!] 警告：未在页面中找到任何漫画图片，可能触发反爬或页面未加载完成。")
            await page.screenshot(path=os.path.join(save_dir, "error_no_images.png"))
            print(f"    [i] 已保存现场截图至: {save_dir}")
            return
            
        print(f"    [🚀] 瞬间解析成功！共发现 {len(images)} 张高清原图，准备集中火力并发下载。")
        
        downloaded_urls = set()
        img_index = 1
        
        # ==========================================================
        # 【增量模块：组装并发任务池】
        # 绝不让程序在此处停下等待，而是把所有要下载的图片全部挂起，统一发射
        # ==========================================================
        tasks = []
        # 防反爬核心护盾：限制最大并发数为 15，兼顾极速与安全
        semaphore = asyncio.Semaphore(15)
        
        for img in images:
            src = img.get('data-original') or img.get('data-src') or img.get('src')
            if src and src.startswith('http') and src not in downloaded_urls:
                file_ext = src.split('.')[-1].split('?')[0] 
                file_name = f"{img_index:03d}.{file_ext}"
                file_path = os.path.join(save_dir, file_name)
                
                # 【基座代码：图片级断点续传防御】
                if os.path.exists(file_path) and os.path.getsize(file_path) > 0:
                    print(f"    [=] 缓存命中，跳过已存在图片: {file_name}")
                    downloaded_urls.add(src)
                    img_index += 1
                    continue 
                
                # 核心改动：不再直接 await 等待，而是将所有下载指令全部装入任务池
                tasks.append(download_image(src, file_path, session, img_index, len(images), semaphore))
                downloaded_urls.add(src)
                img_index += 1

        # 一次性触发所有下载任务的 AOE 狂飙
        if tasks:
            print(f"    [⚡] 引擎点火！启动 {len(tasks)} 线程并发池...")
            await asyncio.gather(*tasks)
        # ==========================================================

        if img_index > 1:
            package_to_cbz(save_dir, cbz_path)
            
    except Exception as e:
        print(f"    [X] 处理章节时发生致命错误: {e}")
        try:
            await page.screenshot(path=os.path.join(save_dir, "crash_screenshot.png"))
            print(f"    [i] 已保存崩溃现场截图至: {save_dir}")
        except Exception as screen_e:
            print(f"    [i] 截图保存失败: {screen_e}")

async def main():
    if not os.path.exists(ROOT_SAVE_DIR):
        os.makedirs(ROOT_SAVE_DIR)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False) 
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})
        page = await context.new_page()

        start_page = 70 
        max_pages = 90 
        
        with requests.Session() as session:
            for page_num in range(start_page, max_pages + 1):
                current_page_url = f"{CATEGORY_URL}/page/{page_num}" if page_num > 1 else CATEGORY_URL
                print(f"\n========== 开始扫描第 {page_num} 页 ==========")
                print(f"URL: {current_page_url}")
                
                await page.goto(current_page_url, wait_until="domcontentloaded")
                await page.wait_for_timeout(2000) 

                content = await page.content()
                soup = BeautifulSoup(content, 'html.parser')
                
                comic_items = soup.find_all('a', class_='cover')
                
                if not comic_items:
                    print("未检测到漫画列表，可能已翻到尽头或被拦截。")
                    break
                
                for item in comic_items:
                    comic_href = item.get('href')
                    
                    safe_title = item.find('img').get('alt').replace('/', '_').replace('\\', '_').replace(':', '_').replace('?', '_').replace('"', '_').replace('<', '_').replace('>', '_').replace('|', '_').strip() if item.find('img') else "Unknown_Comic"
                    
                    # 【基座代码：AI 垃圾内容精准净化系统】
                    title_lower = safe_title.lower()
                    feature_tag = item.find('p', class_='comic-feature')
                    feature_text = feature_tag.get_text().strip().lower() if feature_tag else ""
                    ai_markers = ['(ai)', '（ai）', '[ai]', '【ai】', 'ai作画', 'ai作畫', 'ai图', 'ai生成', '3D   ']
                    
                    is_ai_slop = False
                    if any(marker in title_lower for marker in ai_markers) or any(marker in feature_text for marker in ai_markers):
                        is_ai_slop = True
                    elif feature_text == 'ai':
                        is_ai_slop = True

                    if is_ai_slop:
                        print(f"\n[🚫] 检测到 AI 生成内容，已清理跳过: {safe_title}")
                        continue  
                    
                    # 【基座代码：漫画级极速跳过】
                    comic_dir = os.path.join(ROOT_SAVE_DIR, safe_title)
                    if os.path.exists(comic_dir) and any(f.endswith('.cbz') for f in os.listdir(comic_dir)):
                        print(f"\n[🚀] 极速跳过：本地已检测到 [{safe_title}] 的相关归档。")
                        continue

                    comic_url = BASE_URL + comic_href
                    print(f"\n[+] 发现人类精绘漫画: {safe_title}")
                    
                    chapter_urls = await parse_comic_detail_to_chapters(page, comic_url)
                    
                    if not chapter_urls:
                        print(f"  [!] 警告：未能从 {comic_url} 提取到任何章节。")
                        continue
                    
                    for i, cap_url in enumerate(chapter_urls):
                        chapter_dir = os.path.join(ROOT_SAVE_DIR, safe_title, f"Chapter_{i+1}")
                        cbz_path = os.path.join(ROOT_SAVE_DIR, safe_title, f"Chapter_{i+1}.cbz")
                        await process_single_chapter(page, session, cap_url, chapter_dir, cbz_path)

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())