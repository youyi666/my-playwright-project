/**
 * 🚀 拼多多全自动智能填表引擎 (兼容填空与下拉)
 * @param {Page} page - Playwright 的 page 对象
 * @param {Object} cleanData - 洗好的纯中文 JSON 字典，如 {"厚": "375", "控制面板材质": "钢化玻璃"}
 */
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
            
            // 3. 统一操作：点击并填入内容（下拉框会被触发搜索，普通框会被直接输入）
            await inputElement.click({ force: true });
            await inputElement.fill(targetValue.toString());
            
            // 给复杂的 React 动画 0.5 秒的渲染时间
            await page.waitForTimeout(500);

            // 4. 智能判断分支：寻找是否有悬浮出来的下拉菜单项
            // .last() 防止匹配到原有文本，精准命中最后弹出的 DOM 节点
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
    console.log(`🤖 [填表引擎] 全部属性注入完毕！`);
    console.log(`===========================================\n`);
}