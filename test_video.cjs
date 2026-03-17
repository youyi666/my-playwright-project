const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function downloadVideoToLocal(videoUrl) {
    if (!videoUrl) return null;
    
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    console.log(`\n🎬 [视频下载引擎] 建立连接，准备拉取数据...`);
    const fileName = `test_main_video_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    try {
        const response = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream', // 核心机制：以流的形式分块下载大文件，防止内存溢出
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://item.jd.com/'
            },
            timeout: 60000 // 视频文件较大，强行将超时阈值拉高至 60 秒
        });
        
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        let downloadedBytes = 0;
        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            process.stdout.write(`\r⏳ 正在写入物理文件，已下载: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB`);
        });

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        console.log(`\n✅ [下载大捷] 视频已成功落盘至: ${filePath}`);
        return filePath;
    } catch (error) {
        console.error(`\n❌ [下载失败] 网络或写入异常: ${error.message}`);
        return null;
    }
}

// 立即执行测试
(async () => {
    // ⚠️ 请将此处替换为你用控制台提取出来的真实京东 MP4 链接
    const testUrl = "https://vod.300hu.com/24/4c1f7a6atransbjngwcloud1oss/592c0e701023608763960037377/1097_5000_1_fc69e9e72_f.mp4?source=1&h265=1133_2500_1_9d51007c6_f.mp4";
    
    if (testUrl.includes('此处填入')) {
        console.log('⚠️ 拒绝执行：请先在代码中填入真实的视频测试链接。');
        process.exit(1);
    }
    
    await downloadVideoToLocal(testUrl);
})();