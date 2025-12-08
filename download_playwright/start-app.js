// start-app.js - 核心任务启动器 (ESM Compatible)

import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

// --- ESM Compatibility: Define __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- End ESM Compatibility ---

// Define task script paths (assuming current folder is download_playwright)
const SCRIPTS = {
    'task01': path.join(__dirname, '01-PDD_Integrated_Downloader.js'),
    'task02': path.join(__dirname, '02-Viomi_PDD_Sales_Fixer.js'),
    'task03': path.join(__dirname, '03-Viomi_ZongHe_Sales_Downloader.js'),
    'task04': path.join(__dirname, '04-PDD_Activity_Monitor.js'),
};

/**
 * Checks if the script exists and executes it using 'node'.
 * @param {string} scriptKey - The key of the script to run.
 */
function executeScript(scriptKey) {
    const scriptPath = SCRIPTS[scriptKey];

    if (!scriptPath || !fs.existsSync(scriptPath)) {
        console.error(`❌ Error: Task key "${scriptKey}" is invalid, or script file "${path.basename(scriptPath || 'N/A')}" does not exist. Please check file names.`);
        return;
    }
    
    // Check if script is already running (simple check)
    // NOTE: This simple version allows concurrent execution. For real concurrency control, a more complex solution (like a lock file) is needed.

    console.log(`\n======================================================`);
    console.log(`➡️ Starting Task: ${path.basename(scriptPath)}`);
    console.log(`======================================================`);

    // Command to execute the script
    const command = `node "${scriptPath}"`;
    
    // Execute the script, piping output to the current terminal
    const child = exec(command, { 
        cwd: __dirname, // Ensure script runs relative to the download_playwright directory
    });
    
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on('error', (err) => {
        console.error(`❌ Task execution failed (${path.basename(scriptPath)}): ${err.message}`);
    });

    child.on('close', (code) => {
        if (code === 0) {
            console.log(`\n✅ Task [${path.basename(scriptPath)}] completed successfully, exit code ${code}.`);
        } else {
            console.error(`\n❌ Task [${path.basename(scriptPath)}] failed, exit code ${code}.`);
        }
    });
}

// ======================================================
// Command Line UI Implementation
// ======================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function displayMenu() {
    console.log(`\n================== [ Task Selection Menu ] ==================`);
    console.log(`Please enter the number of the task you want to run:`);
    console.log(` 1. 01-PDD Integrated Downloader (Quota/Promo/Orders)`);
    console.log(` 2. 02-Viomi PDD Sales Fixer (Data Correction)`);
    console.log(` 3. 03-Viomi ZongHe Sales Downloader (Cross-Platform)`);
    console.log(` 4. 04-PDD Activity Monitor (Product Status)`);
    console.log(` 5. Exit Application`);
    console.log(`=============================================================`);
}

function handleInput(answer) {
    const keyMap = {
        '1': 'task01',
        '2': 'task02',
        '3': 'task03',
        '4': 'task04',
        '5': 'exit'
    };
    
    const key = keyMap[answer.trim()];

    if (key === 'exit') {
        console.log('Application exited. Goodbye! 👋');
        rl.close();
        return;
    }

    if (key) {
        // Run the script. We don't ask for the next input until the current child process is started.
        executeScript(key);
        // Ask for the next input immediately, as the execution is asynchronous.
        // The output of the running script will be mixed with the menu prompt, which is acceptable for a simple CLI.
        rl.question(`\nType another task number (1-4) or 5 to exit: `, handleInput);
    } else {
        console.log('Invalid input. Please enter a number from the menu.');
        rl.question(`\nType another task number (1-4) or 5 to exit: `, handleInput);
    }
}

// Start the application
displayMenu();
rl.question(`Enter task number (1-5): `, handleInput);