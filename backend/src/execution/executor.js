import { executeLocalCode } from './localExecutor.js';
import { executePistonCode } from './pistonExecutor.js';
import { LANGUAGES } from '../config/languages.js';

export async function executeCode(socket, payload, sessionData) {
    const { language, executionMode } = payload;
    let mode = executionMode || process.env.EXECUTION_MODE || 'auto';

    console.log(`[Executor] 🔍 Initializing execution for ${language} in mode: ${mode}`);

    if (mode === 'auto') {
<<<<<<< HEAD
        if (['python', 'javascript', 'java', 'c', 'cpp', 'php'].includes(language)) {
=======
        // "Heavy" or locally supported languages default to Local.
        // Others default to Piston (Remote).
        if (['python', 'javascript', 'java'].includes(language)) {
>>>>>>> f56aa7769833d7fe590f81c8942a0290a924f91c
            mode = 'local';
        } else {
            mode = 'piston';
        }
    }

    // Map 'docker' or 'remote' to 'piston' as the user wants to revert
    if (mode === 'docker' || mode === 'remote') {
        mode = 'piston';
    }

    console.log(`[Executor] ✅ Final execution mode: ${mode.toUpperCase()}`);

    if (language === 'terminal') {
        return executeLocalCode(socket, payload, sessionData.userId);
    }

    if (!LANGUAGES[language]) {
        socket.emit('output', `\n❌ Error: Unsupported language: ${language}\n`);
        socket.emit('execution_complete');
        return;
    }

    if (mode === 'local') {
        return executeLocalCode(socket, payload, sessionData.userId);
    }

    if (mode === 'piston') {
        return executePistonCode(socket, payload);
    }

    socket.emit('output', `\n❌ Error: Unknown execution mode: ${mode}\n`);
    socket.emit('execution_complete');
}
