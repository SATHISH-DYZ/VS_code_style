import { supabase } from '../config/supabaseClient.js';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import chokidar from 'chokidar';

dotenv.config();

class StorageService {
    async init() {
        console.log('[StorageService] Initializing...');
        // Start file watcher for real-time sync
        this.startWatcher();
    }

    async listFiles(userId) {
        if (!userId) throw new Error("userId is required for listFiles");
        const { data, error } = await supabase
            .from('workspace_files')
            .select('*')
            .eq('user_id', userId)
            .order('is_dir', { ascending: false })
            .order('path', { ascending: true });

        if (error) throw error;
        return this.buildTree(data);
    }

    async saveFile(userId, filePath, name, content, isDir) {
        if (!userId) return; // passive fail or throw
        console.log(`[StorageService] 💾 Saving for [${userId}]: ${filePath} (isDir: ${isDir})`);

        try {
            // 1. Ensure parent directories exist in DB (Index logic)
            if (filePath.includes('/')) {
                const parts = filePath.split('/');
                for (let i = 1; i < parts.length; i++) {
                    const parentPath = parts.slice(0, i).join('/');
                    const parentName = parts[i - 1];
                    await supabase.from('workspace_files').upsert({
                        path: parentPath,
                        name: parentName,
                        is_dir: true,
                        user_id: userId,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'user_id,path' });
                }
            }

            // 2. Upload to Supabase Storage (Visual Folder logic)
            try {
                if (isDir) {
                    await supabase.storage
                        .from('workspace')
                        .upload(`${userId}/${filePath}/.placeholder`, '', {
                            upsert: true,
                            contentType: 'text/plain'
                        });
                } else if (content !== null) {
                    const { error: bucketError } = await supabase.storage
                        .from('workspace')
                        .upload(`${userId}/${filePath}`, content, {
                            upsert: true,
                            contentType: 'text/plain'
                        });
                    if (bucketError) {
                        console.warn(`[StorageService] ⚠️ Bucket upload failed:`, bucketError.message);
                    }
                }
            } catch (bucketCatch) {
                console.warn(`[StorageService] ⚠️ Bucket operation skipped:`, bucketCatch.message);
            }

            // 3. Save to Table (Search & Fast List logic)
            const { data, error } = await supabase
                .from('workspace_files')
                .upsert({
                    path: filePath,
                    name,
                    content,
                    is_dir: isDir,
                    updated_at: new Date().toISOString(),
                    user_id: userId
                }, {
                    onConflict: 'user_id,path'
                })
                .select();

            if (error) {
                console.error(`[StorageService] ❌ Table Upsert Error for ${filePath}:`, error.message);
                throw error;
            }

            return data;

        } catch (err) {
            console.error(`[StorageService] ❌ Catch Error saving ${filePath}:`, err.message);
            throw err;
        }
    }

    async deleteFile(userId, filePath) {
        if (!userId) return;
        // 1. Delete from Table
        const { error } = await supabase
            .from('workspace_files')
            .delete()
            .match({ user_id: userId })
            .or(`path.eq.${filePath},path.like.${filePath}/%`);

        if (error) throw error;

        // 2. Delete from Bucket
        try {
            await supabase.storage
                .from('workspace')
                .remove([`${userId}/${filePath}`]);
        } catch (e) { }
    }

    async renameFile(userId, oldPath, newPath) {
        if (!userId) return;
        console.log(`[StorageService] 📂 Renaming [${userId}]: ${oldPath} -> ${newPath}`);

        const { data, error: fetchError } = await supabase
            .from('workspace_files')
            .select('*')
            .match({ user_id: userId })
            .or(`path.eq.${oldPath},path.like.${oldPath}/%`);

        if (fetchError) throw fetchError;

        for (const row of data) {
            const subPath = row.path.replace(oldPath, newPath);
            const name = subPath.split('/').pop();

            await this.saveFile(userId, subPath, name, row.content, row.is_dir);

            if (row.path !== subPath) {
                await this.deleteFile(userId, row.path);
            }
        }
    }

    async readFile(userId, filePath) {
        if (!userId) return '';
        const { data, error } = await supabase
            .from('workspace_files')
            .select('content')
            .match({ path: filePath, user_id: userId })
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return data?.content || '';
    }

    buildTree(rows) {
        if (!rows) return [];
        const nodes = {};
        const tree = [];

        // First pass: create all nodes
        rows.forEach(row => {
            nodes[row.path] = {
                id: row.path,
                name: row.name,
                isDir: row.is_dir,
                content: row.content,
                children: row.is_dir ? [] : undefined,
                isOpen: false
            };
        });

        // Second pass: connect children to parents
        rows.forEach(row => {
            const node = nodes[row.path];
            const parts = row.path.split('/');

            if (parts.length === 1) {
                tree.push(node);
            } else {
                const parentPath = parts.slice(0, -1).join('/');
                if (nodes[parentPath]) {
                    nodes[parentPath].children.push(node);
                } else {
                    tree.push(node);
                }
            }
        });

        return tree;
    }

    startWatcher() {
        const workspaceDir = path.join(os.tmpdir(), 'teachgrid-workspace');
        if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

        console.log(`[StorageService] 👀 Watching for changes in: ${workspaceDir}`);

        this.watcher = chokidar.watch(workspaceDir, {
            ignored: [
                /(^|[\/\\])\../, // ignore dotfiles
                /node_modules/,   // ignore node_modules
                /\.git/          // ignore git
            ],
            persistent: true,
            ignoreInitial: true,
            depth: 10 // restrict depth if needed
        });

        this.watcher
            .on('add', (absPath) => this.handleFsEvent('add', absPath))
            .on('change', (absPath) => this.handleFsEvent('change', absPath))
            .on('unlink', (absPath) => this.handleFsEvent('unlink', absPath))
            .on('addDir', (absPath) => this.handleFsEvent('addDir', absPath))
            .on('unlinkDir', (absPath) => this.handleFsEvent('unlinkDir', absPath));
    }

    async handleFsEvent(event, absPath) {
        // Expected structure: .../teachgrid-workspace/{userId}/{path/to/file}
        const workspaceDir = path.join(os.tmpdir(), 'teachgrid-workspace');
        const relativeToRoot = path.relative(workspaceDir, absPath).replace(/\\/g, '/');

        // Extract userID (first segment)
        const parts = relativeToRoot.split('/');
        if (parts.length < 2) return; // Change in root or direct child of root (which should be user folders)

        const userId = parts[0];
        const filePath = parts.slice(1).join('/');
        const name = parts[parts.length - 1];

        // console.log(`[StorageService] 📂 FS Event [${event}]: User=${userId}, Path=${filePath}`);

        try {
            if (event === 'add' || event === 'change' || event === 'addDir') {
                const isDir = event === 'addDir';
                let content = null;
                if (!isDir) {
                    content = fs.readFileSync(absPath, 'utf8');
                }
                await this.saveFile(userId, filePath, name, content, isDir);
            } else if (event === 'unlink' || event === 'unlinkDir') {
                await this.deleteFile(userId, filePath);
            }

            // Notify via callback if registered (Debounced)
            this.triggerChange(userId);

        } catch (err) {
            console.error(`[StorageService] ❌ Failed to sync FS event ${event} for ${relativeToRoot}:`, err.message);
        }
    }

    setWatcherCallback(callback) {
        this.changeCallback = callback;
        this.debounceTimers = new Map();
    }

    triggerChange(userId) {
        if (!this.changeCallback) return;

        if (this.debounceTimers && this.debounceTimers.has(userId)) {
            clearTimeout(this.debounceTimers.get(userId));
        }

        if (!this.debounceTimers) this.debounceTimers = new Map();

        this.debounceTimers.set(userId, setTimeout(() => {
            // console.log(`[StorageService] 🔄 Triggering client refresh for user: ${userId}`);
            this.changeCallback(userId);
            this.debounceTimers.delete(userId);
        }, 800)); // 800ms debounce
    }
}

export default new StorageService();
