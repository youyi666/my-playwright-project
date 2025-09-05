@echo off

echo ======================================================
echo      Starting all report download tasks...
echo      Current time: %date% %time%
echo ======================================================
echo.

echo --- [1/2] Running: Alimama WXT Report Download ---
node "tests\TM_run_sycm_download.js"
echo --- [1/2] Alimama WXT Report Download Finished ---

echo.

echo --- [2/2] Running: Tmall SYCM Report Download ---
node "tests\WXT_run_alimama_download.js"
echo --- [2/2] Tmall SYCM Report Download Finished ---

echo.
echo ======================================================
echo      All download tasks have been executed!
echo ======================================================
echo.
pause