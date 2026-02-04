import pty from 'node-pty';
import { LANGUAGES } from '../config/languages.js';
import { sanitizeInput } from '../utils/helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { bundleCode, cleanupBundle } from '../utils/bundler.js';
import { ensurePythonPackages } from '../utils/pythonPkgManager.js';
import { ensureJavaPackages } from '../utils/javaPkgManager.js';
import { detectPackages } from '../utils/packageDetector.js';

export async function executeLocalCode(socket, payload, userId) {
    const { language, code, fileName } = payload;

    const langConfig = LANGUAGES[language];
    if (!langConfig) {
        socket.emit('output', `❌ Unsupported language: ${language}\n`);
        socket.emit('execution_complete');
        return;
    }

    const sanitizedCode = sanitizeInput(code);
    let codeToExecute = sanitizedCode;
    let bundleTempDir = null;

    // ---------------- JS BUNDLING ----------------
    if (language === 'javascript' && sanitizedCode.includes('require(')) {
        try {
            const bundleResult = await bundleCode(sanitizedCode, fileName);
            if (bundleResult.bundled) {
                codeToExecute = bundleResult.code;
                bundleTempDir = bundleResult.tempDir;
            }
        } catch (err) {
            socket.emit('output', `⚠️ Bundling failed: ${err.message}\n`);
        }
    }

    // ---------------- PYTHON PACKAGES ----------------
    if (language === 'python') {
        try {
            const pkgs = detectPackages(sanitizedCode, 'python');
            await ensurePythonPackages(pkgs);
        } catch (err) {
            socket.emit('output', `⚠️ Package install warning: ${err.message}\n`);
        }
    }

    // ---------------- JAVA PACKAGES ----------------
    if (language === 'java') {
        try {
            const pkgs = detectPackages(sanitizedCode, 'java');
            await ensureJavaPackages(pkgs);
        } catch (err) {
            socket.emit('output', `⚠️ Dependency warning: ${err.message}\n`);
        }
    }

    // ---------------- WORKSPACE ----------------
    // Use the shared workspace so files are persistent and match the terminal's view
    const safeUserId = userId || 'anonymous';
    const tempDir = path.join(os.tmpdir(), 'teachgrid-workspace', safeUserId);
    await fs.mkdir(tempDir, { recursive: true });

    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, codeToExecute);

    // ---------------- PTY EXECUTION ----------------

    const defaultFileName = langConfig.file;
    const defaultBaseName = path.parse(defaultFileName).name;
    const actualBaseName = path.parse(fileName).name;

    const commandList = (langConfig.localCommand || langConfig.command).map(part => {
        let newPart = part;
        if (defaultFileName) newPart = newPart.replaceAll(defaultFileName, fileName);
        if (defaultBaseName !== actualBaseName) {
            newPart = newPart.replaceAll(defaultBaseName, actualBaseName);
        }
        return newPart;
    });

    const finalCommand = commandList.join(' ');

    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const args = process.platform === 'win32' ? ['/C', finalCommand] : ['-c', finalCommand];

    // Set encoding for Python to handle Unicode characters on Windows
    const env = {
        ...process.env,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8'
    };

    if (language === 'python') {
        env.PYTHONIOENCODING = 'utf-8';
        env.PYTHONUTF8 = '1';
    } else if (language === 'java') {
        env.JAVA_TOOL_OPTIONS = '-Dfile.encoding=UTF-8';
    } else if (language === 'php') {
        // Inject Common Gateway Interface (CGI) variables for scripts that expect them
        env.REQUEST_METHOD = 'GET';
        env.REQUEST_METHOD = 'GET';
        env.REDIRECT_STATUS = '200'; // Required for php-cgi
        env.SCRIPT_FILENAME = fileName; // Required for some php-cgi configurations
        // You can add more mock variables here if needed
        // env.SERVER_NAME = 'localhost';
        // env.SERVER_PORT = '80';
    }

    const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: tempDir,
        env: env
    });

    let initialOutputReceived = false;
    const filterOutput = (data) => {
        let cleanedData = data;
        // Strip ANSI OSC window title sequences (e.g. ]0;C:\Windows\SYSTEM32\cmd.exe)
        // These can appear even with /C if ConPTY is active
        cleanedData = cleanedData.replace(/\x1b\]0;.*?\x07/g, '');

        if (!initialOutputReceived) {
            cleanedData = cleanedData.replace(/Microsoft Windows \[Version [^\]]+\]/g, '');
            cleanedData = cleanedData.replace(/\(c\) Microsoft Corporation\. All rights reserved\./g, '');
            cleanedData = cleanedData.replace(/^\s+/, '');
            initialOutputReceived = true;
        }
        return cleanedData;
    };

    // Stream output
    ptyProcess.onData(data => {
        let cleaned = filterOutput(data);

        // --- ECHO SUPPRESSION ---
        // If the PTY data starts with the last sent input, it's likely an echo.
        // Strip it to prevent double-display in the custom terminal.
        if (socket._lastInput && cleaned.startsWith(socket._lastInput)) {
            cleaned = cleaned.substring(socket._lastInput.length);
            socket._lastInput = null; // Clear once handled
        }

        if (cleaned) {
            socket.emit('output', cleaned);
        }
    });

    // Notify frontend that terminal is busy (program running)
    socket.emit('terminal:status', { busy: true });

    ptyProcess.onExit(async () => {
        socket._ptyProcess = null; // CRITICAL: Clear the reference so subsequent inputs go to shell
        socket.emit('execution_complete');
        socket.emit('terminal:status', { busy: false });
        try {
            // DO NOT delete tempDir (workspace), as it is shared. 
            // Only clean up bundled temp dirs if they exist.
            if (bundleTempDir) await cleanupBundle(bundleTempDir);
        } catch (e) {
            console.error('Cleanup error:', e);
        }
    });

    // Attach PTY to socket so frontend can send user input
    socket._ptyProcess = ptyProcess;
}
