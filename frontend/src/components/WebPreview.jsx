import React, { useMemo, useState, useEffect } from 'react';

// Global cache for Babel transformations to speed up re-bundling
const BABEL_CACHE = new Map();

export default function WebPreview({ fileName, content, files, fullPath }) {
    const [debouncedHtml, setDebouncedHtml] = useState("");
    const [babelLoaded, setBabelLoaded] = useState(!!window.Babel);

    useEffect(() => {
        if (!window.Babel) {
            console.log("[WebPreview] Loading Babel in parent window...");
            const script = document.createElement('script');
            script.src = "https://unpkg.com/@babel/standalone/babel.min.js";
            script.id = "babel-standalone";
            script.onload = () => {
                console.log("[WebPreview] Babel loaded in parent window.");
                setBabelLoaded(true);
            };
            if (!document.getElementById("babel-standalone")) {
                document.head.appendChild(script);
            }
        }
    }, []);

    const fullHtml = useMemo(() => {
        // 1. Flatten VFS and pre-transform JS/JSX
        const vfs = {};
        const thirdPartyDeps = new Set();

        const flatten = (items, path = "") => {
            items.forEach(item => {
                const fullPathStr = path ? `${path}/${item.name}` : item.name;
                if (item.isDir) {
                    if (item.children) flatten(item.children, fullPathStr);
                } else {
                    let code = item.content || "";
                    const ext = item.name.split('.').pop().toLowerCase();

                    if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
                        const cacheKey = `${fullPathStr}:${code}`;
                        if (BABEL_CACHE.has(cacheKey)) {
                            code = BABEL_CACHE.get(cacheKey);
                        } else if (window.Babel) {
                            try {
                                const result = window.Babel.transform(code, {
                                    presets: ['react', ['env', { modules: 'commonjs' }]],
                                    filename: fullPathStr
                                });
                                BABEL_CACHE.set(cacheKey, result.code);
                                code = result.code;
                            } catch (e) {
                                console.error("Babel transformation failed for", fullPathStr, e);
                            }
                        }
                    }
                    vfs[fullPathStr] = code;
                }
            });
        };
        flatten(files);

        // 2. Discover dependencies
        Object.values(vfs).forEach(code => {
            if (typeof code !== 'string') return;
            // Discovery from ESM
            const esmMatches = code.matchAll(/import\s+(?:.*?from\s+)?['"]([^./][^'"]*)['"]/gs);
            for (const m of esmMatches) {
                if (!['react', 'react-dom', 'react-dom/client', 'axios', 'vue'].includes(m[1])) {
                    thirdPartyDeps.add(m[1]);
                }
            }
            // Discovery from CJS (post-transform)
            const cjsMatches = code.matchAll(/require\(["']([^./][^'"]*)['"]\)/g);
            for (const m of cjsMatches) {
                if (!['react', 'react-dom', 'react-dom/client', 'axios', 'vue'].includes(m[1])) {
                    thirdPartyDeps.add(m[1]);
                }
            }
        });

        // 3. Bundler Script
        const escapeScriptTags = (str) => str.replace(/<\/script>/g, '<\\/script>');
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
                    let target = path;
                    if (path.startsWith('./') || path.startsWith('../')) {
                        target = normalizePath(currentDir + "/" + path);
                    } else if (path.startsWith('/')) {
                        target = normalizePath(path);
                    }
                    
                    const tryPaths = [
                        target, target + ".jsx", target + ".js",
                        target + "/index.jsx", target + "/index.js",
                        "src/" + target, "src/" + target + ".jsx", "src/" + target + ".js",
                        "src/" + target + "/index.jsx", "src/" + target + "/index.js"
                    ];
                    
                    return tryPaths.find(p => window.__VFS__[p] !== undefined);
                }

                function require(path, currentFile = "") {
                    if (path === 'react') return window.React;
                    if (path === 'react-dom' || path === 'react-dom/client') return window.ReactDOM;
                    if (path === 'vue') return window.Vue;
                    if (path === 'axios') return window.axios;
                    
                    if (window.__EXTERNAL_DEPS__[path]) {
                        return window.__EXTERNAL_DEPS__[path].default || window.__EXTERNAL_DEPS__[path];
                    }
                    
                    if (path.endsWith('.css')) return {};
                    if (path.match(/\\.(svg|png|jpg|jpeg|gif|webp)$/i)) return path; 

                    const currentDir = currentFile.split('/').slice(0, -1).join('/');
                    const resolved = resolve(path, currentDir);
                    
                    if (!resolved) throw new Error("Module not found: " + path + (currentFile ? " (imported by " + currentFile + ")" : ""));
                    if (window.__CACHE__[resolved]) return window.__CACHE__[resolved];

                    const code = window.__VFS__[resolved];
                    const module = { exports: {} };
                    
                    try {
                        const customRequire = (p) => require(p, resolved);
                        const fn = new Function('require', 'module', 'exports', 'React', 'ReactDOM', 'Vue', code);
                        fn(customRequire, module, module.exports, window.React, window.ReactDOM, window.Vue);
                        
                        window.__CACHE__[resolved] = module.exports.default || module.exports;
                        return window.__CACHE__[resolved];
                    } catch (e) {
                        showError("Error in " + resolved + ":\\n" + e.message + "\\n\\n" + e.stack);
                        throw e;
                    }
                }

                async function boot() {
                    const status = document.getElementById('ide-status');
                    try {
                        let attempts = 0;
                        while(window.__PENDING_DEPS__ > 0 && attempts < 100) {
                            await new Promise(r => setTimeout(r, 100));
                            attempts++;
                        }

                        if (window.__IS_HTML_MODE__) {
                             if (status) { status.style.opacity = '0'; setTimeout(() => status.style.display = 'none', 300); }
                             return;
                        }

                        const potentialEntries = [
                            window.__ENTRY__, 
                            'src/index.js', 'src/main.jsx', 'src/main.js', 'main.jsx', 'main.js', 'src/App.jsx', 'App.jsx', 'index.js'
                        ];
                        const entry = potentialEntries.find(p => p && (window.__VFS__[p] || resolve(p)));
                        
                        if (entry) {
                            const exported = require(entry);
                            let root = document.getElementById('root') || document.getElementById('app');
                            if (!root) {
                                root = document.createElement('div');
                                root.id = 'root';
                                document.body.appendChild(root);
                            }

                            if (root.innerHTML.trim() === '') {
                                const Component = exported.default || exported;
                                if (Component && (typeof Component === 'function' || typeof Component === 'object')) {
                                    const React = window.React;
                                    const ReactDOM = window.ReactDOM;
                                    if (ReactDOM.createRoot) {
                                        ReactDOM.createRoot(root).render(React.createElement(Component));
                                    } else {
                                        ReactDOM.render(React.createElement(Component), root);
                                    }
                                }
                            }
                            if (status) { status.style.opacity = '0'; setTimeout(() => status.style.display = 'none', 300); }
                        }
                    } catch (err) {
                        showError(err.stack || err.message);
                    }
                }

                window.addEventListener('load', boot);
            })();
        `;

        // 4. HTML Construction
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

        const deps = `
            <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script src="https://unpkg.com/axios/dist/axios.min.js"></script>
            <script src="https://cdn.tailwindcss.com"></script>
            <script>window.__PENDING_DEPS__ = ${thirdPartyDeps.size}; window.__EXTERNAL_DEPS__ = {};</script>
        `;

        const externalDepScripts = Array.from(thirdPartyDeps).map(dep => `
            <script type="module">
                import * as mod from 'https://esm.sh/${dep}';
                window.__EXTERNAL_DEPS__['${dep}'] = mod;
                window.__PENDING_DEPS__--;
            </script>
        `).join('');

        const cssFiles = Object.keys(vfs).filter(f => f.endsWith('.css'));
        const styles = cssFiles.map(f => `<style id="${f}">\n${vfs[f]}\n</style>`).join('\n');

        let finalHtml = htmlTemplate;
        const statusOverlay = `
            <div id="ide-status" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(30, 30, 30, 0.8);backdrop-filter:blur(10px);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;z-index:99998;transition:opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1);pointer-events:none;">
                <div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#007acc;border-radius:50%;animation:ide-spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;margin-bottom:16px;box-shadow:0 0 15px rgba(0,122,204,0.3);"></div>
                <div style="font-size:14px;font-weight:500;letter-spacing:0.5px;opacity:0.8;animation:ide-pulse 2s ease-in-out infinite;">Bundling application...</div>
                <style>
                    @keyframes ide-spin { to { transform: rotate(360deg); } }
                    @keyframes ide-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
                </style>
            </div>`;

        if (finalHtml.includes('<head>')) {
            finalHtml = finalHtml.replace('<head>', '<head>' + deps + externalDepScripts + styles);
        } else {
            finalHtml = deps + externalDepScripts + styles + finalHtml;
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
    }, [content, fileName, files, fullPath, babelLoaded]);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedHtml(fullHtml);
        }, 800); // 800ms debounce

        return () => clearTimeout(handler);
    }, [fullHtml]);

    return (
        <div style={{ width: '100%', height: '100%', background: 'white', overflow: 'hidden' }}>
            <iframe
                srcDoc={debouncedHtml}
                key={fileName}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Web Preview"
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
        </div>
    );
}
