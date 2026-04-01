# -*- coding: utf-8 -*-
import os
import re
import logging
from rapidocr_onnxruntime import RapidOCR
from sqlalchemy import create_engine, Column, Integer, String, Float
from sqlalchemy.orm import declarative_base, sessionmaker

# 1. 初始化日志配置
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 2. 初始化数据库连接 (SQLite)
DB_PATH = 'sqlite:///water_purifier_competitor_data.db'
engine = create_engine(DB_PATH)
Base = declarative_base()

# 定义数据表结构
class ProductRanking(Base):
    __tablename__ = 'competitor_rankings'
    
    # 使用标题作为主键的一部分，防止重复录入
    id = Column(Integer, primary_key=True, autoincrement=True)
    heat_index = Column(Integer, comment="热卖指数")
    title = Column(String(255), unique=True, comment="商品标题") # 设置唯一索引用于去重
    price = Column(Float, comment="券后价")
    sales_info = Column(String(100), comment="销量信息")
    source_image = Column(String(100), comment="来源截图")

# 创建表
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)

# 3. 初始化 OCR 引擎 (使用 ONNXRuntime 引擎，彻底绕开 Paddle 底层 Bug)
logger.info("正在加载 RapidOCR (ONNX) 引擎...")
ocr = RapidOCR()

def process_image_to_db(image_path, session):
    """处理单张图片并入库"""
    logger.info(f"========== 开始处理图片: {image_path} ==========")
    
    try:
        # --- 增量模块：适配 RapidOCR 的执行与返回值结构 ---
        # RapidOCR 返回两个值: result (包含数据的列表) 和 elapse (耗时)
        result, elapse_time = ocr(image_path)
        
        if not result:
            logger.warning(f"图片 {image_path} 未识别到任何文字。")
            return

        # 提取文字块并计算其 Y 轴中心点
        text_blocks = []
        # RapidOCR 的 result 结构为: [ [[[x,y],..], '文本', 置信度], ... ]
        for line in result:
            box = line[0]        # 坐标框
            text = line[1]       # 识别文本
            
            # --- 增量模块：容错机制 ---
            # 强制将置信度转换为 float，防止底层引擎返回 str 类型导致类型比较崩溃
            try:
                confidence = float(line[2])
            except ValueError:
                confidence = 0.0 # 若遇到无法转换的异常值，直接归零过滤
            
            if confidence > 0.7:  # 过滤低置信度噪点
                # 计算边界框中心的 Y 坐标
                y_center = (box[0][1] + box[2][1]) / 2
                text_blocks.append({"y": y_center, "text": text})

        # --- 以下按照 Y 坐标排序及组装入库的基座逻辑保持不变 ---

        

        # 按照 Y 坐标从上到下排序
        text_blocks = sorted(text_blocks, key=lambda item: item["y"])

        # --- 增量模块：全文组装提取（彻底替代原有的状态机提取逻辑） ---
        products_raw = []
        current_product = None
        
        # 第一遍遍历：只负责分组，将同一商品的所有文本碎块收集到一起
        for block in text_blocks:
            text = block['text'].strip()
            
            # 发现新的商品区块标志
            if "热卖指数" in text:
                if current_product:
                    products_raw.append(current_product)
                current_product = {'heat_index': 0, 'texts': []}
                
                # 提取热卖指数
                match = re.search(r'热卖指数\s*(\d+)', text)
                if match:
                    current_product['heat_index'] = int(match.group(1))
            elif current_product is not None:
                current_product['texts'].append(text)

        # 循环结束后，压入最后一个商品
        if current_product:
            products_raw.append(current_product)

        # 第二次遍历：将碎片拼成全文，进行全局高精度正则提取
        products = []
        for p in products_raw:
            full_text = " ".join(p['texts']) # 将所有文字拼成一行长字符串
            title = ""
            price = 0.0
            sales = ""
            
            # 1. 提取价格 (无敌版正则：不管前面是券后、半角¥、全角￥、还是字母Y，统统跳过，直接抓取后面的金额数字)
            price_match = re.search(r'(?:券后|¥|￥|[Yy])\D{0,4}?(\d+(?:\.\d+)?)', full_text)
            if price_match:
                price = float(price_match.group(1))

            # 2. 提取销量 (保持上一版成功的原样)
            sales_match = re.search(r'((?:总售|已抢|\d*天?热销)\s*\d+(?:\.\d+)?万?\+?件?)', full_text)
            if sales_match:
                sales = sales_match.group(1)

            # 3. 提取标题 (增加了对全角￥的过滤)
            for t in p['texts']:
                if len(t) > 6 and any(k in t for k in ["净水", "米家", "小米", "滤芯", "直饮", "双出水"]):
                    if not re.search(r'(券后|¥|￥|[Yy]|总售|已抢|热销|补贴|分期付款)', t):
                        title += t
            
            # --- 增量模块：终极查错机制 ---
            if price == 0.0:
                logger.warning(f"[价格提取失败] OCR抓取的原文是: {full_text}")

            # 组装为入库要求的格式
            products.append({
                'heat_index': p['heat_index'],
                'title': title,
                'price': price,
                'sales': sales
            })

        # --- 以下 4. 数据入库的基座逻辑保持不变 ---

        # 4. 数据入库 (修改了日志打印，补上热卖指数)
        success_count = 0
        for p in products:
            if not p['title']: 
                continue
                
            try:
                existing = session.query(ProductRanking).filter_by(title=p['title']).first()
                if existing:
                    existing.price = p['price']
                    existing.heat_index = p['heat_index']
                    existing.sales_info = p['sales']
                    logger.info(f"[更新] 指数:{p['heat_index']} | {p['title'][:15]}... | 价格: {p['price']} | 销量: {p['sales']}")
                else:
                    new_record = ProductRanking(
                        heat_index=p['heat_index'],
                        title=p['title'],
                        price=p['price'],
                        sales_info=p['sales'],
                        source_image=os.path.basename(image_path)
                    )
                    session.add(new_record)
                    # 在此处补齐了热卖指数的展示！
                    logger.info(f"[新增] 指数:{p['heat_index']} | {p['title'][:15]}... | 价格: {p['price']} | 销量: {p['sales']}")
                
                success_count += 1
            except Exception as db_e:
                logger.error(f"插入数据失败: {p['title']}, 错误: {db_e}")
                session.rollback()
                
        session.commit()
        logger.info(f"图片 {image_path} 处理完毕，成功提取并写入 {success_count} 条数据。")

    except Exception as e:
        logger.error(f"[Error] 解析图片 {image_path} 发生严重异常: {e}")
        session.rollback()


if __name__ == "__main__":
    # 假设你把上面4张图片放在了当前目录下的 images 文件夹中
    image_dir = './images'
    
    if not os.path.exists(image_dir):
        logger.error(f"找不到图片目录: {image_dir}，请创建并将截图放入其中。")
    else:
        # 打开数据库会话
        session = Session()
        
        # 遍历目录下的所有 jpg/png 文件
        for filename in os.listdir(image_dir):
            if filename.lower().endswith(('.png', '.jpg', '.jpeg')):
                img_path = os.path.join(image_dir, filename)
                process_image_to_db(img_path, session)
                
        session.close()
        logger.info("所有任务执行完毕。")