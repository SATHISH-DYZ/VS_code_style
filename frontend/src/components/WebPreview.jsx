import React, { useMemo } from 'react';

export default function WebPreview({ fileName, content, files, fullPath, executionOutput, isExecuting }) {
    const fullHtml = useMemo(() => {
        // 0. Direct Output Mode (from PHP/Server)
        if (executionOutput) {
            // Strip headers (find double newline)
            const splitMatch = executionOutput.match(/\r?\n\r?\n/);
            if (splitMatch) {
                return executionOutput.substring(splitMatch.index + splitMatch[0].length);
            }
            // If no headers, return raw (fallback)
            return executionOutput;
        }

        // 0.5. Prevent bundling for PHP files if no output yet
        if (fileName.endsWith('.php')) {
            if (isExecuting) {
                return `
                    <div style="font-family: sans-serif; padding: 20px; color: #666; text-align: center;">
                        <h3 style="color: #007acc;">Executing PHP Script...</h3>
                        <div class="spinner"></div>
                        <style>
                            .spinner { width: 20px; height: 20px; border: 3px solid #ccc; border-top-color: #007acc; border-radius: 50%; margin: 10px auto; animation: spin 1s linear infinite; }
                            @keyframes spin { to { transform: rotate(360deg); } }
                        </style>
                    </div>
                `;
            }
            return `
                <div style="font-family: sans-serif; padding: 20px; color: #666; text-align: center;">
                    <h3>Waiting for PHP Execution...</h3>
                    <p>Click the "Run" button (F5) to execute this script.</p>
                </div>
            `;
        }

        // 1. Flatten VFS
        const vfs = {};
        const flatten = (items, path = "") => {
            items.forEach(item => {
                const fullPathStr = path ? `${path}/${item.name}` : item.name;
                if (item.isDir) {
                    if (item.children) flatten(item.children, fullPathStr);
                } else {
                    vfs[fullPathStr] = item.content || "";
                }
            });
        };
        flatten(files);

        // 2. Detect Framework
        const hasVue = Object.keys(vfs).some(f => f.endsWith('.vue'));
        const hasSvelte = Object.keys(vfs).some(f => f.endsWith('.svelte'));
        const isReact = Object.keys(vfs).some(f => f.endsWith('.jsx') || f.match(/import\s+React/));

        // 3. Discover third-party dependencies
        const thirdPartyDeps = new Set();
        Object.values(vfs).forEach(code => {
            if (typeof code !== 'string') return;
            const matches = code.matchAll(/import\s+.*?from\s+['"]([^./][^'"]*)['"]/g);
            for (const match of matches) {
                const dep = match[1];
                if (!['react', 'react-dom', 'react-dom/client', 'lucide-react', 'framer-motion', 'axios', 'vue', 'svelte'].includes(dep)) {
                    thirdPartyDeps.add(dep);
                }
            }
        });

        // 4. Bundler Script
        const escapeScriptTags = (str) => str.replace(/<\/script>/g, '<\\/script>');

        // Prefer fullPath if available to avoid ambiguity, fallback to fileName using normalization
        const entryPoint = fullPath || fileName;

        const bundlerScript = `
            (function() {
                window.__VFS__ = ${escapeScriptTags(JSON.stringify(vfs))};
                window.__ENTRY__ = "${entryPoint.endsWith('.html') ? '' : entryPoint}"; 
                window.__IS_HTML_MODE__ = ${entryPoint.endsWith('.html')};
                window.__CACHE__ = {};
                window.__EXTERNAL_DEPS__ = {};
                
                function log(m) { console.log("[Bundler]", m); }
                
                function showError(msg) {
                    const div = document.createElement('div');
                    div.style = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#1e1e1e;color:#f14c4c;padding:30px;font-family:monospace;white-space:pre-wrap;z-index:99999;font-size:14px;overflow:auto;';
                    div.innerHTML = '<h2 style="color:#f14c4c;margin-top:0;">Runtime Error</h2>' + msg;
                    document.body.appendChild(div);
                }

                function normalizePath(path) {
                    const parts = path.split('/');
                    const stack = [];
                    for (const part of parts) {
                        if (part === '.' || part === '') continue;
                        if (part === '..') stack.pop();
                        else stack.push(part);
                    }
                    return stack.join('/');
                }

                function resolve(path, currentDir = "") {
                    // Normalize path: clean up ./ and /
                    let target = path;
                    
                    if (path.startsWith('./') || path.startsWith('../')) {
                         target = normalizePath(currentDir + "/" + path);
                    } else if (path.startsWith('/')) {
                         target = normalizePath(path);
                    } else {
                        // Bare module or simplified path
                         // Try exact match first
                        if (window.__VFS__[path] !== undefined) return path;
                    }
                    
                    const tryPaths = [
                        target, 
                        target + ".jsx", target + ".js", target + ".vue", target + ".svelte",
                        "src/" + target, "src/" + target + ".jsx", "src/" + target + ".js", "src/" + target + ".vue"
                    ];
                    
                    return tryPaths.find(p => window.__VFS__[p] !== undefined);
                }

                function require(path, currentFile = "") {
                    if (path === 'react') return window.React;
                    if (path === 'react-dom' || path === 'react-dom/client') return window.ReactDOM;
                    if (path === 'vue') return window.Vue;
                    if (path === 'lucide-react') return window.lucide;
                    if (path === 'axios') return window.axios;
                    
                    if (window.__EXTERNAL_DEPS__[path]) return window.__EXTERNAL_DEPS__[path];
                    
                    if (path.endsWith('.css')) return {};
                    if (path.match(/\\.(svg|png|jpg|jpeg|gif|webp)$/i)) return path; 

                    const currentDir = currentFile.split('/').slice(0, -1).join('/');
                    const resolved = resolve(path, currentDir);
                    
                    if (!resolved) throw new Error("Module not found: " + path + (currentFile ? " (imported by " + currentFile + ")" : ""));
                    if (window.__CACHE__[resolved]) return window.__CACHE__[resolved];

                    const code = window.__VFS__[resolved];
                    const module = { exports: {} };
                    
                    try {
                        let finalCode = "";
                        if (resolved.endsWith('.vue')) {
                            throw new Error("SFC (.vue) compilation requires backend support.");
                        } else {
                            const transformed = Babel.transform(code, {
                                presets: ['react', 'env'],
                                filename: resolved
                            }).code;

                            finalCode = transformed
                                .replace(/export\\s+default\\s+/g, 'module.exports.default = module.exports = ')
                                .replace(/export\\s+const\\s+([a-zA-Z0-9_$]+)/g, 'module.exports.$1 = ')
                                .replace(/import\\s+(.*?)\\s+from\\s+['"](.*?)['"];?/g, (match, imports, from) => {
                                     const imps = imports.trim().includes('{') ? imports : ('{ default: ' + imports + ' }');
                                     return 'const ' + imps + ' = require("' + from + '");';
                                })
                                .replace(/import\\s+['"](.*?)['"];?/g, 'require("$1");');
                        }

                        const customRequire = (p) => require(p, resolved);
                        const fn = new Function('require', 'module', 'exports', 'React', 'ReactDOM', 'Vue', finalCode);
                        fn(customRequire, module, module.exports, window.React, window.ReactDOM, window.Vue);
                        
                        window.__CACHE__[resolved] = module.exports.default || module.exports;
                        return window.__CACHE__[resolved];
                    } catch (e) {
                        showError("Error in " + resolved + ":\\n" + e.message);
                        throw e;
                    }
                }

                async function boot() {
                    log("Starting application...");
                    const status = document.getElementById('ide-status');
                    try {
                        // Wait for deps
                        let attempts = 0;
                        while(window.__PENDING_DEPS__ > 0 && attempts < 100) {
                            await new Promise(r => setTimeout(r, 100));
                            attempts++;
                        }

                        // HTML Mode Check
                        if (window.__IS_HTML_MODE__) {
                             log("HTML Mode active. Skipping React auto-boot.");
                             if (status) { status.style.opacity = '0'; setTimeout(() => status.style.display = 'none', 300); }
                             return;
                        }

                        // CLEANUP: Ensure body is clean for React apps (remove potential template garbage)
                        // We keep #root, #app, #ide-status, and scripts.
                        const keepIds = ['root', 'app', 'ide-status'];
                        Array.from(document.body.children).forEach(child => {
                            if (child.tagName !== 'SCRIPT' && !keepIds.includes(child.id)) {
                                child.remove();
                            }
                        });

                        const potentialEntries = [
                            window.__ENTRY__, 
                            'src/main.jsx', 'src/main.js', 'main.jsx', 'main.js', 'src/App.jsx', 'App.jsx', 'src/index.js', 'index.js'
                        ];
                        const entry = potentialEntries.find(p => p && (window.__VFS__[p] || resolve(p)));
                        
                        if (entry) {
                            log("Booting from: " + entry);
                            const exported = require(entry);
                            
                            let root = document.getElementById('root') || document.getElementById('app');
                            if (!root) {
                                root = document.createElement('div');
                                root.id = 'root';
                                document.body.appendChild(root);
                            }

                            // Only auto-mount if the root is empty AND we got a valid component.
                            // If the root is NOT empty, it means index.js likely called root.render() itself!
                            if (root.innerHTML.trim() === '') {
                                const Component = exported.default || exported;
                                if (Component && typeof Component === 'function') {
                                    log("Auto-mounting component...");
                                    const React = window.React;
                                    const ReactDOM = window.ReactDOM;
                                    if (ReactDOM.createRoot) {
                                        ReactDOM.createRoot(root).render(React.createElement(Component));
                                    } else {
                                        ReactDOM.render(React.createElement(Component), root);
                                    }
                                } else {
                                    // If no component, it's ONLY an error if the root is STILL empty.
                                    // React apps usually mount themselves in index.js, so this is often fine.
                                    setTimeout(() => {
                                        if (root.innerHTML.trim() === '') {
                                             showError("Entry file " + entry + " executed, but we couldn't find a component to mount and the #root element is empty.\\n\\nMake sure you either export a component or call root.render() manually in your entry file.");
                                        }
                                    }, 500);
                                }
                            }

                            if (status) { status.style.opacity = '0'; setTimeout(() => status.style.display = 'none', 300); }
                        } else {
                            showError("Could not find entry point. Checked: " + potentialEntries.join(", "));
                        }
                    } catch (err) {
                        showError(err.stack || err.message);
                    }
                }

                window.addEventListener('load', boot);
            })();
        `;

        // 5. HTML Construction
        let htmlTemplate;
        if (fileName.endsWith('.html') && vfs[fileName]) {
            htmlTemplate = vfs[fileName];
        } else {
            htmlTemplate = vfs['index.html'] || vfs['public/index.html'] || vfs['frontend/public/index.html'] || vfs['src/index.html'] ||
                '<!DOCTYPE html><html><head><meta charset="UTF-8" /></head><body><div id="root"></div><div id="app"></div></body></html>';
        }

        htmlTemplate = htmlTemplate.replace(/<script\s+[^>]*src=["'](.*?)["'][^>]*><\/script>/gi, (match, src) => {
            const clean = src.replace(/^\.?\//, "");
            return (vfs[clean] || vfs['src/' + clean]) ? `<!-- Stripped: ${src} -->` : match;
        });

        // Core Dependencies
        let deps = `
            <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <script src="https://unpkg.com/axios/dist/axios.min.js"></script>
            <script src="https://cdn.tailwindcss.com"></script>
        `;

        if (hasVue) deps += `<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>`;

        deps += `<script>window.__PENDING_DEPS__ = ${thirdPartyDeps.size}; window.__EXTERNAL_DEPS__ = {};</script>`;
        deps += Array.from(thirdPartyDeps).map(dep => `
            <script type="module">
                import * as mod from 'https://esm.sh/${dep}';
                window.__EXTERNAL_DEPS__['${dep}'] = mod;
                window.__PENDING_DEPS__--;
            </script>
        `).join('');

        const cssFiles = Object.keys(vfs).filter(f => f.endsWith('.css'));
        const styles = cssFiles.map(f => `<style id="${f}">\n${vfs[f]}\n</style>`).join('\n');

        let finalHtml = htmlTemplate;
        const statusOverlay = '<div id="ide-status" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#1e1e1e;color:#888;display:flex;align-items:center;justify-content:center;font-family:sans-serif;z-index:99998;transition: opacity 0.3s;pointer-events:none;">Bundling application...</div>';

        if (finalHtml.includes('<head>')) {
            finalHtml = finalHtml.replace('<head>', '<head>' + deps + styles);
        } else {
            finalHtml = deps + styles + finalHtml;
        }

        if (finalHtml.includes('<body>')) {
            finalHtml = finalHtml.replace('<body>', '<body>' + statusOverlay);
        } else {
            finalHtml = statusOverlay + finalHtml;
        }

        const injector = `<script>${bundlerScript}</script>`;
        if (finalHtml.includes('</body>')) {
            finalHtml = finalHtml.replace('</body>', injector + '</body>');
        } else {
            finalHtml += injector;
        }

        return finalHtml;
    }, [content, fileName, files, fullPath, executionOutput]);

    return (
        <div style={{ width: '100%', height: '100%', background: 'white', overflow: 'hidden' }}>
            <iframe
                srcDoc={fullHtml}
                key={fileName}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Web Preview"
                sandbox="allow-scripts"
            />
        </div>
    );
}
