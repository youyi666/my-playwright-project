// tests/viomi-download.spec.js 还是不成功，没有思路，先暂停。8-28
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs'; // 【关键修正】将 fs 模块的导入移到文件顶部

// 从环境变量中读取用户名和密码
const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

test('自动登录并通过通知中心下载电商运营数据', async ({ page }) => {
  // 1. 登录
  await page.goto('https://sky.viomi.com.cn/login?redirect=%2Fbi%2Fdashboard%2Fmodule%3FprojectId%3D1%26sourceId%3D3377%26menuId%3D851');
  if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
    test.fail('错误：请设置 VIOMI_USERNAME 和 VIOMI_PASSWORD 环境变量。');
  }
  await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
  await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
  await page.getByRole('button', { name: '登 录' }).click();
  await page.waitForURL(/.*dashboard.*/, { timeout: 30000 });
  console.log('登录成功。');

  // 2. 导航到正确页面
  await page.getByText('运营分析').click();
  await page.getByText('电商运营').click();
  await page.waitForLoadState('networkidle');
  const retailOrderDetailLink = page.getByRole('menuitem', { name: 'dot-chart 零售订单明细' });
  await retailOrderDetailLink.waitFor({ state: 'visible' });
  await retailOrderDetailLink.click();
  console.log('已导航到零售订单明细页面。');

  // 3. 点击查询按钮
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '查 询' }).click();
  console.log('已点击查询按钮，正在等待报表数据加载...');

  // 4. 执行异步下载流程
  const reportTitle = page.getByRole('heading', { name: '线上零售明细', level: 4 });
  const reportCard = page.locator('div.container--r3tGG').filter({ has: reportTitle });
  await reportCard.scrollIntoViewIfNeeded();
  console.log('已滚动到 "线上零售明细" 报表位置。');

  const downloadIcon = reportCard.locator('img[alt="download"]');
  await downloadIcon.click();
  console.log('第一步：已点击 "线上零售明细" 报表的下载图标。');

  console.log('正在等待后台文件生成并出现通知...');
  const notificationBadge = page.locator('sup.ant-badge-dot, span.ant-badge-count');
  await notificationBadge.waitFor({ state: 'visible', timeout: 60000 });

  const bellIcon = page.locator('img[alt="bell"]');
  await bellIcon.click();
  console.log('第二步：检测到通知，已点击通知铃铛。');

  console.log('正在通知面板中查找最终下载链接...');
  const finalDownloadLink = page.getByText(/线上零售明细_(\d+)/);
  await finalDownloadLink.waitFor({ state: 'visible', timeout: 10000 });
  console.log(`第三步：已在通知面板中找到下载链接: ${await finalDownloadLink.textContent()}`);

  // 5. 监听下载事件并点击最终链接
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    finalDownloadLink.click()
  ]);

  // 6. 保存文件
  // 确保 'downloads' 文件夹存在
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
  const fileName = download.suggestedFilename();
  const filePath = path.join(downloadsDir, fileName);
  await download.saveAs(filePath);
  console.log(`\n表格已成功下载到: ${filePath}`);

  // 7. 验证文件
  const stats = fs.statSync(filePath);
  expect(stats.size).toBeGreaterThan(0);
  console.log(`文件验证成功，大小为: ${stats.size} 字节。`);
});