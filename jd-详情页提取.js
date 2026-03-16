(function extractJdDataV3() {
    // 1. 高清主图提取 (自动修正 n0 规格并剔除 avif)
    let mainImages = [];
    try {
        if (window.pageConfig && window.pageConfig.product && window.pageConfig.product.imageList) {
            mainImages = window.pageConfig.product.imageList.map(url => 'https://img10.360buyimg.com/n0/' + url.replace(/\.avif$/, ''));
        } else {
            mainImages = Array.from(document.querySelectorAll('.spec-items img'))
                .map(img => img.src.replace(/\/(n1|n5)\//, '/n0/').split('!')[0].replace(/\.avif$/, ''));
        }
    } catch(e) { console.log("主图抓取异常", e); }

    // 2. 详情页全能扫描 (模拟插件逻辑)
    const detailBox = document.querySelector('#detail') || document.querySelector('#J-detail-content') || document.body;
    let detailImages = new Set(); // 使用 Set 自动去重

    if (detailBox) {
        // 办法 A：扫描所有 img 标签
        detailBox.querySelectorAll('img').forEach(img => {
            const url = img.getAttribute('data-lazyload') || img.getAttribute('data-src') || img.src;
            if (url && url.includes('//') && !url.includes('blank.gif')) detailImages.add(url);
        });

        // 办法 B：扫描所有 div 的背景图 (针对 SSD 模块)
        detailBox.querySelectorAll('div, section').forEach(el => {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none') {
                const match = bg.match(/url\("?(.+?)"?\)/);
                if (match && match[1]) detailImages.add(match[1]);
            }
            // 扫描京东特有的 ssd-module 数据属性
            const ssdBg = el.getAttribute('data-bg') || el.style.backgroundImage;
            if (ssdBg && ssdBg.includes('//')) detailImages.add(ssdBg.replace(/url\(["']?/, '').replace(/["']?\)/, ''));
        });
    }

    // 3. 格式化清洗
    const cleanDetails = Array.from(detailImages)
        .map(url => url.startsWith('http') ? url : 'https:' + url)
        .map(url => url.replace(/\.avif$/, '').split('!')[0]); // 强力剔除 avif 和后缀

    const finalData = {
        "主图数量": mainImages.length,
        "详情图数量": cleanDetails.length,
        "主图列表": mainImages,
        "详情图列表": cleanDetails
    };

    console.log("%c🚀 [插件级提取] 成功！", "color: #ff4757; font-size: 18px; font-weight: bold;");
    console.dir(finalData);
})();