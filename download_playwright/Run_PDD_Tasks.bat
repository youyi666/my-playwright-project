@echo off
:: 设置字符集为 UTF-8，防止 Node.js 输出的中文日志出现乱码
chcp 65001 >nul

:: 定义日志文件的绝对路径（可自行修改保存位置）
set LOG_FILE="D:\WorkSpace\03_Dev_自动化开发\001号爬虫文件My-Playwright-Project\download_playwright\pdd_task_scheduler.log"

:: 将括号内所有命令的输出（含标准输出和错误输出）全部重定向到日志文件中
(
    echo =======================================================
    echo [%date% %time%] 拼多多自动化定时任务触发
    echo =======================================================

    :: 核心：切换工作目录到项目根路径。这对于 Playwright 读取本地 User Data Dir 或配置文件至关重要
    cd /d "D:\WorkSpace\03_Dev_自动化开发\001号爬虫文件My-Playwright-Project\download_playwright"

    echo [%time%] ----------------------------------------------
    echo [%time%] 启动阶段一：00-PDD_Unified_Full_Task.cjs
    node "00-PDD_Unified_Full_Task.cjs"
    
    :: 检查上一步执行的状态码，如果遇到严重崩溃可以记录
    if %errorlevel% neq 0 (
        echo [ERROR] 阶段一执行发生异常，退出码: %errorlevel%
    )

    echo [%time%] ----------------------------------------------
    echo [%time%] 启动阶段二：pddprice-scraper.cjs
    :: 由于已经切换了工作目录，这里直接使用相对路径即可
    node "新开发一个拼多多价格监控的逻辑\pddprice-scraper.cjs"

    if %errorlevel% neq 0 (
        echo [ERROR] 阶段二执行发生异常，退出码: %errorlevel%
    )

    echo [%time%] ==============================================
    echo [%time%] 任务流结束。
    echo.
) >> %LOG_FILE% 2>&1