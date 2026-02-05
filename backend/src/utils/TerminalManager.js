import pty from 'node-pty';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';

class TerminalManager {
    constructor() {
        this.sessions = {}; // socketId -> { cwd: string, pty: IPty | null, initialOutputReceived: boolean }
    }

    // Filter out Windows CMD header noise
    filterOutput(data, session) {
        let cleanedData = data;

        // On first output from a command, skip the Windows header
        if (!session.initialOutputReceived) {
            // Remove Windows version banner and copyright
            cleanedData = cleanedData.replace(/Microsoft Windows \[Version [^\]]+\]/g, '');
            cleanedData = cleanedData.replace(/\(c\) Microsoft Corporation\. All rights reserved\./g, '');

            // Remove ANSI escape sequences for window title
            cleanedData = cleanedData.replace(/\x1b\]0;[^\x07]*\x07/g, '');

            // Remove the initial path prompt (C:\Users\...\Temp\teachgrid-workspace>)
            cleanedData = cleanedData.replace(/[A-Z]:\\[^>]+>/g, '');

            // Remove extra newlines
            cleanedData = cleanedData.replace(/^\s+/, '');

            session.initialOutputReceived = true;
        }

        // Always filter out ANSI window title sequences
        cleanedData = cleanedData.replace(/\x1b\]0;[^\x07]*\x07/g, '');

        return cleanedData;
    }

    // Scan for listening ports on the backend
    async scanPorts(socket, session) {
        return new Promise((resolve) => {
            const command = process.platform === 'win32'
                ? 'netstat -ano -p tcp | findstr LISTENING'
                : 'ss -tlnp';

            exec(command, (error, stdout) => {
                if (error) return resolve([]);

                const ports = new Set();
                const lines = stdout.split('\n');
                lines.forEach(line => {
                    const match = line.match(/:(\d+)\s+.*LISTENING/);
                    if (match) {
                        const port = parseInt(match[1]);
                        // Filter out common system ports or the IDE's own ports
                        if (port > 1024 && port !== 3000 && port !== 3001) {
                            ports.add(port);
                        }
                    }
                });
                const portList = Array.from(ports);
                if (socket) socket.emit('terminal:ports', portList);
                resolve(portList);
            });
        });
    }

    // Initialize a session with default CWD
    createSession(socketId, socket, userId) {
        if (!this.sessions[socketId]) {
            // Default to Temp Workspace namespaced by userId
            const safeUserId = userId || 'anonymous';
            const root = path.join(os.tmpdir(), 'teachgrid-workspace', safeUserId);
            if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
            this.sessions[socketId] = {
                cwd: root,
                projectRoot: root,
                pty: null,
                initialOutputReceived: false
            };
            if (socket) {
                socket.emit('terminal:cwd', '');
            }
        }
        return this.sessions[socketId];
    }

    // Dispatch input: either as a new command or stdin for running process
    handleInput(socketId, data, socket) {
        const session = this.createSession(socketId, socket);
        if (session.pty) {
            this.write(socketId, data);
        } else {
            this.execute(socketId, data, socket);
        }
    }

    // Execute a command (spawn a process or handle internal commands like cd)
    execute(socketId, command, socket) {
        const session = this.createSession(socketId, socket);
        let trimmedCmd = command.trim();

        if (!trimmedCmd) return;

        // --- Aliases for Windows CMD ---
        const aliases = {
            'ls': 'dir /b',
            'dir': 'dir /b',
            'll': 'dir',
            'cat': 'type',
            'rm': 'del',
            'clear': 'cls',
            'pwd': 'echo %cd%'
        };
        const parts = trimmedCmd.split(' ');
        if (aliases[parts[0]]) {
            parts[0] = aliases[parts[0]];
            trimmedCmd = parts.join(' ');
        }

        // --- Smart Command Interceptor ---
        // If user runs 'npm start' in a project that only has 'dev' (like Vite)
        if (trimmedCmd === 'npm start') {
            try {
                const pkgPath = path.join(session.cwd, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (pkg.scripts && !pkg.scripts.start && pkg.scripts.dev) {
                        socket.emit('output', `💡 Intelligence: No 'start' script found. Redirecting to 'npm run dev'...\r\n`);
                        trimmedCmd = 'npm run dev';
                    }
                }
            } catch (e) {
                // Ignore parsing errors
            }
        }

        // --- Handle 'cd' internally ---
        if (trimmedCmd.startsWith('cd ') || trimmedCmd === 'cd') {
            const args = trimmedCmd.split(' ').slice(1);
            let targetDir = args[0] || os.homedir();

            // Handle quotes if any (basic)
            if (targetDir.startsWith('"') && targetDir.endsWith('"')) {
                targetDir = targetDir.slice(1, -1);
            }

            // Resolve path relative to current cwd
            const newPath = path.resolve(session.cwd, targetDir);

            // SANDBOX CHECK
            if (!newPath.startsWith(session.projectRoot)) {
                socket.emit('output', `Error: Access denied (Sandbox Restriction). Cannot navigate outside project root.\r\n`);
                return;
            }

            fs.access(newPath, fs.constants.F_OK | fs.constants.R_OK, (err) => {
                if (err) {
                    socket.emit('output', `cd: no such file or directory: ${targetDir}\r\n`);
                } else {
                    // Update session CWD
                    session.cwd = newPath;

                    // Emit RELATIVE path for UI (hides D:\...)
                    const relPath = path.relative(session.projectRoot, newPath);
                    socket.emit('terminal:cwd', relPath);
                }
            });
            return; // 'cd' is handled, don't spawn
        }

        // --- Handle 'cls' / 'clear' ---
        if (trimmedCmd === 'cls' || trimmedCmd === 'clear') {
            socket.emit('output', '\x1b[2J\x1b[0f'); // ANSI clear
            return;
        }

        // --- Spawn System Command via node-pty ---
        try {
            const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
            const args = process.platform === 'win32' ? ['/C', trimmedCmd] : ['-c', trimmedCmd];

            const ptyProcess = pty.spawn(shell, args, {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: session.cwd,
                env: {
                    ...process.env,
                    // Ensure output is not buffered
                    FORCE_COLOR: '1'
                }
            });

            session.pty = ptyProcess;
            session.initialOutputReceived = false;
            socket.emit('terminal:status', { busy: true });

            ptyProcess.onData((data) => {
                const cleaned = this.filterOutput(data, session);
                if (cleaned) {
                    socket.emit('output', cleaned);
                }
            });

            ptyProcess.onExit(({ exitCode, signal }) => {
                session.pty = null;
                socket.emit('terminal:status', { busy: false });
                this.scanPorts(socket, session);
            });

            // Also scan immediately in case it's a long running dev server that opens port quickly
            setTimeout(() => this.scanPorts(socket, session), 2000);
        } catch (e) {
            socket.emit('output', `Failed to execute: ${e.message}\r\n`);
        }
    }

    // Write to stdin of the currently running process (for interactive checks like "Are you sure? y/n")
    write(socketId, data) {
        const session = this.sessions[socketId];
        if (session && session.pty) {
            try {
                session.pty.write(data);
            } catch (err) {
                // Ignore write errors
            }
        }
    }

    resize(socketId, cols, rows) {
        const session = this.sessions[socketId];
        if (session && session.pty) {
            session.pty.resize(cols, rows);
        }
    }

    kill(socketId) {
        const session = this.sessions[socketId];
        if (session) {
            if (session.pty) {
                session.pty.kill();
            }
            delete this.sessions[socketId];
        }
    }
}

export default new TerminalManager();
