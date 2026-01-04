# ==============================================================================
# 本地最终版Pro：图文混合分析 + HTTP直连 + 批处理 + 多密钥池
# ==============================================================================

# -------------------
# 导入所有模块
# -------------------
import pandas as pd
import time
import asyncio
import json
import os
import itertools
import aiohttp
from tkinter import Tk, filedialog
# 【新】导入openpyxl来读取Excel的完整内容，包括图片
import openpyxl
# 【新】导入Pillow和相关模块来处理图片数据
from PIL import Image
import io
import base64

# -------------------
# 配置 (Configuration)
# -------------------
API_KEYS_STRING = os.getenv("GOOGLE_API_KEYS")
MODEL_NAME = "gemini-1.5-flash-latest"
# 【注意】因为图片会显著增加请求大小，建议减小批处理的规模
BATCH_SIZE = 10 
CONCURRENT_REQUESTS = 2 # 建议设置为您的API密钥数量

# 【新】定义Excel列的索引（A列为1，B列为2，以此类推）
# 您可以根据自己表格的实际情况修改
COLUMN_MAPPING = {
    'date': 2,
    'time': 3,
    'user': 1,
    'sender': 4,
    'message': 5
}


# -------------------
# 核心函数
# -------------------

# 【改动】Prompt构建函数现在只生成静态的指令部分
def create_multimodal_prompt_instructions():
    """只生成发送给API的静态指令文本。"""
    return (
        "你是一名资深的电商服务质检专家。\n"
        "我将为你提供一个JSON数组，其中包含了多个独立的、可能包含文字和图片的客户服务对话。请为数组中的**每一个**对话对象执行以下分析，并返回一个包含所有分析结果的JSON数组。\n\n"
        "**分析规则：**\n"
        "对于每一段对话（包括图片传达的信息），请判断是否符合以下任一情况：\n"
        "1. `次日4小时内未联系`: 用户在某一天咨询后，第二天再次发起咨询，但客服在第二次咨询开始后的4个小时内没有主动联系或有效回应。\n"
        "2. `专业问题错误或回复过慢`: 用户咨询了产品相关的专业技术问题（可能通过图片展示），但客服给出了错误答案，或者长时间无法回答。\n"
        "3. `用户情绪升级需回访`: 对话中用户的负面情绪（如愤怒、强烈不满、威胁投诉）有清晰的、逐步升级的过程，表明在线沟通已无法解决问题，需要安排电话回访进行安抚。\n"
        "4. `影响成交需立刻纠正`: 存在其他虽然未在上述规则中，但明显可能导致客户放弃购买、造成店铺损失的严重问题（例如，图片显示产品严重损坏但客服处理不当），需要立刻介入纠正。\n\n"
        "**输出要求（非常重要）：**\n"
        "1. 你的回复**必须**是一个JSON数组 `[]`，数组的长度必须与我提供的输入数组完全相同。\n"
        "2. 数组中的每一个对象都必须包含两个键：`conversation_id` 和 `classification`。\n"
        "3. `conversation_id` 的值必须与输入对象中的 `conversation_id` 完全一致，以便我进行匹配。\n"
        "4. `classification` 的值必须是上述四种分类之一的字符串，如果不符合任何严重情况，则其值必须为 `null`。\n"
        "5. **不要**返回任何JSON格式之外的额外说明、解释或 ```json ... ``` 标记。请直接输出纯净的JSON数组。"
    )

# 【改动】process_batch函数现在需要构建复杂的多模态请求体
async def process_batch_http(session, api_key, batch_data, batch_num):
    if not batch_data: return []

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {'Content-Type': 'application/json'}

    # 1. 准备静态指令
    instructions = create_multimodal_prompt_instructions()
    
    # 2. 准备动态的对话数据（现在包含图片）
    #    我们将把批处理数据也格式化为JSON字符串，让AI更好地理解结构
    dialogues_for_prompt = []
    for conv_id, conversation_parts in batch_data:
        # 构建一个纯文本的对话描述，图片用占位符表示
        dialogue_text_representation = ""
        image_count = 0
        for part in conversation_parts:
            if part['type'] == 'text':
                dialogue_text_representation += part['content'] + "\n"
            elif part['type'] == 'image':
                # 为每个图片创建一个唯一的引用标识符
                image_count += 1
                dialogue_text_representation += f"[附图 {image_count}]\n"
        dialogues_for_prompt.append({
            "conversation_id": conv_id,
            "dialogue_summary": dialogue_text_representation.strip()
        })
    
    dialogues_json_string = json.dumps(dialogues_for_prompt, ensure_ascii=False, indent=2)

    # 3. 构建最终的请求内容（parts列表）
    #    这个列表将包含指令、对话摘要JSON，以及所有图片数据
    final_prompt_parts = [
        {"text": instructions},
        {"text": "\n**待处理的对话批次如下：**\n"},
        {"text": f"```json\n{dialogues_json_string}\n```"},
        {"text": "\n**批次中引用的图片数据如下（请按顺序与[附图]标识对应）：**\n"}
    ]
    
    # 4. 【新】处理并添加图片数据到parts列表
    for _, conversation_parts in batch_data:
        for part in conversation_parts:
            if part['type'] == 'image':
                pil_image = part['content']
                # 将Pillow图片对象转换为Base64编码的字符串
                buffered = io.BytesIO()
                # 确定图片格式，如果没有则默认为PNG
                img_format = pil_image.format if pil_image.format else 'PNG'
                pil_image.save(buffered, format=img_format)
                img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
                
                # 添加到parts列表
                final_prompt_parts.append({
                    "inline_data": {
                        "mime_type": f"image/{img_format.lower()}",
                        "data": img_base64
                    }
                })

    # 5. 构建最终的请求体
    payload = {
        "contents": [{"parts": final_prompt_parts}],
        "generationConfig": {
            "response_mime_type": "application/json",
            "temperature": 0.1
        }
    }
    
    try:
        print(f"批次 {batch_num}: 开始处理 {len(batch_data)} 组图文对话 (使用密钥: ...{api_key[-4:]})")
        async with session.post(url, headers=headers, json=payload, params={'key': api_key}, timeout=600) as response: # 延长超时时间
            response.raise_for_status()
            response_json = await response.json()
            content_text = response_json['candidates'][0]['content']['parts'][0]['text']
            results = json.loads(content_text)
            print(f"批次 {batch_num}: 处理成功，获得 {len(results)} 条结果。")
            return results
    except Exception as e:
        print(f"批次 {batch_num}: 错误！API请求或处理时发生严重错误: {e}")
        return [{"conversation_id": conv_id, "AI-标注错误": str(e)} for conv_id, _ in batch_data]


# -------------------
# 主程序
# -------------------
async def main():
    root = Tk(); root.withdraw()
    input_file = filedialog.askopenfilename(title="请选择包含图片的聊天记录Excel文件", filetypes=(("Excel Files", "*.xlsx"),))
    if not input_file: print("未选择文件，程序已退出。"); return
    output_file = filedialog.asksaveasfilename(title="请选择保存路径", defaultextension=".xlsx", initialfile="annotated_records_with_images.xlsx", filetypes=(("Excel Files", "*.xlsx"),))
    if not output_file: print("未选择保存路径，程序已退出。"); return

    print(f"输入文件: {input_file}\n输出文件: {output_file}")

    if not API_KEYS_STRING:
        print("错误：找不到 GOOGLE_API_KEYS 环境变量。"); return
    
    api_keys = [key.strip() for key in API_KEYS_STRING.split(',') if key.strip()]
    if not api_keys:
        print("错误：环境变量 GOOGLE_API_KEYS 中没有找到有效的密钥。"); return
    print(f"成功加载 {len(api_keys)} 个API密钥。")
    
    keys_cycler = itertools.cycle(api_keys)

    # --- 1. 【全新】使用 openpyxl 读取文本和图片数据 ---
    print("正在从Excel读取文本和图片数据，这可能需要一些时间...")
    try:
        workbook = openpyxl.load_workbook(input_file)
        sheet = workbook.active

        # a. 提取所有图片并按其左上角锚定的单元格位置存储
        images = {}
        for image in sheet._images:
            # openpyxl的行和列从1开始
            row = image.anchor._from.row + 1
            # 【重要修正】openpyxl返回的image.ref本身就是一个类文件对象(BytesIO)，
            # 无需再用io.BytesIO()进行二次包装。直接传递给Pillow即可。
            images[row] = Image.open(image.ref)

        print(f"在Excel中找到了 {len(images)} 张图片。")

        # b. 逐行读取文本数据，并创建一个包含原始信息的DataFrame
        data_rows = []
        # 跳过表头
        for row_index, row_cells in enumerate(sheet.iter_rows(min_row=2), start=2):
            row_data = {key: row_cells[col - 1].value for key, col in COLUMN_MAPPING.items()}
            row_data['original_row'] = row_index # 记录原始行号
            data_rows.append(row_data)
        
        original_df = pd.DataFrame(data_rows)
        
    except Exception as e:
        print(f"错误：使用openpyxl读取Excel文件失败！- {e}")
        return

    # --- 2. 【全新】重构对话分组逻辑 ---
    print("正在根据用户和时间戳重组图文对话...")
    # a. 先给原始DataFrame分配会话编号
    original_df['时间戳'] = pd.to_datetime(original_df['date'].astype(str) + ' ' + original_df['time'].astype(str), errors='coerce')
    original_df = original_df.dropna(subset=['时间戳']).sort_values(['user', '时间戳'])
    
    conv_id = 0
    conv_ids = []
    last_user = None
    last_time = None
    gap_minutes = 10
    
    for _, row in original_df.iterrows():
        if row['user'] != last_user or (last_time and (row['时间戳'] - last_time).total_seconds() > gap_minutes * 60):
            conv_id += 1
        conv_ids.append(conv_id)
        last_user = row['user']
        last_time = row['时间戳']
    original_df['会话编号'] = conv_ids

    # b. 根据会话编号构建包含图文的对话结构
    conversations = {}
    for conv_id, group in original_df.groupby('会话编号'):
        if conv_id not in conversations:
            conversations[conv_id] = []
        for _, row in group.iterrows():
            # 添加文本部分
            sender = row['sender']
            content = str(row['message']).strip()
            if content:
                conversations[conv_id].append({
                    'type': 'text',
                    'content': f"[{row['时间戳'].strftime('%Y-%m-%d %H:%M:%S')}] {sender}: {content}"
                })
            # 如果这一行有关联的图片，添加图片部分
            if row['original_row'] in images:
                conversations[conv_id].append({
                    'type': 'image',
                    'content': images[row['original_row']]
                })

    # c. 过滤掉消息过少的对话
    min_messages = 3
    filtered_conversations = {cid: parts for cid, parts in conversations.items() if len(parts) >= min_messages}
    all_conversations_to_process = list(filtered_conversations.items())

    if not all_conversations_to_process:
        print("没有找到符合条件的有效会话进行分析。"); return
        
    batches = [all_conversations_to_process[i:i + BATCH_SIZE] for i in range(0, len(all_conversations_to_process), BATCH_SIZE)]
    
    print(f"📦 数据预处理完成，共 {len(all_conversations_to_process)} 组图文对话，分为 {len(batches)} 个批次。")
    actual_concurrency = min(len(batches), len(api_keys), CONCURRENT_REQUESTS)
    print(f"🚀 将以 {actual_concurrency} 的并发度处理这些批次...")

    # --- 3. 并发处理所有批次 ---
    all_results = []
    start_time = time.time()
    
    semaphore = asyncio.Semaphore(actual_concurrency)
    tasks = []
    from tqdm.asyncio import tqdm
    
    async with aiohttp.ClientSession() as session:
        async def worker(batch, batch_num):
            async with semaphore:
                api_key = next(keys_cycler)
                result = await process_batch_http(session, api_key, batch, batch_num)
                all_results.extend(result)

        for i, batch_data in enumerate(batches):
            tasks.append(asyncio.create_task(worker(batch_data, i + 1)))
        
        if tasks:
            await tqdm.gather(*tasks, desc="总批次处理进度")

    end_time = time.time()
    print(f"\n--- 所有批次处理完成，总耗时: {end_time - start_time:.2f} 秒 ---")

    # --- 4. 结果合并与保存 ---
    if all_results:
        label_df = pd.DataFrame(all_results).rename(columns={"classification": "AI-问题分类", "conversation_id": "会话编号"})
        
        # 将标注结果合并回我们之前创建的原始DataFrame
        final_df = original_df.merge(label_df, on="会话编号", how="left")
        # 清理辅助列
        final_df = final_df.drop(columns=['时间戳', 'original_row'], errors='ignore')

        try:
            final_df.to_excel(output_file, index=False, engine='openpyxl')
            print(f"\n✅ 标注完成，结果已保存至：{output_file}")
        except Exception as e:
            print(f"\n❌ 保存Excel文件失败: {e}")
    else:
        print("\n❌ 未能生成任何标注结果。")

# -------------------
# 启动
# -------------------
if __name__ == "__main__":
    try:
        import tqdm
    except ImportError:
        print("检测到缺少tqdm库，它能提供一个漂亮的进度条。建议安装: pip install tqdm")
        
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
