import { supabase } from '../config/supabaseClient.js';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import chokidar from 'chokidar';

dotenv.config();

const DEFAULT_USER_ID = 'user_system';

class StorageService {
    async init() {
        console.log('[StorageService] Initializing Supabase storage...');

        try {
            const { count, error } = await supabase
                .from('workspace_files')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', DEFAULT_USER_ID);

            if (error) throw error;

            console.log(`[StorageService] Current Supabase row count for ${DEFAULT_USER_ID}: ${count}`);

            if (count === 0) {
                console.log('[StorageService] Starting disk-to-DB migration...');
                const projectRoot = path.join(os.tmpdir(), 'teachgrid-workspace');
                if (fs.existsSync(projectRoot)) {
                    await this.migrateFromDisk(projectRoot, '');
                    console.log('[StorageService] Migration complete!');
                } else {
                    console.log('[StorageService] Temp workspace not found, skipping migration.');
                    fs.mkdirSync(projectRoot, { recursive: true });
                }
            }

            // Start file watcher for real-time sync (crucial for terminal use)
            this.startWatcher();
        } catch (err) {
            console.error('[StorageService] Initialization error:', err.message);
        }
    }

    async migrateFromDisk(absPath, relPath) {
        const items = fs.readdirSync(absPath);
        for (const item of items) {
            try {
                if (item === 'node_modules' || item === '.git') continue; // Skip heavy folders

                const itemAbs = path.join(absPath, item);
                const itemRel = relPath ? `${relPath}/${item}` : item;
                const stats = fs.statSync(itemAbs);
                const isDir = stats.isDirectory();

                let content = null;
                if (!isDir) {
                    content = fs.readFileSync(itemAbs, 'utf8');
                }

                await this.saveFile(itemRel, item, content, isDir);

                if (isDir) {
                    await this.migrateFromDisk(itemAbs, itemRel);
                }
            } catch (itemErr) {
                console.error(`[Migration] Failed for ${item}:`, itemErr.message);
            }
        }
    }

    async listFiles() {
        const { data, error } = await supabase
            .from('workspace_files')
            .select('*')
            .eq('user_id', DEFAULT_USER_ID)
            .order('is_dir', { ascending: false })
            .order('path', { ascending: true });

        if (error) throw error;
        return this.buildTree(data);
    }

    async saveFile(filePath, name, content, isDir) {
        console.log(`[StorageService] 💾 Saving to DB & Bucket: ${filePath} (isDir: ${isDir})`);

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
                        user_id: DEFAULT_USER_ID,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'user_id,path' });
                }
            }

            // 2. Upload to Supabase Storage (Visual Folder logic)
            try {
                if (isDir) {
                    // Supabase Storage needs an object to "show" a folder. 
                    // We create a hidden .placeholder file.
                    await supabase.storage
                        .from('workspace')
                        .upload(`${DEFAULT_USER_ID}/${filePath}/.placeholder`, '', {
                            upsert: true,
                            contentType: 'text/plain'
                        });
                    console.log(`[StorageService] 📁 Created folder placeholder for: ${filePath}`);
                } else if (content !== null) {
                    const { error: bucketError } = await supabase.storage
                        .from('workspace')
                        .upload(`${DEFAULT_USER_ID}/${filePath}`, content, {
                            upsert: true,
                            contentType: 'text/plain'
                        });
                    if (bucketError) {
                        console.warn(`[StorageService] ⚠️ Bucket upload failed:`, bucketError.message);
                    } else {
                        console.log(`[StorageService] ☁️ Uploaded ${filePath} to bucket.`);
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
                    user_id: DEFAULT_USER_ID
                }, {
                    onConflict: 'user_id,path'
                })
                .select();

            if (error) {
                console.error(`[StorageService] ❌ Table Upsert Error for ${filePath}:`, error.message);
                throw error;
            }

            console.log(`[StorageService] ✅ Successfully saved ${filePath} in DB/Bucket`);
            return data;

        } catch (err) {
            console.error(`[StorageService] ❌ Catch Error saving ${filePath}:`, err.message);
            throw err;
        }
    }

    async deleteFile(filePath) {
        // 1. Delete from Table
        const { error } = await supabase
            .from('workspace_files')
            .delete()
            .match({ user_id: DEFAULT_USER_ID })
            .or(`path.eq.${filePath},path.like.${filePath}/%`);

        if (error) throw error;

        // 2. Delete from Bucket (Ignore errors if bucket isn't setup)
        try {
            await supabase.storage
                .from('workspace')
                .remove([`${DEFAULT_USER_ID}/${filePath}`]);
        } catch (e) { }
    }

    async renameFile(oldPath, newPath) {
        console.log(`[StorageService] 📂 Renaming: ${oldPath} -> ${newPath}`);

        const { data, error: fetchError } = await supabase
            .from('workspace_files')
            .select('*')
            .match({ user_id: DEFAULT_USER_ID })
            .or(`path.eq.${oldPath},path.like.${oldPath}/%`);

        if (fetchError) throw fetchError;

        for (const row of data) {
            const subPath = row.path.replace(oldPath, newPath);
            const name = subPath.split('/').pop();

            await this.saveFile(subPath, name, row.content, row.is_dir);

            if (row.path !== subPath) {
                await this.deleteFile(row.path);
            }
        }
    }

    async readFile(filePath) {
        const { data, error } = await supabase
            .from('workspace_files')
            .select('content')
            .match({ path: filePath, user_id: DEFAULT_USER_ID })
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return data?.content || '';
    }

    buildTree(rows) {
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
                    // Fallback: if parent not in DB, show at root but keep as intended hierarchy
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
        });

        this.watcher
            .on('add', (absPath) => this.handleFsEvent('add', absPath))
            .on('change', (absPath) => this.handleFsEvent('change', absPath))
            .on('unlink', (absPath) => this.handleFsEvent('unlink', absPath))
            .on('addDir', (absPath) => this.handleFsEvent('addDir', absPath))
            .on('unlinkDir', (absPath) => this.handleFsEvent('unlinkDir', absPath));
    }

    async handleFsEvent(event, absPath) {
        const workspaceDir = path.join(os.tmpdir(), 'teachgrid-workspace');
        const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, '/');
        const name = path.basename(absPath);

        console.log(`[StorageService] 📂 FS Event [${event}]: ${relPath}`);

        try {
            if (event === 'add' || event === 'change' || event === 'addDir') {
                const isDir = event === 'addDir';
                let content = null;
                if (!isDir) {
                    content = fs.readFileSync(absPath, 'utf8');
                }
                await this.saveFile(relPath, name, content, isDir);
            } else if (event === 'unlink' || event === 'unlinkDir') {
                await this.deleteFile(relPath);
            }
        } catch (err) {
            console.error(`[StorageService] ❌ Failed to sync FS event ${event} for ${relPath}:`, err.message);
        }
    }
}

export default new StorageService();
