import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

class TerminalManager {
    constructor() {
        this.sessions = {}; // socketId -> { cwd: string, process: ChildProcess | null, initialOutputReceived: boolean }
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

    // Initialize a session with default CWD
    // Initialize a session with default CWD
    createSession(socketId, socket) {
        if (!this.sessions[socketId]) {
            // Default to Temp Workspace
            const root = path.join(os.tmpdir(), 'teachgrid-workspace');
            if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
            this.sessions[socketId] = {
                cwd: root,
                projectRoot: root,
                process: null,
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
        if (session.process) {
            this.write(socketId, data);
        } else {
            this.execute(socketId, data, socket);
        }
    }

    // Execute a command (spawn a process or handle internal commands like cd)
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
                    // If outside project, it will show ../.. which is fine/honest without full path
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

        // --- Spawn System Command ---
        try {
            const proc = spawn(trimmedCmd, [], {
                cwd: session.cwd,
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            session.process = proc; // Track active process for kill/stdin
            session.initialOutputReceived = false; // Reset for new command
            socket.emit('terminal:status', { busy: true });

            proc.stdout.on('data', (data) => {
                const cleaned = this.filterOutput(data.toString(), session);
                if (cleaned.trim()) {
                    socket.emit('output', cleaned);
                }
            });

            proc.stderr.on('data', (data) => {
                const cleaned = this.filterOutput(data.toString(), session);
                if (cleaned.trim()) {
                    socket.emit('output', cleaned);
                }
            });

            proc.on('close', (code) => {
                session.process = null;
                socket.emit('terminal:status', { busy: false });
            });

            proc.on('error', (err) => {
                socket.emit('output', `Error spawning command: ${err.message}\r\n`);
                session.process = null;
                socket.emit('terminal:status', { busy: false });
            });
        } catch (e) {
            socket.emit('output', `Failed to execute: ${e.message}\r\n`);
        }
    }

    // Write to stdin of the currently running process (for interactive checks like "Are you sure? y/n")
    write(socketId, data) {
        const session = this.sessions[socketId];
        if (session && session.process && session.process.stdin) {
            try {
                session.process.stdin.write(data);
            } catch (err) {
                // Ignore write errors to closed pipes
            }
        }
    }

    resize(socketId, cols, rows) {
        // Not applicable for spawn, but kept for API compatibility
    }

    kill(socketId) {
        const session = this.sessions[socketId];
        if (session) {
            if (session.process) {
                session.process.kill();
            }
            delete this.sessions[socketId];
        }
    }
}

export default new TerminalManager();
