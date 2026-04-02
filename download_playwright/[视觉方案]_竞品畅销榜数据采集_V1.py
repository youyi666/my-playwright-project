import os
import re
import logging
import datetime
import hashlib
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

# ----------------- 基础配置与容错日志设置 -----------------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

Base = declarative_base()

# [增量修改] 定义数据库表结构：将所有销量字段的数据类型强转为 Integer，方便后续做BI分析
class ProductInfo(Base):
    __tablename__ = 'product_info'
    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(String(32), index=True, comment="商品唯一识别码(基于纯净标题MD5)")
    title = Column(String(255), comment="纯净商品标题")
    price = Column(Float, comment="价格")
    total_sales = Column(Integer, comment="总售数量(纯数字)")      # 改为 Integer
    hot_sales = Column(Integer, comment="近期热销(纯数字)")        # 改为 Integer
    grabbed_sales = Column(Integer, comment="已抢情况(纯数字)")    # 改为 Integer
    scrape_time = Column(DateTime, default=datetime.datetime.now, comment="抓取时间")

def init_db(db_name="xiaomi_products.db"):
    """初始化 SQLite 数据库"""
    engine = create_engine(f'sqlite:///{db_name}')
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    return Session()

# [全新增量模块] 数字提纯器
def extract_pure_number(text):
    """
    清洗提取纯数字，自动处理'万'单位。
    例如: "1.3万+件" -> 13000 | "30天热销563件" -> 563 | "已抢77件" -> 77
    """
    if not text:
        return None
    # 匹配所有的 (数字) 以及可能紧跟在后面的 (万)
    matches = re.findall(r'(\d+(?:\.\d+)?)\s*(万?)', text)
    if not matches:
        return None
    
    # 核心精髓：取最后一个匹配项。完美避开"30天"里的30，只取最后的563
    num_str, wan = matches[-1]
    num = float(num_str)
    
    if wan == '万':
        num *= 10000
        
    return int(num)

# ----------------- 核心解析逻辑 -----------------
def parse_image(image_path, session, ocr_engine):
    try:
        logging.info(f"========== 开始处理图片: {os.path.basename(image_path)} ==========")
        img = Image.open(image_path)
        width, height = img.size
        
        # 1. 执行用户的精妙建议：裁剪 高680，左545
        if width <= 545 or height <= 680:
            logging.error(f"图片尺寸({width}x{height})过小，无法执行裁剪要求。已跳过。")
            return

        cropped_img = img.crop((485, 610, width, height))
        
        # 容错机制：保存裁剪结果以供验证
        debug_crop_path = f"debug_crop_{os.path.basename(image_path)}"
        cropped_img.save(debug_crop_path)
        
        # 转换为 numpy 数组供 RapidOCR 使用
        img_array = np.array(cropped_img)
        result, _ = ocr_engine(img_array)
        
        if not result:
            logging.warning(f"图片未识别到任何有效文字，请检查裁剪区域。")
            return
            
        # 2. 空间动态聚类：基于 Y 坐标将文本归类到对应的商品卡片
        boxes_info = []
        for box, text, conf in result:
            cy = (box[0][1] + box[2][1]) / 2
            boxes_info.append({'cy': cy, 'text': text, 'box': box})
            
        boxes_info.sort(key=lambda x: x['cy'])
        
        blocks = []
        current_block = []
        last_cy = None
        
        for info in boxes_info:
            if last_cy is None:
                current_block.append(info)
            else:
                if info['cy'] - last_cy > 80: 
                    blocks.append(current_block)
                    current_block = [info]
                else:
                    current_block.append(info)
            last_cy = info['cy']
        if current_block:
            blocks.append(current_block)
            
        # =========================================================
        # 增量模块：执行用户的“只取两行黑体”截断策略
        # =========================================================
        extracted_data = []
        
        for idx, block in enumerate(blocks):
            title_parts = []
            price = None
            total_sales = None
            hot_sales = None
            grabbed_sales = None
            
            # 用于正则提取数字的全文本
            full_text = " || ".join([item['text'] for item in block])
            
            # [增量修改] 数据分流清洗，并套上 extract_pure_number 提纯器
            pm = re.search(r'[¥￥Y\?？]\s*(\d+(?:\.\d+)?)', full_text)
            if pm: price = float(pm.group(1))
                
            tsm = re.search(r'总售(.*?件)', full_text)
            if tsm: total_sales = extract_pure_number(tsm.group(1))
                
            hsm = re.search(r'(\d+天热销.*?件)', full_text)
            if hsm: hot_sales = extract_pure_number(hsm.group(1))
                
            gsm = re.search(r'(已抢.*?件)', full_text)
            if gsm: grabbed_sales = extract_pure_number(gsm.group(1))

            # ---------------------------------------------------------
            # 全新标题提取逻辑：自上而下读取，遇到灰色属性行立即停止
            # ---------------------------------------------------------
            skip_keywords = ['品牌', '百亿补贴', '顶部', '天达', '榜首', '先用后付']
            stop_keywords = ['即将','售罄', '售馨', '分期', '正品', '立享', '仅剩', '折', '发票', '免息', '保险', '已抢', '总售', '券后', '热销', '评价']
            
            title_finished = False
            for item in block:
                text = item['text'].strip()
                
                if re.match(r'^[¥￥Y\?？\d\.]+$', text):
                    continue
                    
                if any(kw in text for kw in skip_keywords):
                    continue
                    
                if any(kw in text for kw in stop_keywords) or re.search(r'\d+天热销|\d+人付款', text):
                    title_finished = True 
                    continue
                    
                if not title_finished:
                    if text in ['小米', '米家'] and len(title_parts) == 0:
                        continue
                        
                    clean_text = re.sub(r'品牌\s*小米?', '', text).strip()
                    if clean_text:
                        title_parts.append(clean_text)

            title = "".join(title_parts)
            
            # 终极防线：不管前面的框怎么粘连，只要最终拼装的结果开头出现了重复的“小米”，强行合并为一个！
            title = re.sub(r'^(小米)+', '小米', title)
            title = re.sub(r'^(米家)+', '米家', title)
            
            # =========================================================
            # [全新增量模块] OCR 视觉纠偏与标准化
            # =========================================================
            # 1. 针对性修复：利用正则将错认的 Pr0 (零) 强制纠正为 Pro (不区分大小写)
            title = re.sub(r'(?i)Pr0', 'Pro', title)
            
            # 2. 终极一刀切防线：将标题里的所有英文字母统一转为大写！
            # 这样一来，不管 OCR 识别成 Pro、pro 还是 PRO，入库和生成 Hash 时都会绝对一致，彻底杜绝型号断层。
            title = title.upper()
            
            # (下方是原有的入库代码，保持不变)
            extracted_data.append({
                "title": title,
                "price": price,
                "total_sales": total_sales,
                "hot_sales": hot_sales,
                "grabbed_sales": grabbed_sales
            })

        # =========================================================
        # 唯一码生成与上下文信息融合
        # =========================================================
        def get_hash(raw_title):
            if not raw_title: return ""
            pure_str = raw_title.replace(' ', '').strip()
            return hashlib.md5(pure_str.encode('utf-8')).hexdigest()

        temp_product = {"title": "", "price": None, "total_sales": None, "hot_sales": None, "grabbed_sales": None}
        
        for data in extracted_data:
            if len(data['title']) > 2 and temp_product['price'] is not None:
                pid = get_hash(temp_product['title'])
                
                if temp_product['title'] or temp_product['price']:
                    product = ProductInfo(
                        product_id=pid,
                        title=temp_product['title'][:255], 
                        price=temp_product['price'], 
                        total_sales=temp_product['total_sales'], 
                        hot_sales=temp_product['hot_sales'],
                        grabbed_sales=temp_product['grabbed_sales']
                    )
                    session.add(product)
                    logging.info(f"[合并入库] 标题: {temp_product['title'][:15]}... | 价格: {temp_product['price']} | 总销: {temp_product['total_sales']} | 热销: {temp_product['hot_sales']} | 已抢: {temp_product['grabbed_sales']}")
                
                temp_product = {"title": "", "price": None, "total_sales": None, "hot_sales": None, "grabbed_sales": None}

            if data['title']: temp_product['title'] += data['title']
            if data['price'] is not None: temp_product['price'] = data['price']
            if data['total_sales'] is not None: temp_product['total_sales'] = data['total_sales']
            if data['hot_sales'] is not None: temp_product['hot_sales'] = data['hot_sales']
            if data['grabbed_sales'] is not None: temp_product['grabbed_sales'] = data['grabbed_sales']

        if temp_product['title'] or temp_product['price']:
            pid = get_hash(temp_product['title'])
            if temp_product['title'] or temp_product['price']:
                product = ProductInfo(
                    product_id=pid,
                    title=temp_product['title'][:255], 
                    price=temp_product['price'], 
                    total_sales=temp_product['total_sales'], 
                    hot_sales=temp_product['hot_sales'],
                    grabbed_sales=temp_product['grabbed_sales']
                )
                session.add(product)
                logging.info(f"[合并入库] 标题: {temp_product['title'][:15]}... | 价格: {temp_product['price']} | 总销: {temp_product['total_sales']} | 热销: {temp_product['hot_sales']} | 已抢: {temp_product['grabbed_sales']}")

        session.commit()
        
    except Exception as e:
        logging.error(f"处理图片 {image_path} 时发生异常: {e}", exc_info=True)
        session.rollback()

if __name__ == "__main__":
    db_session = init_db()
    ocr = RapidOCR()
    
    image_dir = "./images"
    if not os.path.exists(image_dir):
        os.makedirs(image_dir)
        logging.info(f"由于找不到图片目录，已为你自动创建 '{image_dir}' 文件夹。")
    else:
        files = [f for f in os.listdir(image_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        if not files:
            logging.warning(f"'{image_dir}' 文件夹中没有找到图片，请检查！")
        
        for filename in files:
            img_path = os.path.join(image_dir, filename)
            parse_image(img_path, db_session, ocr)