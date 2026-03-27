const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const axios = require('axios'); // 确保引入 axios 
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const sharp = require('sharp');

// 绝对强控：直接向底层指明同目录下的物理 exe 路径，彻底抛弃网络依赖
ffmpeg.setFfmpegPath(path.join(__dirname, 'ffmpeg.exe'));
// ==========================================
// 🚀 增量模块：本地中转图片下载引擎
// ==========================================
/**
 * @param {Array<string>} imageUrls - 图片链接数组
 * @param {string} prefix - 图片命名前缀（如 'main' 或 'detail'）
 * @returns {Promise<Array<string>>} - 返回成功下载到本地的文件绝对路径数组
 */
async function downloadImagesToLocal(imageUrls, prefix) {
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    let downloadedPaths = [];
    console.log(`\n📥 [下载引擎] 准备将 ${imageUrls.length} 张 ${prefix} 图片中转至本地...`);

    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        // 提取原图后缀，默认给 jpg
        const extMatch = url.match(/\.(jpg|jpeg|png|webp)/i);
        const ext = extMatch ? extMatch[1] : 'jpg';
        const fileName = `${prefix}_${i + 1}_${Date.now()}.${ext}`;
        const filePath = path.join(tempDir, fileName);
        
        try {
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://item.jd.com/'
                },
                timeout: 10000
            });
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            downloadedPaths.push(filePath);
            console.log(` ✅ [下载成功] ${fileName}`);
        } catch (error) {
            console.error(` ❌ [下载失败] ${url} - 错误原因: ${error.message}`);
        }
    }

    return downloadedPaths;
}
// ==========================================
// 🚀 增量模块：图片智能合规处理引擎 (切片+压缩)
// ==========================================
async function processImagesForPDD(imagePaths) {
    let processedPaths = [];
    console.log(`\n🔪 [图片合规引擎] 开始对 ${imagePaths.length} 张图片进行 PDD 合规校验 (切片/尺寸/大小)...`);

    for (let i = 0; i < imagePaths.length; i++) {
        const imgPath = imagePaths[i];
        if (!fs.existsSync(imgPath)) continue;

        try {
            const metadata = await sharp(imgPath).metadata();
            let { width, height } = metadata;
            
            // 💥 核心修正：彻底放弃字符串 replace，使用原生 path 解析确保输入输出路径绝对隔离
            const parsedPath = path.parse(imgPath);
            
            // 1. 【宽度校验】拼多多要求最小 480px
            let targetWidth = width;
            if (width < 480) {
                targetWidth = 480;
                height = Math.round((480 / width) * height);
                console.log(` 📐 图片宽度不足 480px，正在自动放大...`);
            }

            // 2. 【比例校验与智能切片】宽高比不能 >= 1:3 
            // 采用 2.8 作为安全阈值防误差
            const maxHeight = targetWidth * 2.8; 

            if (height > maxHeight) {
                const sliceCount = Math.ceil(height / maxHeight);
                const sliceHeight = Math.floor(height / sliceCount);
                console.log(` 🔪 发现超长商详图 (${width}x${height})，正在等分为 ${sliceCount} 张合规切片...`);

                for (let j = 0; j < sliceCount; j++) {
                    // 强制拼接新的物理路径，例如：原图_slice_0.jpg
                    const slicePath = path.join(parsedPath.dir, `${parsedPath.name}_slice_${j}.jpg`);
                    const topOffset = j * sliceHeight;
                    // 确保最后一刀不会超出图片总高度
                    const currentExtractHeight = Math.min(sliceHeight, height - topOffset);

                    await sharp(imgPath)
                        .resize({ width: targetWidth }) // 先保证宽度合规
                        .extract({ left: 0, top: topOffset, width: targetWidth, height: currentExtractHeight }) // 切片
                        .jpeg({ quality: 85 }) // 统一转为 jpg 并压缩
                        .toFile(slicePath);
                    
                    processedPaths.push(slicePath);
                }
            } else {
                // 如果比例正常，强制拼接安全的新路径进行压制
                const outPath = path.join(parsedPath.dir, `${parsedPath.name}_comp.jpg`);
                await sharp(imgPath)
                    .resize({ width: targetWidth })
                    .jpeg({ quality: 85 })
                    .toFile(outPath);
                processedPaths.push(outPath);
            }
        } catch (err) {
            console.error(` ❌ [图片处理失败] 忽略该图继续: ${err.message}`);
            // 容错：如果处理失败，把原图硬塞进去
            processedPaths.push(imgPath);
        }
    }
    
    console.log(`✅ [图片合规引擎] 处理完毕！原图 ${imagePaths.length} 张 -> 现输出合规图 ${processedPaths.length} 张。`);
    return processedPaths;
}
// ==========================================
// 🚀 增量模块：本地中转【视频】下载引擎
// ==========================================
async function downloadVideoToLocal(videoUrl) {
    if (!videoUrl) return null;
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    console.log(`\n🎬 [视频引擎] 发现京东主图视频，准备流式中转至本地...`);
    const fileName = `main_video_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    try {
        const response = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream', // 核心机制：流式写入防内存溢出
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://item.jd.com/'
            },
            timeout: 60000 // 视频文件大，给足 60 秒的超时容忍度
        });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log(` ✅ [视频下载成功] ${fileName}`);
        return filePath;
    } catch (error) {
        console.error(` ❌ [视频下载失败] 错误原因: ${error.message}`);
        return null;
    }
}
// 辅助函数：清理临时文件夹
function cleanTempImages() {
    const tempDir = path.join(__dirname, 'temp_images');
    if (fs.existsSync(tempDir)) {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log(`\n🧹 [清理引擎] 本地临时图片文件夹已销毁。`);
        } catch (e) {
            console.error(`⚠️ [清理异常] 无法删除临时文件夹: ${e.message}`);
        }
    }
}
// ==========================================
// 🚀 增量模块：本地视频无损剪辑与 16:9 重构引擎
// ==========================================
async function trimVideoLocal(inputPath) {
    if (!inputPath || !fs.existsSync(inputPath)) return null;
    
    const outputPath = inputPath.replace('.mp4', '_16x9_trimmed.mp4');
    console.log(`\n✂️ [视频剪辑引擎] 启动：掐头去尾，并强制重构为 16:9 比例 (添加黑边)...`);

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime('00:00:03') 
            .setDuration(170)         
            // 💥 核心：16:9 强制重构滤镜。等比例缩小画面放入 1280x720 框内，多余部分垫黑色背景！
            .videoFilters('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black')
            .outputOptions('-c:v libx264') // 必须使用 x264 重新编码
            .outputOptions('-preset veryfast') // 加速编码过程
            .outputOptions('-crf 28') // 适当压缩视频大小，防止超过拼多多体积限制
            .outputOptions('-c:a copy') // 音频保持原样
            .output(outputPath)
            .on('end', () => {
                console.log(` ✅ [剪辑大捷] 16:9 视频重构完成: ${path.basename(outputPath)}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(` ❌ [剪辑失败] FFmpeg 异常: ${err.message}`);
                resolve(inputPath); // 失败则返回原路径兜底
            })
            .run();
    });
}
// ==========================================
// 🚀 拼多多全自动智能填表引擎 (兼容填空与下拉)
// ==========================================
async function autoFillPinduoduo(page, cleanData) {
    console.log(`\n===========================================`);
    console.log(`🤖 [填表引擎] 开始执行智能化 UI 数据注入...`);
    
    for (const [labelName, targetValue] of Object.entries(cleanData)) {
        try {
            console.log(`⏳ 正在处理属性：【${labelName}】 -> 准备注入 [${targetValue}]`);
            // 1. 找爹：锁定表单行
            const rowBox = page.locator('[data-testid="beast-core-form-item"]')
                .filter({ has: page.locator('label', { hasText: new RegExp(`^${labelName}$`) }) });
            
            // 容错：如果该类目没有这个字段，直接跳过，绝不报错
            if (await rowBox.count() === 0) {
                console.log(` ➡️ 页面未开放【${labelName}】字段，自动放行...`);
                continue;
            }

            // 2. 找儿子：锁定输入框
            const inputElement = rowBox.locator('input').first();
            await inputElement.scrollIntoViewIfNeeded();
            
            // 3. 统一操作：强力点击并填入内容
            await inputElement.click({ force: true });
            await inputElement.fill(targetValue.toString());
            
            // 给复杂的 React 动画渲染时间
            await page.waitForTimeout(500);
            
            // 4. 智能判断分支：寻找是否有悬浮出来的下拉菜单项
            const dropdownOption = page.getByText(targetValue, { exact: true }).filter({ state: 'visible' }).last();
            
            if (await dropdownOption.count() > 0) {
                // 💥 路线 A：发现悬浮菜单，判定为下拉框，强力击杀纯文本！
                await dropdownOption.click({ force: true });
                console.log(` ✅ [下拉框] 成功选中选项：${targetValue}`);
            } else {
                // 🖊️ 路线 B：未发现悬浮菜单，判定为普通输入框，注入底层失焦事件！
                await inputElement.evaluate(node => {
                    node.dispatchEvent(new Event('input', { bubbles: true }));
                    node.dispatchEvent(new Event('change', { bubbles: true }));
                    node.dispatchEvent(new Event('blur', { bubbles: true }));
                });
                console.log(` ✅ [输入框] 成功填入数值：${targetValue}`);
            }
        } catch (e) {
            console.log(` ❌ 处理属性【${labelName}】时发生意外: ${e.message}`);
        }
    }
    console.log(`🤖 [填表引擎] 全部文本属性注入完毕！`);
    console.log(`===========================================\n`);
}

// ==========================================
// 🚀 主流程控制中心
// ==========================================
(async () => {
    console.log('🚀 [系统启动] 正在初始化反爬虫双线浏览器环境...');
    
    // 加载本地字典
    const dictPath = path.join(__dirname, 'category_mapping.json');
    if (!fs.existsSync(dictPath)) {
        console.error('❌ 找不到 category_mapping.json，请确保字典文件存在！');
        process.exit(1);
    }
    const categoryDict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));

    const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
    
    // 使用 User Data Dir 概念复用登录状态
    const jdStatePath = path.join(__dirname, 'stateJD.json');
    const pddStatePath = path.join(__dirname, 'statePDD.json');

    const contextJD = await browser.newContext(fs.existsSync(jdStatePath) ? { storageState: jdStatePath } : {});
    const contextPDD = await browser.newContext(fs.existsSync(pddStatePath) ? { storageState: pddStatePath } : {});
    
    let pagePDD; 

    try {
        // ==========================================
        // 阶段一：京东全能抓取 (API瞬时窃听 + 物理级仿生滚动 + sku纯净过滤)
        // ==========================================
        console.log(`\n🔄 [京东端] 准备进入商品页并挂载双重侦测...`);
        const pageJD = await contextJD.newPage();
        
        // ⚠️ 替换为你要抓取的实际京东商品 SKU
        const targetJdItemId = '100166814921';
        let jdRawData = {};

        // 1. [实时监听] 拦截底层参数
        pageJD.on('response', async (response) => {
            if (response.url().includes('pc_detailpage_wareBusiness') && response.status() === 200) {
                try {
                    const resJson = await response.json(); 
                    const attributes = resJson?.productAttributeVO?.attributes || [];
                    attributes.forEach(item => {
                        if (item.labelName && item.labelValue) {
                            jdRawData[item.labelName] = item.labelValue.trim();
                        }
                    });
                    console.log(`✅ [后台窃听] 成功截获京东 API，瞬时提取到 ${Object.keys(jdRawData).length} 条文本参数！`);
                } catch (e) {}
            }
        });
        
        // 2. 访问页面，确保前端 JS 跑完
        await pageJD.goto(`https://item.jd.com/${targetJdItemId}.html`, { waitUntil: 'load' });
        
        console.log(`⏳ 等待京东主体框架加载...`);
        await pageJD.waitForSelector('.spec-items img', { timeout: 5000 }).catch(() => console.log('⚠️ 主图 DOM 加载延迟，跳过等待'));
        
        // -----------------------------------------------------------------
        // 核心替代方案：放弃 JS 注入，采用底层物理级仿生滚动
        // -----------------------------------------------------------------
        console.log(`🎯 [自动化] 启动底层物理级仿生滚动，模拟真人浏览节奏逼出数据...`);
        let targetFound = false;
        let maxScrolls = 30; // 最多尝试 30 次鼠标滚动
        let scrolls = 0;
        
        // 先把鼠标移动到页面中央，防止在边缘滚轮失效
        await pageJD.mouse.move(500, 500);
        
        while (scrolls < maxScrolls) {
            // A. 模拟真人随机滚轮力度 (每次滚动 300px - 800px)
            const scrollStep = Math.floor(Math.random() * 500) + 300;
            await pageJD.mouse.wheel(0, scrollStep);
            
            // B. 模拟真人阅读视线停顿 (0.5秒 - 1.5秒)
            const delay = Math.floor(Math.random() * 1000) + 500;
            await pageJD.waitForTimeout(delay);
            
            scrolls++;

            // C. 每次停顿期间，静默侦测 DOM 是否已经渲染出真实数据 (增强型，涵盖 CSS 背景)
            targetFound = await pageJD.evaluate(() => {
                const detailBox = document.querySelector('#detail') || document.querySelector('#J-detail-content');
                if (!detailBox) return false;
                
                // 1. 扫描 img 标签
                const hasImg = Array.from(detailBox.querySelectorAll('img')).some(img => {
                    const url = img.getAttribute('data-lazyload') || img.getAttribute('data-src') || img.src || '';
                    return url.includes('sku') && /\.(jpg|jpeg|png|webp)/i.test(url);
                });
                if (hasImg) return true;

                // 2. 扫描 div/section 的背景图
                const hasBg = Array.from(detailBox.querySelectorAll('div, section')).some(el => {
                    const bg = window.getComputedStyle(el).backgroundImage;
                    const ssdBg = el.getAttribute('data-bg') || el.style.backgroundImage || '';
                    return (bg && bg.includes('sku')) || (ssdBg && ssdBg.includes('sku'));
                });
                
                return hasBg; 
            });
            
            if (targetFound) {
                console.log(`✅ [侦测成功] 在第 ${scrolls} 次物理滚动后，京东防爬机制放行，成功逼出底层商详图！`);
                // 惯性滚动：人眼看到目标后，通常还会往下划几下，确保后续图片加载
                await pageJD.mouse.wheel(0, 700);
                await pageJD.waitForTimeout(800);
                await pageJD.mouse.wheel(0, 700);
                await pageJD.waitForTimeout(1500);
                break;
            }
        }

        if (!targetFound) {
            console.log(`⚠️ [侦测预警] 仿生滚动结束，未发现目标图片。将强制进行最后提取尝试。`);
        }

        // 4. [前台刮取] 执行纯净过滤
        console.log(`🔍 [自动化] 真实数据已就绪，开始执行 sku 过滤...`);
        const imagesData = await pageJD.evaluate(() => {
            let mainImages = [];
            try {
                if (window.pageConfig && window.pageConfig.product && window.pageConfig.product.imageList) {
                    mainImages = window.pageConfig.product.imageList.map(url => 'https://img10.360buyimg.com/n12/' + url.replace(/\.avif$/, ''));
                } else {
                    mainImages = Array.from(document.querySelectorAll('.spec-items img'))
                      .map(img => img.src.replace(/\/(n0|n1|n5)\//, '/n12/').split('!')[0].replace(/\.avif$/, ''));
                }
            } catch(e) { console.log("主图抓取异常", e); }

            const detailBox = document.querySelector('#detail') || document.querySelector('#J-detail-content') || document.body;
            let detailImages = new Set(); 

            if (detailBox) {
                // 办法 A：扫描所有 img 标签
                detailBox.querySelectorAll('img').forEach(img => {
                    const url = img.getAttribute('data-lazyload') || img.getAttribute('data-src') || img.src;
                    // 严格叠加 sku 过滤规则
                    if (url && url.includes('//') && !url.includes('blank.gif') && url.includes('sku')) {
                        detailImages.add(url);
                    }
                });

                // 办法 B：扫描所有 div 的背景图 (针对 SSD 模块)
                detailBox.querySelectorAll('div, section').forEach(el => {
                    const bg = window.getComputedStyle(el).backgroundImage;
                    if (bg && bg !== 'none') {
                        const match = bg.match(/url\("?(.+?)"?\)/);
                        if (match && match[1] && match[1].includes('sku')) detailImages.add(match[1]);
                    }
                    // 扫描京东特有的 ssd-module 数据属性
                    const ssdBg = el.getAttribute('data-bg') || el.style.backgroundImage;
                    if (ssdBg && ssdBg.includes('//') && ssdBg.includes('sku')) {
                        detailImages.add(ssdBg.replace(/url\(["']?/, '').replace(/["']?\)/, ''));
                    }
                });
            }

            // 3. 格式化清洗
            const cleanDetails = Array.from(detailImages)
                .map(url => url.startsWith('http') ? url : 'https:' + url)
                .map(url => url.replace(/\.avif$/, '').split('!')[0]);

            return { mainImages, detailImages: cleanDetails };
        });

        console.log(`🖼️ [图片提取] 抓取到 ${imagesData.mainImages.length} 张主图，${imagesData.detailImages.length} 张带 sku 的纯净商详图。`);
        // -----------------------------------------------------------------
        // 🚀 增量模块：探查并截获京东主图视频
        // -----------------------------------------------------------------
        console.log(`🎥 [自动化] 尝试探查主图视频...`);
        const jdVideoUrl = await pageJD.evaluate(() => {
            let vUrl = '';
            try {
                if (window.pageConfig && window.pageConfig.product && window.pageConfig.product.videoInfo) {
                    vUrl = window.pageConfig.product.videoInfo.playUrl || '';
                }
                if (!vUrl) {
                    const btn = document.querySelector('.video-icon');
                    if (btn) vUrl = btn.getAttribute('data-video') || '';
                }
                if (!vUrl) {
                    const v = document.querySelector('video');
                    if (v && v.src && !v.src.startsWith('blob:')) vUrl = v.src;
                }
                if (vUrl && !vUrl.startsWith('http')) vUrl = 'https:' + vUrl;
            } catch (e) {}
            return vUrl;
        });

        if (jdVideoUrl) {
            console.log(`🎯 [侦测成功] 截获主图视频链接: ${jdVideoUrl}`);
        } else {
            console.log(`⚠️ 未发现主图视频，跳过视频搬运。`);
        }
        // 兜底检查
        if (Object.keys(jdRawData).length === 0) {
            throw new Error('未能在京东页面抓取到有效文本参数，终止同步。');
        }

        // 保存京东端登录状态
        await contextJD.storageState({ path: jdStatePath });

        // ==========================================
        // 阶段二：本地极速清洗与熔断判定
        // ==========================================
        // ⚠️ 动态传入目标类目名称（如"油烟机"、"净水器"等）
        const targetCategory = "净水器";
        console.log(`\n⚙️ [数据清洗] 当前目标类目：【${targetCategory}】`);

        if (!categoryDict[targetCategory]) {
            // 核心熔断逻辑：找不到直接报错
            throw new Error(`类目【${targetCategory}】不在本地字典 category_mapping.json 中，拒绝盲填！`);
        }

        console.log(`✅ 匹配到【${targetCategory}】映射规则，开始极速清洗...`);
        let cleanPddData = {};
        const rules = categoryDict[targetCategory].direct_mapping;
        
        for (const rule of rules) {
            for (const jdKey of rule.jd_keywords) {
                if (jdRawData[jdKey]) {
                    let val = jdRawData[jdKey];
                    
                    if (rule.action === 'replace' && rule.replace_rule) {
                        for (const [oldStr, newStr] of Object.entries(rule.replace_rule)) {
                            val = val.replace(oldStr, newStr);
                        }
                    } else if (rule.action === 'extract_number') {
                        // 提取纯数字 (剔除单位)
                        const numMatch = val.match(/\d+(\.\d+)?/);
                        if (numMatch) val = numMatch[0];
                    } else if (rule.action === 'math_multiply' && rule.multiplier) {
                        // 针对特定需要转换单位的字段 (如：2.79 * 60)
                        const numMatch = val.match(/\d+(\.\d+)?/);
                        if (numMatch) {
                            val = (parseFloat(numMatch[0]) * rule.multiplier).toString();
                        }
                    }
                    
                    cleanPddData[rule.pdd_key] = val;
                    break;
                }
            }
        }
        console.log(`✨ [数据清洗] 清洗完毕，得到 PDD 待填参数字典：`, cleanPddData);

        // ==========================================
        // 阶段三：拼多多全自动进入编辑页与填表
        // ==========================================
        console.log(`\n🔄 [拼多多端] 准备自动搜索并进入目标商品编辑页...`);
        pagePDD = await contextPDD.newPage();
        
        // ⚠️ 在这里指定你需要修改的拼多多商品 ID
        const targetPddItemId = '926574119933';
        await pagePDD.goto('https://mms.pinduoduo.com/goods/goods_list', { waitUntil: 'domcontentloaded' });
        
        console.log(`🔍 [自动化] 定位【商品ID】输入框...`);
        console.log(`⏳ 若触发登录拦截，请手动扫码，程序将无限期静默等待...`);
        const inputPDD = pagePDD.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
        
        // 挂起等待，防掉线
        await inputPDD.waitFor({ state: 'visible', timeout: 0 });
        
        await inputPDD.fill(targetPddItemId);
        
        // 触发底层数据绑定以激活查询按钮
        await inputPDD.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        await pagePDD.getByRole('button', { name: '查询' }).click();

        // 清理查询后可能出现的首次弹窗
        try {
            await pagePDD.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 });
            await pagePDD.getByTestId('beast-core-modal-close-button').click();
        } catch (e) {}

        console.log(`🖱️ [自动化] 锁定【编辑】按钮并处理潜伏弹窗...`);
        const editBtnPDD = pagePDD.getByTestId('beast-core-table-body-tr').getByText('编辑').first();
        await editBtnPDD.waitFor({ state: 'visible', timeout: 10000 });

        // 核心时机：新页面监听器必须挂在点击动作之前
        const newPagePromisePDD = contextPDD.waitForEvent('page');
        await editBtnPDD.click();

        // 击杀点击编辑后极易出现的“我知道了”拦截弹窗
        try {
            const modalCloseBtn = pagePDD.getByTestId('beast-core-modal-close-button');
            await modalCloseBtn.waitFor({ state: 'visible', timeout: 3000 });
            console.log(`⏳ [自动化] 击杀进入编辑前的拦截弹窗...`);
            await modalCloseBtn.click();
        } catch (e) {}

        const editPagePDD = await newPagePromisePDD;
        await editPagePDD.waitForLoadState('domcontentloaded');
        
        // 等待底层 React 表单和属性坑位完成渲染
        await editPagePDD.waitForTimeout(4000); 

        console.log(`✅ [自动化] 已成功进入商品 ${targetPddItemId} 的编辑页面！`);
        
        // 激活强力文本填表引擎
        await autoFillPinduoduo(editPagePDD, cleanPddData);

        // ==========================================
        // 🚀 主图与商详图全自动搬运 (表单锚定 + JS 强力击杀)
        // ==========================================
        
        // ------ [主图处理模块] ------
        console.log(`\n===========================================`);
        console.log(`🖼️ [主图上传引擎] 启动：下载 -> 删旧 -> 传新`);
        try {
            const localMainImages = await downloadImagesToLocal(imagesData.mainImages, 'main');
            if (localMainImages.length > 0) {
                await editPagePDD.waitForTimeout(2000);

                console.log(`🧹 [自动化] 锁定主图区域并滚动至视口中央...`);
                const mainImageRow = editPagePDD.locator('[data-testid="beast-core-form-item"]').filter({ hasText: /商品轮播图|商品主图/ }).first();
                await mainImageRow.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' })).catch(() => {});
                await editPagePDD.waitForTimeout(1000);

                // 💥 完美还原你验证过的极简且最稳健的删图逻辑 (天然防误伤视频)
                const deleteIcons = mainImageRow.locator('i[class*="DeleteIcon"]'); 
                let deleteCount = await deleteIcons.count();

                console.log(`🔍 扫描到 ${deleteCount} 张占用坑位的旧图。`);

                while (deleteCount > 0) {
                    try {
                        console.log(`⏳ [降维打击] 注入 React 信任点击事件，剩余 ${deleteCount} 张...`);
                        const firstIcon = deleteIcons.first();
                        
                        // 💥 终极魔法：dispatchEvent
                        await firstIcon.dispatchEvent('click');
                        
                        // 等待 React 将该图片节点从虚拟 DOM 中完全卸载
                        await editPagePDD.waitForTimeout(800); 
                    } catch (clickErr) {
                        console.log(`⚠️ 信任事件击杀受阻，跳出清理循环: ${clickErr.message}`);
                        break;
                    }
                    // 重新统计，如果数量减少，说明击杀成功！
                    deleteCount = await deleteIcons.count();
                }
                console.log(`✅ [清理完毕] 旧主图坑位已全部腾出。`);

                console.log(`📤 [自动化] 正在批量注入 ${localMainImages.length} 张新主图...`);
                await editPagePDD.waitForTimeout(2000); 
                
                // 💥 核心防误伤：使用你抓取到的专属 ID 强力锁定图片上传口，彻底根除传进视频框的 Bug！
                const mainUploadInput = editPagePDD.locator('input[data-tracking-click-viewid="carousel_img_localfile_upload"]').first();
                
                if (await mainUploadInput.count() === 0) {
                    throw new Error("找不到主图专属图片上传口。");
                }
                
                // 极速注入本地文件
                await mainUploadInput.setInputFiles(localMainImages);
                console.log(`✅ [主图上传引擎] 注入成功！等待后台生成...`);
                await editPagePDD.waitForTimeout(3000); 
            }
        } catch (error) {
            console.error(`❌ [主图异常]`, error.message);
        }
        // ==========================================
        // 🚀 增量模块：商详视频独立上传引擎
        // ==========================================
        if (typeof jdVideoUrl !== 'undefined' && jdVideoUrl) {
            console.log(`\n===========================================`);
            console.log(`🎬 [商详视频引擎] 启动：下载 -> 删旧 -> 传新`);
            try {
                // 1. 下载原视频
                const rawVideoPath = await downloadVideoToLocal(jdVideoUrl);
                
                if (rawVideoPath) {
                    // 2. ⚡ 触发剪辑引擎进行掐头去尾
                    const localVideoPath = await trimVideoLocal(rawVideoPath);

                    await editPagePDD.waitForTimeout(2000);

                    // 1. 精准锁定商详视频区域 (利用提供的专属 ID)
                    console.log(`🧹 [自动化] 锁定商详视频区域...`);
                    const videoRow = editPagePDD.locator('#detail_video').first();
                    await videoRow.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' })).catch(() => {});
                    await editPagePDD.waitForTimeout(1000);

                    // 2. 独立删旧逻辑
                    const videoDeleteIcon = videoRow.locator('i[class*="DeleteIcon"]').first();
                    if (await videoDeleteIcon.count() > 0) {
                        console.log(`⏳ 发现旧视频占用坑位，正在执行信任事件击杀...`);
                        await videoDeleteIcon.dispatchEvent('click');
                        await editPagePDD.waitForTimeout(1500); // 视频组件卸载耗时较长
                        console.log(`✅ 旧视频已安全清除。`);
                    }

                    // 3. 传新逻辑 (利用专属特征锁定 input)
                    console.log(`📤 [自动化] 正在注入新视频...`);
                    const videoUploadInput = editPagePDD.locator('input[data-tracking-click-viewid="detail_video_localfile_upload"]').first();
                    
                    if (await videoUploadInput.count() === 0) {
                        throw new Error("找不到商详视频专属的上传 input。");
                    }
                    
                    // 注入本地视频文件
                    await videoUploadInput.setInputFiles(localVideoPath);
                    console.log(`✅ [视频上传引擎] 注入成功！视频文件庞大，正在预留后台转码时间...`);
                    
                    // 强制等待：视频切片与转码极其耗时，必须给足时间防止后续 DOM 操作卡死
                    await editPagePDD.waitForTimeout(10000); 
                }
            } catch (error) {
                console.error(`❌ [视频引擎异常]`, error.message);
                const timestamp = new Date().getTime();
                const errPath = path.join(__dirname, `error_detail_video_upload_${timestamp}.png`);
                await editPagePDD.screenshot({ path: errPath, fullPage: true });
                console.log(`📸 视频上传异常现场截图已保存至：${errPath}`);
            }
        }
        // ------ [详情图处理模块] ------
        console.log(`\n===========================================`);
        console.log(`📜 [详情图上传引擎] 启动：下载 -> 删旧(留一) -> 传新 -> 斩草除根`);
        try {
            // 1. 先把原始图片下载到本地
            const rawDetailImages = await downloadImagesToLocal(imagesData.detailImages, 'detail');
            
            if (rawDetailImages.length > 0) {
                // 2. 💥 插入图片合规引擎：切片、压缩、修正尺寸
                const localDetailImages = await processImagesForPDD(rawDetailImages);
                
                console.log(`🛬 [自动化] 强制深潜滚动，激活底部懒加载组件...`);
                await editPagePDD.evaluate(() => window.scrollBy(0, 1500));
                await editPagePDD.waitForTimeout(800);
                await editPagePDD.evaluate(() => window.scrollBy(0, 1500));
                await editPagePDD.waitForTimeout(1500);

                // 🎯 删旧：全局特征锁定（不依赖表单框）
                const detailDeleteIcons = editPagePDD.locator('.quick_decoration_v2_remarkImage__3tJyD i[class*="DeleteIcon"]'); 
                let detailDeleteCount = await detailDeleteIcons.count();
                
                let anchorKept = false;

                if (detailDeleteCount > 0) {
                    console.log(`🔍 锁定 ${detailDeleteCount} 张旧详情图，启动【留一法】清理策略。`);
                    // 严格执行循环，直至仅剩 1 张锚点
                    while (detailDeleteCount > 1) {
                        try {
                            console.log(`⏳ 击杀旧图，剩余 ${detailDeleteCount} 张 (目标: 保留 1 张锚点)...`);
                            await detailDeleteIcons.last().dispatchEvent('click');
                            await editPagePDD.waitForTimeout(800); 
                        } catch (clickErr) {
                            console.log(`⚠️ 击杀受阻: ${clickErr.message}`);
                            break;
                        }
                        detailDeleteCount = await detailDeleteIcons.count();
                    }
                    console.log(`✅ [阶段一] 已将旧图清理至最后 1 张，维持底层组件存活。`);
                    anchorKept = true;
                }

                console.log(`📤 [自动化] 正在批量注入 ${localDetailImages.length} 张新详情图...`);
                await editPagePDD.waitForTimeout(1000); 
                
                // 💥 传新：终极精准锁定，直接利用你抓取到的专属 ID 穿透定位！彻底无视层级关系
                const detailUploadInput = editPagePDD.locator('input[data-tracking-click-viewid="detail_img_localfile_upload"]').first();
                
                if (await detailUploadInput.count() === 0) {
                    throw new Error("使用专属 ID 依然找不到商详图上传入口，请确认页面是否已完全滚到底部。");
                }
                
                // 极速注入本地文件
                await detailUploadInput.setInputFiles(localDetailImages);
                console.log(`✅ 注入成功，正在等待拼多多后台切片与校验...`);
                
                // 商详图数据庞大，必须留出严格的 8-10 秒缓冲时间，防卡死
                await editPagePDD.waitForTimeout(8000); 

                // 🪓 回马枪：除掉最初留下的那个锚点
                if (anchorKept) {
                    console.log(`🪓 [自动化] 启动回马枪：清除初始保留的那 1 张旧图锚点...`);
                    // 重新获取节点实例。新图按顺序排列在后，旧图必定被顶在第 1 位
                    const finalIcons = editPagePDD.locator('.quick_decoration_v2_remarkImage__3tJyD i[class*="DeleteIcon"]');
                    const finalCount = await finalIcons.count();
                    
                    // 只要当前图片总数大于我们新传的数量，说明旧图还霸占着第一个位置
                    if (finalCount > localDetailImages.length) {
                        await finalIcons.first().dispatchEvent('click');
                        await editPagePDD.waitForTimeout(1000);
                        console.log(`✅ [终极清理] 首部旧图锚点击杀完毕！`);
                    }
                }
                
                console.log(`🎉 [详情图上传引擎] 流程完美闭环。`);
            }
        } catch (error) {
            console.error(`❌ [详情图异常]`, error.message);
            const timestamp = new Date().getTime();
            const errPath = path.join(__dirname, `error_detail_upload_${timestamp}.png`);
            await editPagePDD.screenshot({ path: errPath, fullPage: true });
        }

        await contextPDD.storageState({ path: pddStatePath });
        console.log('>>> 🎉 所有数据、主图、详情图搬运完成。浏览器将保持开启状态，按 Ctrl+C 结束。');

    } catch (error) {
        console.error('\n❌ [程序阻断] 运行出错:', error.message);
        // 容错机制：保存错误截图防崩溃
        if (pagePDD) {
            const timestamp = new Date().getTime();
            const screenshotPath = path.join(__dirname, `error_pdd_fill_${timestamp}.png`);
            await pagePDD.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`📸 已自动保存拼多多端错误现场截图至：${screenshotPath}`);
        }
    }
})();