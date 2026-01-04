# ==============================================================================
# 本地最终版Pro v2.2：专家级图文分析 + 修正数据读取逻辑
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
import openpyxl
from PIL import Image
import io
import base64

# -------------------
# 配置 (Configuration)
# -------------------
API_KEYS_STRING = os.getenv("GOOGLE_API_KEYS")
MODEL_NAME = "gemini-1.5-flash-latest"
# 【优化建议】您可以尝试将BATCH_SIZE逐步增大至20或30，以进一步提升效率
BATCH_SIZE = 15 
CONCURRENT_REQUESTS = 2 # 建议设置为您的API密钥数量

# 【重要】请根据您Excel表格的实际列位置进行修改（A列=1, B列=2...）
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

# 【重大升级】重构Prompt，要求AI进行专家级分析
def create_expert_prompt_instructions():
    """生成包含全新专家级分析要求的指令文本。"""
    return (
        "你是一名首席电商服务质检官，拥有多年的客户服务分析经验。你的任务是深入、精确地分析我提供的每一个客户服务对话（可能包含文字和图片），并以结构化的JSON格式返回你的专家级分析报告。\n\n"
        "**分析维度与输出要求（非常重要）：**\n"
        "你的回复**必须**是一个JSON数组 `[]`。数组中的每一个对象都必须严格包含以下6个键：\n\n"
        "1.  `conversation_id`: (整数) 必须与输入对话的ID完全一致。\n\n"
        "2.  `image_descriptions`: (字符串数组) 对话中每一张图片内容的客观、简洁描述。如果没有图片，则返回空数组 `[]`。\n\n"
        "3.  `problem_detected`: (布尔值) `true` 表示对话中存在明显的服务或产品问题，否则为 `false`。\n\n"
        "4.  `problem_domain`: (字符串 | null) 如果 `problem_detected` 为 `true`，请从以下类别中选择最贴切的一项：['服务质量', '产品问题', '物流问题', '售前咨询']。否则为 `null`。\n\n"
        "5.  `specific_issue`: (字符串 | null) 如果 `problem_detected` 为 `true`，请从以下具体问题中选择最贴切的一项：['响应超时', '知识错误', '态度不佳', '流程违规', '产品损坏', '功能故障', '错发/漏发', '物流延迟/异常']。否则为 `null`。\n\n"
        "6.  `expert_review`: (对象 | null) 如果 `problem_detected` 为 `true`，提供一个包含以下两个键的对象。否则为 `null`。\n"
        "    - `evaluation`: (字符串) 作为质检专家的核心简评，一针见血地指出问题所在。\n"
        "    - `suggestion`: (字符串) 提出具体、可执行的改进建议。\n\n"
        # --- 【重要修正】新增语言要求 ---
        "**语言要求**：所有的文本输出，特别是 `image_descriptions`, `evaluation` 和 `suggestion` 的内容，**必须使用简体中文**进行回复。\n\n"
        "**最终输出格式示例**：\n"
        "```json\n"
        "[\n"
        "  {\n"
        "    \"conversation_id\": 101,\n"
        "    \"image_descriptions\": [\"一张显示水杯杯盖有明显裂痕的特写照片。\"],\n"
        "    \"problem_detected\": true,\n"
        "    \"problem_domain\": \"产品问题\",\n"
        "    \"specific_issue\": \"产品损坏\",\n"
        "    \"expert_review\": {\n"
        "      \"evaluation\": \"客户通过图片清晰反馈了产品破损问题，但客服未能主动识别并启动售后流程，而是反复询问无关问题，导致服务体验下降。\",\n"
        "      \"suggestion\": \"加强客服对客诉图片的识别培训，遇到明确的产品质量问题应立即引导客户进入售后流程，而非无效沟通。\"\n"
        "    }\n"
        "  },\n"
        "  {\n"
        "    \"conversation_id\": 102,\n"
        "    \"image_descriptions\": [],\n"
        "    \"problem_detected\": false,\n"
        "    \"problem_domain\": null,\n"
        "    \"specific_issue\": null,\n"
        "    \"expert_review\": null\n"
        "  }\n"
        "]\n"
        "```\n"
        "请**不要**返回任何JSON格式之外的额外说明、解释或标记。"
    )

# 【改动】process_batch函数现在需要构建复杂的多模态请求体
async def process_batch_http(session, api_key, batch_data, batch_num):
    if not batch_data: return []

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {'Content-Type': 'application/json'}

    instructions = create_expert_prompt_instructions()
    
    dialogues_for_prompt = []
    for conv_id, conversation_parts in batch_data:
        dialogue_text_representation = ""
        image_count = 0
        for part in conversation_parts:
            if part['type'] == 'text':
                dialogue_text_representation += part['content'] + "\n"
            elif part['type'] == 'image':
                image_count += 1
                dialogue_text_representation += f"[附图 {image_count}]\n"
        dialogues_for_prompt.append({
            "conversation_id": conv_id,
            "dialogue_summary": dialogue_text_representation.strip()
        })
    
    dialogues_json_string = json.dumps(dialogues_for_prompt, ensure_ascii=False, indent=2)

    final_prompt_parts = [
        {"text": instructions},
        {"text": "\n**待处理的对话批次如下：**\n"},
        {"text": f"```json\n{dialogues_json_string}\n```"},
        {"text": "\n**批次中引用的图片数据如下（请按顺序与[附图]标识对应）：**\n"}
    ]
    
    for _, conversation_parts in batch_data:
        for part in conversation_parts:
            if part['type'] == 'image':
                pil_image = part['content']
                buffered = io.BytesIO()
                img_format = pil_image.format if pil_image.format else 'PNG'
                # 压缩图片质量以减小请求大小
                pil_image.save(buffered, format=img_format, quality=85, optimize=True)
                img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
                
                final_prompt_parts.append({
                    "inline_data": {
                        "mime_type": f"image/{img_format.lower()}",
                        "data": img_base64
                    }
                })

    payload = {
        "contents": [{"parts": final_prompt_parts}],
        "generationConfig": {
            "response_mime_type": "application/json",
            "temperature": 0.2
        }
    }
    
    try:
        print(f"批次 {batch_num}: 开始处理 {len(batch_data)} 组图文对话 (使用密钥: ...{api_key[-4:]})")
        async with session.post(url, headers=headers, json=payload, params={'key': api_key}, timeout=600) as response:
            response.raise_for_status()
            response_json = await response.json()
            content_text = response_json['candidates'][0]['content']['parts'][0]['text']
            results = json.loads(content_text)
            print(f"批次 {batch_num}: 处理成功，获得 {len(results)} 条结果。")
            return results
    except Exception as e:
        print(f"批次 {batch_num}: 错误！API请求或处理时发生严重错误: {e}")
        return [{"conversation_id": conv_id, "problem_detected": True, "expert_review": {"evaluation": f"API请求失败: {e}", "suggestion": "检查网络连接或API密钥状态。"}} for conv_id, _ in batch_data]


# -------------------
# 主程序
# -------------------
async def main():
    root = Tk(); root.withdraw()
    input_file = filedialog.askopenfilename(title="请选择包含图片的聊天记录Excel文件", filetypes=(("Excel Files", "*.xlsx"),))
    if not input_file: print("未选择文件，程序已退出。"); return
    output_file = filedialog.asksaveasfilename(title="请选择保存路径", defaultextension=".xlsx", initialfile="expert_annotated_records.xlsx", filetypes=(("Excel Files", "*.xlsx"),))
    if not output_file: print("未选择保存路径，程序已退出。"); return

    print(f"输入文件: {input_file}\n输出文件: {output_file}")

    if not API_KEYS_STRING:
        print("错误：找不到 GOOGLE_API_KEYS 环境变量。"); return
    
    api_keys = [key.strip() for key in API_KEYS_STRING.split(',') if key.strip()]
    if not api_keys:
        print("错误：环境变量 GOOGLE_API_KEYS 中没有找到有效的密钥。"); return
    print(f"成功加载 {len(api_keys)} 个API密钥。")
    
    keys_cycler = itertools.cycle(api_keys)

    # --- 1. 使用 openpyxl 读取文本和图片数据 ---
    print("正在从Excel读取文本和图片数据...")
    try:
        workbook = openpyxl.load_workbook(input_file)
        sheet = workbook.active
        images = {image.anchor._from.row + 1: Image.open(image.ref) for image in sheet._images}
        print(f"在Excel中找到了 {len(images)} 张图片。")
        
        # 【重大修正】采用更稳健、更明确的循环来读取列数据
        data_rows = []
        for row_index, row_cells in enumerate(sheet.iter_rows(min_row=2), start=2):
            # 如果整行都是空的，则跳过
            if all(c.value is None for c in row_cells):
                continue
            
            row_data = {'original_row': row_index}
            # 根据COLUMN_MAPPING中定义的列号精确地提取数据
            for key, col_index in COLUMN_MAPPING.items():
                # 确保列号在有效范围内
                if col_index - 1 < len(row_cells):
                    row_data[key] = row_cells[col_index - 1].value
                else:
                    row_data[key] = None # 如果列不存在，则填充None
            data_rows.append(row_data)

        original_df = pd.DataFrame(data_rows)
        print(f"从Excel中读取了 {len(original_df)} 行文本数据。")
    except Exception as e:
        print(f"错误：使用openpyxl读取Excel文件失败！- {e}"); return

    # --- 2. 重构对话分组逻辑，增强容错性 ---
    print("正在根据用户和时间戳重组图文对话...")
    
    with pd.option_context('mode.chained_assignment', None):
        original_df['date_str'] = original_df['date'].apply(lambda x: str(x) if pd.notna(x) else '')
        original_df['time_str'] = original_df['time'].apply(lambda x: str(x) if pd.notna(x) else '')
        original_df['时间戳'] = pd.to_datetime(original_df['date_str'] + ' ' + original_df['time_str'], errors='coerce')

    failed_timestamps = original_df['时间戳'].isna().sum()
    if failed_timestamps > 0:
        print(f"[诊断] {failed_timestamps} 行的日期或时间格式无法识别，已被标记为无效。")

    original_df[['user', '时间戳']] = original_df[['user', '时间戳']].ffill()

    initial_rows_count = len(original_df)
    original_df.dropna(subset=['user', '时间戳'], inplace=True)
    dropped_rows = initial_rows_count - len(original_df)
    if dropped_rows > 0:
        print(f"[诊断] 清理了 {dropped_rows} 行缺少用户或有效时间戳的数据。")
    
    if original_df.empty:
        print("错误：数据清理后，没有剩下任何有效行。请检查Excel文件开头的几行是否包含有效的用户、日期和时间信息。")
        return

    original_df.sort_values(['user', '时间戳'], inplace=True)
    
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

    conversations = {}
    for conv_id, group in original_df.groupby('会话编号'):
        conversations[conv_id] = []
        for _, row in group.iterrows():
            if pd.notna(row['sender']) and pd.notna(row['message']):
                conversations[conv_id].append({'type': 'text', 'content': f"[{row['时间戳'].strftime('%Y-%m-%d %H:%M:%S')}] {row['sender']}: {str(row['message']).strip()}"})
            if row['original_row'] in images:
                conversations[conv_id].append({'type': 'image', 'content': images[row['original_row']]})
    
    print(f"重组后，过滤前共找到 {len(conversations)} 组对话。")

    min_messages = 3
    filtered_conversations = {cid: parts for cid, parts in conversations.items() if len(parts) >= min_messages}
    all_conversations_to_process = list(filtered_conversations.items())

    if not all_conversations_to_process:
        print("没有找到符合条件的有效会话进行分析（所有对话均少于3条消息）。"); return
        
    batches = [all_conversations_to_process[i:i + BATCH_SIZE] for i in range(0, len(all_conversations_to_process), BATCH_SIZE)]
    
    print(f"📦 数据预处理完成，共 {len(all_conversations_to_process)} 组有效对话，分为 {len(batches)} 个批次。")
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

    # --- 4. 【重大升级】结果合并与保存 ---
    if all_results:
        processed_labels = []
        for res in all_results:
            label = {
                '会话编号': res.get('conversation_id'),
                'AI-图片内容': "\n".join(res.get('image_descriptions', [])),
                'AI-问题定性': res.get('problem_domain'),
                'AI-具体问题': res.get('specific_issue'),
                'AI-专家简评': res.get('expert_review', {}).get('evaluation') if res.get('expert_review') else None,
                'AI-改进建议': res.get('expert_review', {}).get('suggestion') if res.get('expert_review') else None,
                'AI-标注错误': res.get('AI-标注错误')
            }
            processed_labels.append(label)
        
        label_df = pd.DataFrame(processed_labels)
        
        final_df = original_df.merge(label_df, on="会话编号", how="left")

        image_rows_mask = final_df['message'].isna() & final_df['AI-图片内容'].notna()
        final_df.loc[image_rows_mask, 'message'] = "[图片内容: " + final_df.loc[image_rows_mask, 'AI-图片内容'] + "]"
        
        # 清理所有在最终输出中不需要的辅助列
        final_df = final_df.drop(columns=['时间戳', 'original_row', 'date_str', 'time_str', 'AI-图片内容'], errors='ignore')

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
