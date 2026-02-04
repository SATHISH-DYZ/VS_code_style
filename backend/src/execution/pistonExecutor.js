import axios from 'axios';
import { LANGUAGES } from '../config/languages.js';

const PISTON_URL = 'https://emkc.org/api/v2/piston/execute';

export async function executePistonCode(socket, payload) {
    const { language, code, fileName } = payload;
    const langConfig = LANGUAGES[language];

    if (!langConfig || !langConfig.piston) {
        socket.emit('output', `❌ Piston does not support: ${language}\n`);
        socket.emit('execution_complete');
        return;
    }

    try {
        const response = await axios.post(PISTON_URL, {
            language: langConfig.piston.language,
            version: langConfig.piston.version,
            files: [
                {
                    name: fileName,
                    content: code
                }
            ]
        });

        const { run } = response.data;

        if (run.stdout) {
            socket.emit('output', run.stdout);
        }
        if (run.stderr) {
            socket.emit('output', run.stderr);
        }

        if (!run.stdout && !run.stderr && run.signal) {
            socket.emit('output', `Process terminated with signal: ${run.signal}\n`);
        }

        socket.emit('execution_complete');

    } catch (err) {
        console.error('[PistonExecutor] Error:', err.message);
        socket.emit('output', `❌ Remote execution error: ${err.message}\n`);
        socket.emit('execution_complete');
    }
}
