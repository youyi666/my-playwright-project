@echo off
REM =================================================================
REM  Automation Control Script (v4.4 - Parentheses Echo Fix)
REM =================================================================
REM  - Previous v4.3 fixed syntax/paths.
REM  - This v4.4 fixes echo statements with unescaped parentheses.
REM  - Runs all tasks to completion, records status, and retries failures.
REM  - Final summary report generated.
REM =================================================================

REM Set console to UTF-8 for Node.js/Python output
chcp 65001 > nul

REM --- Environment and Path Variables ---
REM --- MODIFIED ---
REM Removed quotes from the value and added them around the variable assignment.
REM This is a safer way to handle paths with spaces.
set "PROJECT_DIR=C:\Users\Administrator\my-playwright-project"
set "STATUS_DIR=%PROJECT_DIR%\script_status"
set "NODE_PATH=node"
set "PYTHON_PATH=python"

REM =================================================================
REM  RESET NOTE: To force a full re-run of all tasks,
REM  manually delete the folder at %STATUS_DIR%
REM =================================================================
echo.

REM Create the status directory if it does not exist
if not exist "%STATUS_DIR%" (
    echo [INFO] Creating status directory for the first time...
    mkdir "%STATUS_DIR%"
    echo.
)

REM =================================================================
REM  Executing Main Tasks (10 total)
REM =================================================================

REM --- Step 1: Taobao Scraper ---
if exist "%STATUS_DIR%\step_1_success.flag" (
    echo "[SKIPPED] Step 1/10 (Taobao scraper) is already complete."
) else (
    echo [STEP 1/10] Running Taobao scraper...
    %NODE_PATH% "%PROJECT_DIR%\jd_yp_taobao-scraper\TAOBAO_run_taobao_scraper.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 1/10 finished.
        echo done > "%STATUS_DIR%\step_1_success.flag"
        if exist "%STATUS_DIR%\step_1_failure.flag" del "%STATUS_DIR%\step_1_failure.flag"
    ) else (
        echo [FAILED] Step 1/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_1_failure.flag"
    )
)
echo.


REM --- Step 2: Youpin Scraper ---
if exist "%STATUS_DIR%\step_2_success.flag" (
    echo "[SKIPPED] Step 2/10 (Youpin scraper) is already complete."
) else (
    echo [STEP 2/10] Running Youpin scraper...
    %NODE_PATH% "%PROJECT_DIR%\jd_yp_taobao-scraper\YP_run_youpin_scraper.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 2/10 finished.
        echo done > "%STATUS_DIR%\step_2_success.flag"
        if exist "%STATUS_DIR%\step_2_failure.flag" del "%STATUS_DIR%\step_2_failure.flag"
    ) else (
        echo [FAILED] Step 2/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_2_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 3: Jingdong Scraper ---
if exist "%STATUS_DIR%\step_3_success.flag" (
    echo "[SKIPPED] Step 3/10 (Jingdong scraper) is already complete."
) else (
    echo [STEP 3/10] Preparing and Running Jingdong scraper...
    echo [INFO] Opening specific Microsoft Edge for JD...
    START "" "C:\Users\Administrator\Desktop\Microsoft Edge (jd).lnk"
    echo [INFO] Waiting 10 seconds for the browser to load...
    timeout /t 10 /nobreak 
    
    set PYTHONIOENCODING=utf-8
    %PYTHON_PATH% "%PROJECT_DIR%\jd_yp_taobao-scraper\JD_run_jingdong_scraper.py"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 3/10 finished.
        echo done > "%STATUS_DIR%\step_3_success.flag"
        if exist "%STATUS_DIR%\step_3_failure.flag" del "%STATUS_DIR%\step_3_failure.flag"
    ) else (
        echo [FAILED] Step 3/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_3_failure.flag"
    )
    set PYTHONIOENCODING=
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 4: Taobao List Scraper ---
if exist "%STATUS_DIR%\step_4_success.flag" (
    echo "[SKIPPED] Step 4/10 (Taobao List scraper) is already complete."
) else (
    echo [STEP 4/10] Running Taobao List scraper...
    %NODE_PATH% "%PROJECT_DIR%\jd_yp_taobao-scraper\run_taobao_list_scraper.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 4/10 finished.
        echo done > "%STATUS_DIR%\step_4_success.flag"
        if exist "%STATUS_DIR%\step_4_failure.flag" del "%STATUS_DIR%\step_4_failure.flag"
    ) else (
        echo [FAILED] Step 4/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_4_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 5: Price Change Report Script ---
if exist "%STATUS_DIR%\step_5_success.flag" (
    echo "[SKIPPED] Step 5/10 (Price Change Report) is already complete."
) else (
    echo [STEP 5/10] Running Price Change Report script...
    set PYTHONIOENCODING=utf-8
    %PYTHON_PATH% "%PROJECT_DIR%\jd_yp_taobao-scraper\price_change_report2.py"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 5/10 finished.
        echo done > "%STATUS_DIR%\step_5_success.flag"
        if exist "%STATUS_DIR%\step_5_failure.flag" del "%STATUS_DIR%\step_5_failure.flag"
    ) else (
        echo [FAILED] Step 5/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_5_failure.flag"
    )
    set PYTHONIOENCODING=
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 6: Tmall SYCM Report Download ---
if exist "%STATUS_DIR%\step_6_success.flag" (
    echo "[SKIPPED] Step 6/10 (Tmall SYCM Download) is already complete."
) else (
    echo [STEP 6/10] Running Tmall SYCM Report Download...
    %NODE_PATH% "%PROJECT_DIR%\download_playwright\TM_run_sycm_download.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 6/10 finished.
        echo done > "%STATUS_DIR%\step_6_success.flag"
        if exist "%STATUS_DIR%\step_6_failure.flag" del "%STATUS_DIR%\step_6_failure.flag"
    ) else (
        echo [FAILED] Step 6/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_6_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 7: Alimama WXT Report Download ---
if exist "%STATUS_DIR%\step_7_success.flag" (
    echo "[SKIPPED] Step 7/10 (Alimama WXT Download) is already complete."
) else (
    echo [STEP 7/10] Running Alimama WXT Report Download...
    %NODE_PATH% "%PROJECT_DIR%\download_playwright\WXT_run_alimama_download.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 7/10 finished.
        echo done > "%STATUS_DIR%\step_7_success.flag"
        if exist "%STATUS_DIR%\step_7_failure.flag" del "%STATUS_DIR%\step_7_failure.flag"
    ) else (
        echo [FAILED] Step 7/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_7_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 8: PDD General Report Download ---
if exist "%STATUS_DIR%\step_8_success.flag" (
    echo "[SKIPPED] Step 8/10 (PDD General Download) is already complete."
) else (
    echo [STEP 8/10] Running PDD General Report Download...
    %NODE_PATH% "%PROJECT_DIR%\download_playwright\PDD\download_reports.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 8/10 finished.
        echo done > "%STATUS_DIR%\step_8_success.flag"
        if exist "%STATUS_DIR%\step_8_failure.flag" del "%STATUS_DIR%\step_8_failure.flag"
    ) else (
        echo [FAILED] Step 8/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_8_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 9: PDD Viomi Report Download ---
if exist "%STATUS_DIR%\step_9_success.flag" (
    echo "[SKIPPED] Step 9/10 (PDD Viomi Download) is already complete."
) else (
    echo [STEP 9/10] Running PDD Viomi Report Download...
    %NODE_PATH% "%PROJECT_DIR%\download_playwright\suviomi_download\pdd_viomi-download.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 9/10 finished.
        echo done > "%STATUS_DIR%\step_9_success.flag"
        if exist "%STATUS_DIR%\step_9_failure.flag" del "%STATUS_DIR%\step_9_failure.flag"
    ) else (
        echo [FAILED] Step 9/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_9_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM --- Step 10: PDD Viomi Comprehensive Report Download ---
if exist "%STATUS_DIR%\step_10_success.flag" (
    echo "[SKIPPED] Step 10/10 (PDD Viomi Comprehensive) is already complete."
) else (
    echo [STEP 10/10] Running PDD Viomi Comprehensive Report Download...
    %NODE_PATH% "%PROJECT_DIR%\download_playwright\suviomi_download\zonghe_viomi-download.js"
    if %errorlevel% equ 0 (
        echo [SUCCESS] Step 10/10 finished.
        echo done > "%STATUS_DIR%\step_10_success.flag"
        if exist "%STATUS_DIR%\step_10_failure.flag" del "%STATUS_DIR%\step_10_failure.flag"
    ) else (
        echo [FAILED] Step 10/10 failed! Recording failure and continuing...
        echo failed > "%STATUS_DIR%\step_10_failure.flag"
    )
)
REM --- MODIFIED --- Removed erroneous '}' from here.
echo.


REM =================================================================
REM  Final Execution Summary Report
REM =================================================================
echo.
echo -----------------------------------------------------------------
echo                           Execution Summary Report
echo -----------------------------------------------------------------
echo.

IF EXIST "%STATUS_DIR%\step_1_success.flag" ( echo  "[SUCCESS] - Step 1/10 (Taobao scraper)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_1_failure.flag" ( echo  "[ FAILED ] - Step 1/10 (Taobao scraper)" ) ELSE ( echo  "[SKIPPED] - Step 1/10 (Taobao scraper)" ) )
IF EXIST "%STATUS_DIR%\step_2_success.flag" ( echo  "[SUCCESS] - Step 2/10 (Youpin scraper)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_2_failure.flag" ( echo  "[ FAILED ] - Step 2/10 (Youpin scraper)" ) ELSE ( echo  "[SKIPPED] - Step 2/10 (Youpin scraper)" ) )
IF EXIST "%STATUS_DIR%\step_3_success.flag" ( echo  "[SUCCESS] - Step 3/10 (Jingdong scraper)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_3_failure.flag" ( echo  "[ FAILED ] - Step 3/10 (Jingdong scraper)" ) ELSE ( echo  "[SKIPPED] - Step 3/10 (Jingdong scraper)" ) )
IF EXIST "%STATUS_DIR%\step_4_success.flag" ( echo  "[SUCCESS] - Step 4/10 (Taobao List scraper)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_4_failure.flag" ( echo  "[ FAILED ] - Step 4/10 (Taobao List scraper)" ) ELSE ( echo  "[SKIPPED] - Step 4/10 (Taobao List scraper)" ) )
IF EXIST "%STATUS_DIR%\step_5_success.flag" ( echo  "[SUCCESS] - Step 5/10 (Price Change Report)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_5_failure.flag" ( echo  "[ FAILED ] - Step 5/10 (Price Change Report)" ) ELSE ( echo  "[SKIPPED] - Step 5/10 (Price Change Report)" ) )
IF EXIST "%STATUS_DIR%\step_6_success.flag" ( echo  "[SUCCESS] - Step 6/10 (Tmall SYCM Download)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_6_failure.flag" ( echo  "[ FAILED ] - Step 6/10 (Tmall SYCM Download)" ) ELSE ( echo  "[SKIPPED] - Step 6/10 (Tmall SYCM Download)" ) )
IF EXIST "%STATUS_DIR%\step_7_success.flag" ( echo  "[SUCCESS] - Step 7/10 (Alimama WXT Download)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_7_failure.flag" ( echo  "[ FAILED ] - Step 7/10 (Alimama WXT Download)" ) ELSE ( echo  "[SKIPPED] - Step 7/10 (Alimama WXT Download)" ) )
IF EXIST "%STATUS_DIR%\step_8_success.flag" ( echo  "[SUCCESS] - Step 8/10 (PDD General Download)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_8_failure.flag" ( echo  "[ FAILED ] - Step 8/10 (PDD General Download)" ) ELSE ( echo  "[SKIPPED] - Step 8/10 (PDD General Download)" ) )
IF EXIST "%STATUS_DIR%\step_9_success.flag" ( echo  "[SUCCESS] - Step 9/10 (PDD Viomi Download)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_9_failure.flag" ( echo  "[ FAILED ] - Step 9/10 (PDD Viomi Download)" ) ELSE ( echo  "[SKIPPED] - Step 9/10 (PDD Viomi Download)" ) )
IF EXIST "%STATUS_DIR%\step_10_success.flag" ( echo  "[SUCCESS] - Step 10/10 (PDD Viomi Comprehensive)" ) ELSE ( IF EXIST "%STATUS_DIR%\step_10_failure.flag" ( echo  "[ FAILED ] - Step 10/10 (PDD Viomi Comprehensive)" ) ELSE ( echo  "[SKIPPED] - Step 10/10 (PDD Viomi Comprehensive)" ) )

echo.
echo -----------------------------------------------------------------
echo.
echo [INFO] 再次运行此脚本以自动重试失败的任务。
REM 尝试关闭可能的后台进程
taskkill /IM msedge.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM python.exe /F >nul 2>&1
echo 脚本运行结束
exit