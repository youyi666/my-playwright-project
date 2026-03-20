// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * playwright.config.js 文件是 Playwright 的主配置文件。
 * 你可以在这里设置全局选项，配置不同的浏览器和设备，等等。
 * 更多信息请参考官方文档: https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  // 'testDir' 指定了测试文件存放的目录。
  // 默认情况下，Playwright 会在这里寻找测试脚本。
  testDir: './tests',

  /* =================================================================
   * 全局配置
   * =================================================================
   */

  // 测试用例总的超时时间（单位：毫秒）。
  // 如果单个测试文件运行超过这个时间，就会被标记为超时失败。
  // 我们设置为 5 分钟，以应对需要长时间运行的数据抓取任务。
  timeout: 5 * 60 * 1000, // 5 分钟

  // 对每个测试用例的期望(expect)断言设置一个默认的超时时间。
  expect: {
    timeout: 10000 // 10 秒
  },

  // 是否并行执行测试文件。
  // 对于数据抓取任务，我们通常一次只运行一个文件，可以设置为 false。
  fullyParallel: false,

  // 失败重试次数。
  // 0 表示不重试，1 表示失败后会重试 1 次。
  retries: 0,

  // 并行执行的 "工作线程" 数量。
  // undefined 表示 Playwright 会根据你的 CPU 核心数自动决定。
  // 设置为 1 表示一次只运行一个测试文件，顺序执行。
  workers: 1,

  // 测试报告的格式。'html' 是最常用的，会生成一个漂亮的网页报告。
  reporter: 'html',


  /* =================================================================
   * 所有测试共享的全局设置 (`use` 选项)
   * =================================================================
   */
  
  // 'use' 字段里的所有配置，都会作为默认设置应用到每一个测试用例中。
  use: {
    /*
     * ----------------------------------------------------------------
     * 【【【 这是最关键的配置！！！】】】
     * 'storageState' 会加载指定的登录状态文件或文件夹。
     * 这会让每个测试启动时，浏览器都已经是“已登录”状态，从而跳过登录步骤。
     * 我们指向之前手动生成的 'user-data' 文件夹。
     * ----------------------------------------------------------------
     */
    storageState: './su.viomi.com.cn.auth.json',  

    // 浏览器行为的相关配置
    headless: true, // 默认使用无头模式 (true)。如果你想看到浏览器界面，可以改为 false。
    actionTimeout: 0, // 操作超时时间（如 click, fill）。0 表示没有限制。

    // 收集测试轨迹 (Trace) 的方式。
    // 'on-first-retry' 表示第一次重试时收集，方便调试失败的用例。
    // 其他选项: 'off', 'on', 'retain-on-failure'
    trace: 'on-first-retry',

    // 截图时机
    screenshot: 'only-on-failure', // 'off', 'on', 'only-on-failure'

    // 录制视频时机
    video: 'off', // 'off', 'on', 'retain-on-failure', 'on-first-retry'
  },


  /* =================================================================
   * 配置不同的项目/浏览器
   * =================================================================
   */
  // 'projects' 允许你为不同的浏览器或设备配置不同的测试环境。
  // 默认情况下，Playwright 会使用 Chromium, Firefox 和 WebKit 同时测试。
  // 对于数据抓取，我们通常只需要一个浏览器，可以只保留 Chromium。
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    
    // 如果你将来也想在 Firefox 或 Safari 中测试，可以取消下面的注释
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],
});