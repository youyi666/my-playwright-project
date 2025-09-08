@echo off
REM =================================================================
REM  全平台爬虫自动执行主控脚本 (v1.1 - 编码修正版)
REM =================================================================

REM 切换代码页为UTF-8，解决Python打印时的编码错误和控制台乱码问题
chcp 65001 > nul

REM 设置脚本所在的目录路径
set SCRIPT_DIR="C:\Users\Administrator\my-playwright-project\tests"

REM 设置Node和Python的路径
set NODE_PATH=node
set PYTHON_PATH=python

echo.
echo [INFO] Automation script started at %date% %time%
echo [INFO] Script directory is: %SCRIPT_DIR%
echo.

REM 切换到脚本所在的目录
cd /d %SCRIPT_DIR%

REM --- 依次执行各个平台的爬虫脚本 ---

echo [STEP 1/3] Running Taobao scraper...
%NODE_PATH% TAOBAO_run_taobao_scraper.js
echo [INFO] Taobao scraper finished.
echo.

echo [STEP 2/3] Running Youpin scraper...
%NODE_PATH% YP_run_youpin_scraper.js
echo [INFO] Youpin scraper finished.
echo.

echo [STEP 3/3] Running Jingdong scraper...
%PYTHON_PATH% JD_run_jingdong_scraper.py
echo [INFO] Jingdong scraper finished.
echo.


echo [SUCCESS] All scraping tasks completed at %date% %time%
echo.

REM 暂停5秒后自动关闭窗口
timeout /t 5