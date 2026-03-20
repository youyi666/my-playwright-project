import os
import time
import json
import sqlite3
import threading
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from openai import OpenAI
import queue

# ================= 配置区 =================
MONITOR_DIRS = [
    r"C:\Users\Administrator\Desktop",
    r"C:\Users\Administrator\Downloads"
]

api_key = os.environ.get("DEEPSEEK_API_KEY")
if not api_key:
    print("❌ 错误：未找到系统环境变量 DEEPSEEK_API_KEY。")
    exit()

client = OpenAI(
    base_url="https://api.deepseek.com", 
    api_key=api_key,
)

DB_PATH = os.path.join(MONITOR_DIRS[0], "desktop_index.db")
CONTENT_SNIPPET_LEN = 1000 
# ==========================================

SYSTEM_PROMPT = """
你是一个高效的个人数据整理助手。我将为你提供一个新文件的元数据（文件名、文件类型），对于文本类文件，我会提供一段内容片段。
请分析这些信息，必须输出一个符合JSON格式的字符串，包含以下两个字段：
1. "description": 一个简短的描述，说明文件大概是什么内容。
2. "category": 建议的分类名称，例如 'Python脚本', '日常记录md', 'Obsidian素材', '数据表格'。
不要包含任何额外的文本或解释，只输出JSON。
"""

TEXT_EXTENSIONS = {'.txt', '.md', '.js', '.py', '.json', '.csv', '.html', '.css', '.bat', '.sh'}
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


# 【基座代码】：事件监听
class DirectoryMonitorHandler(FileSystemEventHandler):
    def __init__(self, processing_queue):
        self.processing_queue = processing_queue

    def on_created(self, event):
        if event.is_directory or event.src_path == DB_PATH:
            return
        print(f"👀 检测到新文件: {os.path.basename(event.src_path)}")
        self.processing_queue.put(('create', event.src_path))

    def on_moved(self, event):
        if event.is_directory or event.src_path == DB_PATH:
            return
        print(f"🔄 检测到文件移动/重命名: 从 {os.path.basename(event.src_path)} 到 {os.path.basename(event.dest_path)}")
        self.processing_queue.put(('move', event.src_path, event.dest_path))


# 【基座代码】：初始化数据库
def init_database():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS file_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE,
            file_extension TEXT,
            ai_remarks TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()
    print(f"* 数据库索引已准备就绪: {DB_PATH}")


# 【增量模块】：查重逻辑，用于存量文件盘点前验证
def check_file_exists_in_db(file_path):
    """查询数据库中是否已存在该文件的记录"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT 1 FROM file_index WHERE file_path = ?", (file_path,))
        exists = cursor.fetchone() is not None
        return exists
    except Exception as e:
        print(f"  > [数据库查询错误]: {e}")
        return False
    finally:
        conn.close()


# 【增量模块】：启动时的存量文件全盘扫描
def scan_existing_files(queue):
    """遍历监控目录，将未收录的存量文件加入处理队列"""
    print("\n🔍 开始盘点存量文件 (这可能需要一些时间，请耐心等待)...")
    added_count = 0
    for directory in MONITOR_DIRS:
        if not os.path.exists(directory):
            continue
            
        for root, dirs, files in os.walk(directory):
            for file_name in files:
                file_path = os.path.join(root, file_name)
                
                # 跳过数据库文件自身
                if file_path == DB_PATH:
                    continue
                
                # 检查是否已经在数据库里了
                if not check_file_exists_in_db(file_path):
                    queue.put(('create', file_path))
                    added_count += 1
                    
    print(f"✅ 存量盘点完成！共发现 {added_count} 个未被 AI 分析的文件，已加入后台处理队列。\n")


# 【基座代码】：调用 AI 分析
def analyze_with_ai(file_path):
    file_name = os.path.basename(file_path)
    file_ext = os.path.splitext(file_name)[1].lower()
    content_snippet = None

    if file_ext in TEXT_EXTENSIONS:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content_snippet = f.read(CONTENT_SNIPPET_LEN)
            print(f"  > 已读取 {len(content_snippet)} 字符文本片段。")
        except UnicodeDecodeError:
            print(f"  > [警告] 无法使用UTF-8读取 {file_name}，可能包含非文本字符。")
        except Exception as e:
            print(f"  > [错误] 读取文件失败: {e}")

    user_prompt = f"文件名: {file_name}\n文件类型: {file_ext}\n"
    if content_snippet:
        user_prompt += f"内容片段:\n\"\"\"\n{content_snippet}\n\"\"\""

    print(f"  > 正在请求 DeepSeek 分析 {file_name} ...")
    try:
        response = client.chat.completions.create(
            model="deepseek-chat", 
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"}
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"  > [API 错误]: {e}")
        return json.dumps({"description": f"AI分析失败: {str(e)}", "category": "待整理"})


# 【基座代码】：保存到数据库
def save_to_database(file_path, file_ext, ai_remarks):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO file_index (file_path, file_extension, ai_remarks) VALUES (?, ?, ?)",
            (file_path, file_ext, ai_remarks)
        )
        conn.commit()
        print(f"✅ 已成功存档: {os.path.basename(file_path)}")
    except sqlite3.IntegrityError:
        pass # 队列处理中如果有重复插入，直接静默跳过
    except Exception as e:
        print(f"  > [数据库插入错误]: {e}")
    finally:
        conn.close()


# 【基座代码】：更新路径
def update_database_path(old_path, new_path):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute(
            "UPDATE file_index SET file_path = ? WHERE file_path = ?",
            (new_path, old_path)
        )
        if cursor.rowcount > 0:
            print(f"✅ 数据库路径已同步更新为: {os.path.basename(new_path)}")
        else:
            print(f"  > [提示] 未找到旧记录，将作为新文件重新分析: {os.path.basename(new_path)}")
            processing_queue.put(('create', new_path))
        conn.commit()
    except Exception as e:
        print(f"  > [数据库更新错误]: {e}")
    finally:
        conn.close()


# 【基座代码】：队列处理器
def process_queue_worker(queue):
    while True:
        task = queue.get()
        if task is None: break 

        action = task[0]

        if action == 'create':
            file_path = task[1]
            time.sleep(1) # 防抖动
            if not os.path.exists(file_path):
                print(f"  > [跳过] 文件已消失: {file_path}")
                queue.task_done()
                continue

            file_ext = os.path.splitext(file_path)[1].lower()
            ai_remarks = analyze_with_ai(file_path)
            save_to_database(file_path, file_ext, ai_remarks)

        elif action == 'move':
            old_path = task[1]
            new_path = task[2]
            update_database_path(old_path, new_path)

        queue.task_done()
        time.sleep(0.5) # 极其关键：防止存量盘点时把 API 限流打爆


if __name__ == "__main__":
    init_database()
    
    processing_queue = queue.Queue()
    worker_thread = threading.Thread(target=process_queue_worker, args=(processing_queue,), daemon=True)
    worker_thread.start()

    # 【增量模块调用】：在正式开启监听前，先盘点存量文件并将任务推入队列
    scan_existing_files(processing_queue)

    observers = []
    for directory in MONITOR_DIRS:
        if os.path.exists(directory):
            event_handler = DirectoryMonitorHandler(processing_queue)
            observer = Observer()
            observer.schedule(event_handler, directory, recursive=True) # 建议开启 recursive=True 遍历子文件夹
            observer.start()
            observers.append(observer)
            print(f"* 正在监控文件夹: {directory}")
        else:
            print(f"❌ 警告：找不到文件夹 {directory}，已跳过。")
    
    print("* 按下 Ctrl+C 可停止所有监控。")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n* 正在停止监控...")
        for o in observers:
            o.stop()
        processing_queue.put(None) 
        worker_thread.join()
        for o in observers:
            o.join()
    print("* 脚本已安全退出。")