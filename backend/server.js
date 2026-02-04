import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Server as socketIO } from 'socket.io';
import cors from 'cors';
import { executeCode } from './src/execution/executor.js';
import dbRoutes from './src/routes/dbRoutes.js';
import TerminalManager from './src/utils/TerminalManager.js';
import StorageService from './src/services/StorageService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const server = http.createServer(app);

const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

const io = new socketIO(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.send('<h1>TeachGrid Backend is Running</h1><p>Socket.IO server is active.</p>');
});

app.use('/api/db', dbRoutes);

const activeSessions = new Map();

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId || 'anonymous';
    console.log(`[${new Date().toISOString()}] Client connected: ${socket.id} (User: ${userId})`);

    const sessionData = {
        socketId: socket.id,
        userId: userId,
        containerName: null,
        pty: null,
        cleanupHandler: null
    };

    activeSessions.set(socket.id, sessionData);

    socket.on('execute', async (payload) => {
        try {
            console.log(`[${socket.id}] Execute request:`, {
                language: payload.language,
                fileName: payload.fileName
            });

            if (payload.language === 'terminal') {
                if (!payload.command) {
                    socket.emit('error', 'Missing required field: command');
                    return;
                }
            } else {
                if (!payload.language || payload.code === undefined || !payload.fileName) {
                    socket.emit('error', 'Missing required fields: language, code, fileName');
                    return;
                }
            }

            await executeCode(socket, payload, sessionData);
        } catch (error) {
            console.error(`[${socket.id}] Execution error:`, error);
            socket.emit('error', error.message);
            socket.emit('execution_complete');
        }
    });

    socket.on('terminal:init', () => {
        TerminalManager.createSession(socket.id, socket, userId);
        console.log(`[${socket.id}] Terminal session initialized`);
    });

    socket.on('terminal:input', (data) => {
        if (socket._ptyProcess) {
            // If a code execution PTY is active, send input there (interactive mode)
            try {
                socket._lastInput = data; // Store last input for echo suppression in localExecutor
                socket._ptyProcess.write(data);
            } catch (err) {
                console.error("Error writing to PTY:", err);
            }
        } else {
            // Otherwise, handle as a shell command (ls, cd, etc.)
            TerminalManager.handleInput(socket.id, data, socket);
        }
    });

    // --- DB-BACKED FILE OPERATIONS ---

    socket.on('files:list', async () => {
        try {
            const tree = await StorageService.listFiles(userId);
            socket.emit('files:list:response', tree || []);
        } catch (err) {
            console.error("Error listing files:", err);
            socket.emit('error', "Failed to list files from database");
        }
    });

    socket.on('file:read', async (data) => {
        try {
            const { path: filePath } = data;
            const content = await StorageService.readFile(userId, filePath);
            socket.emit('file:read:response', { path: filePath, content });
        } catch (err) {
            console.error("Error reading file:", err);
            socket.emit('error', "Failed to read file from database");
        }
    });

    socket.on('file:save', async (data) => {
        try {
            const { path: filePath, content, isDir } = data;
            if (!filePath) return;

            const name = filePath.split('/').pop();

            // Sync to local disk for execution engine compatibility
            const projectRoot = path.join(os.tmpdir(), 'teachgrid-workspace', userId);
            const fullLocalPath = path.join(projectRoot, filePath);
            const localDir = isDir ? fullLocalPath : path.dirname(fullLocalPath);

            if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
            if (!isDir) fs.writeFileSync(fullLocalPath, content);

            // Pass userId to StorageService
            await StorageService.saveFile(userId, filePath, name, content, isDir || false);
            socket.emit('file:saved', { path: filePath });
        } catch (err) {
            console.error("Error saving file:", err);
            socket.emit('error', "Failed to save file to database");
        }
    });

    socket.on('file:delete', async (data) => {
        try {
            const { path: filePath } = data;

            // Local disk cleanup
            const projectRoot = path.join(os.tmpdir(), 'teachgrid-workspace', userId);
            const fullLocalPath = path.join(projectRoot, filePath);
            if (fs.existsSync(fullLocalPath)) {
                fs.rmSync(fullLocalPath, { recursive: true, force: true });
            }

            await StorageService.deleteFile(userId, filePath);
            socket.emit('file:deleted', { path: filePath });
        } catch (err) {
            console.error("Error deleting file:", err);
            socket.emit('error', "Failed to delete from database");
        }
    });

    socket.on('file:rename', async (data) => {
        try {
            const { oldPath, newPath } = data;

            // Local disk rename
            const projectRoot = path.join(os.tmpdir(), 'teachgrid-workspace', userId);
            const fullOldPath = path.join(projectRoot, oldPath);
            const fullNewPath = path.join(projectRoot, newPath);
            if (fs.existsSync(fullOldPath)) {
                if (!fs.existsSync(path.dirname(fullNewPath))) fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
                fs.renameSync(fullOldPath, fullNewPath);
            }

            await StorageService.renameFile(userId, oldPath, newPath);

            socket.emit('file:renamed', { oldPath, newPath });
        } catch (err) {
            console.error("Error renaming file:", err);
            socket.emit('error', "Failed to rename in database");
        }
    });

    socket.on('disconnect', async () => {
        console.log(`[${socket.id}] Client disconnected`);
        if (sessionData.cleanupHandler) {
            await sessionData.cleanupHandler();
        }
        TerminalManager.kill(socket.id);
        activeSessions.delete(socket.id);
    });
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    for (const [socketId, session] of activeSessions) {
        if (session.cleanupHandler) {
            await session.cleanupHandler();
        }
    }
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3001;

StorageService.init().then(() => {
    server.listen(PORT, () => {
        console.log(`Teachgrid Backend running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize storage:', err);
    process.exit(1);
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        process.exit(0);
    } else {
        console.error('Server error:', error);
        process.exit(1);
    }
});
