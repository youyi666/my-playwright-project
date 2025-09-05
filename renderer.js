// renderer.js (渲染进程)
// 负责监听来自主进程的事件，并更新UI（进度条、状态文本、最终报告）。

const { ipcRenderer } = require('electron');

const statusEl = document.getElementById('status');
const progressBarEl = document.getElementById('progressBar');
const reportEl = document.getElementById('report');

// 页面加载完成后，通知主进程可以开始工作了
window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.send('start-processing');
});

// 监听进度更新事件
ipcRenderer.on('progress-update', (event, { progress, message }) => {
    statusEl.textContent = message;
    progressBarEl.value = progress;
});

// 监听处理完成事件
ipcRenderer.on('processing-complete', (event, log) => {
    statusEl.textContent = '处理完成！';
    progressBarEl.value = 100;

    // 格式化并显示最终报告
    const { fileOperations, dbSyncFromUserFiles, dbSyncFromFolderScan, unmatched, errors } = log;
    let report = [];
    const hasIssues = unmatched.length > 0 || errors.length > 0;

    if (hasIssues) {
        report.push("任务完成，但存在以下问题：\n");
        if (unmatched.length > 0) {
            report.push("\n--- 未匹配规则的文件 ---");
            unmatched.forEach(filename => report.push(`✗ 未处理：'${filename}'`));
        }
        if (errors.length > 0) {
            report.push("\n--- 发生错误 ---");
            errors.forEach(err => report.push(`❗ 错误：'${err.filename}' - ${err.error}`));
        }
    } else {
        report.push("所有任务已成功完成！");
    }
    
    const totalSynced = dbSyncFromFolderScan.filter(op => op.status === 'Success').length + dbSyncFromUserFiles.filter(op => op.status === 'Success').length;
    const summary = `
--- 最终统计 ---
成功归档新文件: ${fileOperations.length} 个
成功同步到数据库: ${totalSynced} 个文件
未匹配规则: ${unmatched.length} 个
处理失败: ${errors.length} 个
`;

    reportEl.textContent = report.join('\n') + "\n" + summary.trim();
    reportEl.style.display = 'block';
});
