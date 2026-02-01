import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import CodeEditor from "./CodeEditor";
import Terminal from "./Terminal";
import FileTreeItem from "./FileTreeItem";
import ActivityBar from "./ActivityBar";
import StatusBar from "./StatusBar";
import MenuBar from "./MenuBar";
import SearchView from "./SearchView";
import FileIcon from "./FileIcon";
import {
    FilePlus,
    FolderPlus,
    FolderOpen as FolderOpenIcon,
    X,
    Search as SearchIcon,
    Play,
    SplitSquareHorizontal,
    Save,
    MoreHorizontal,
    ChevronRight,
    Trash2,
    Edit2,
    Eye,
    EyeOff,
    Settings,
    Package
} from "lucide-react";
import io from "socket.io-client";
import WebPreview from "./WebPreview";
import { getFileLanguage, stripAnsi } from "../utils/helpers";
import { LANGUAGES } from "../config/languages";
import "./ideLayout.css";
import "./activityBar.css";
import "./menuBar.css";
import CommandPalette from "./CommandPalette";
import ContextMenu from "./ContextMenu";
import "./contextMenu.css";
import "./commandPalette.css";
import DBExplorer from './DBExplorer';
import QueryPane from './QueryPane';
import { CORE_MODULES } from '../config/modules';

const BACKEND_URL =
    process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";

const generateId = () => Math.random().toString(36).substr(2, 9);

export default function IDELayout() {
    /* ================= STATE ================= */
    const [files, setFiles] = useState([]);
    const [openFiles, setOpenFiles] = useState([]);
    const [activeFileId, setActiveFileId] = useState(null);

    const [activeSidebarView, setActiveSidebarView] = useState("explorer");
    const [modules, setModules] = useState(CORE_MODULES);
    const [activePanel, setActivePanel] = useState("terminal");

    const [terminals, setTerminals] = useState([{ id: "t1", title: "terminal", output: [], busy: false }]);
    const [activeTerminalId, setActiveTerminalId] = useState("t1");
    const [isExecuting, setIsExecuting] = useState(false);
    const [currentPath, setCurrentPath] = useState(""); // String path for prompt
    const [selectedFolderId, setSelectedFolderId] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [isSaving, setIsSaving] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
    const [contextMenu, setContextMenu] = useState(null); // { x, y, item }
    const [isSidebarVisible, setIsSidebarVisible] = useState(true);
    const [activeDB, setActiveDB] = useState(null); // { id, dbName, table }
    const [executionMode, setExecutionMode] = useState("auto");

    const socketRef = useRef(null);
    const activeTerminalIdRef = useRef(activeTerminalId);

    const activeFile = useMemo(
        () => openFiles.find(f => f.id === activeFileId) || null,
        [openFiles, activeFileId]
    );

    /* ================= HELPERS ================= */

    const getPathFromId = useCallback((items, id) => {
        if (!id) return [];
        for (const item of items) {
            if (item.id === id) return [item.name];
            if (item.children) {
                const path = getPathFromId(item.children, id);
                if (path) return [item.name, ...path];
            }
        }
        return null;
    }, []);

    const mergeFolderStates = useCallback((oldItems, newItems) => {
        const oldStateMap = new Map();
        const traverseOld = (items) => {
            if (!Array.isArray(items)) return;
            items.forEach(item => {
                if (item.isDir && item.isOpen !== undefined) {
                    oldStateMap.set(item.id, item.isOpen);
                }
                if (item.children) traverseOld(item.children);
            });
        };
        traverseOld(oldItems);

        const traverseNew = (items) => {
            if (!Array.isArray(items)) return [];
            return items.map(item => {
                const updatedItem = { ...item };
                if (item.isDir && oldStateMap.has(item.id)) {
                    updatedItem.isOpen = oldStateMap.get(item.id);
                }
                if (item.children) {
                    updatedItem.children = traverseNew(item.children);
                }
                return updatedItem;
            });
        };
        return traverseNew(newItems);
    }, []);

    const addItem = (items, parentId, newItem) => {
        if (!parentId) return [...items, newItem];
        return items.map(item => {
            if (item.id === parentId && item.isDir) {
                return { ...item, isOpen: true, children: [...(item.children || []), newItem] };
            }
            if (item.children) {
                return { ...item, children: addItem(item.children, parentId, newItem) };
            }
            return item;
        });
    };

    const deleteItem = (items, itemId) => {
        return items
            .filter(item => item.id !== itemId)
            .map(item => {
                if (item.children) return { ...item, children: deleteItem(item.children, itemId) };
                return item;
            });
    };

    const toggleFolderRecursive = (items, folderId) => {
        return items.map(item => {
            if (item.id === folderId && item.isDir) return { ...item, isOpen: !item.isOpen };
            if (item.children) return { ...item, children: toggleFolderRecursive(item.children, folderId) };
            return item;
        });
    };

    const renameItemRecursive = (items, id, newName) => {
        return items.map(item => {
            if (item.id === id) return { ...item, name: newName };
            if (item.children) return { ...item, children: renameItemRecursive(item.children, id, newName) };
            return item;
        });
    };

    /* ================= HANDLERS ================= */

    const handleRunCode = useCallback(() => {
        if (!activeFile) return;

        // --- WEB INTERCEPTOR ---
        // If it's a web file, open preview instead of running on backend
        const ext = activeFile.name.split('.').pop().toLowerCase();
        if (['html', 'htm', 'jsx', 'tsx', 'vue', 'svelte'].includes(ext)) {
            setShowPreview(true);
            setActivePanel("terminal");
            setTerminals(prev => prev.map(t =>
                t.id === activeTerminalId ? {
                    ...t,
                    output: [...t.output, `▶ Starting Web Preview for ${activeFile.name}...`]
                } : t
            ));
            return;
        }

        if (isExecuting) {
            alert("Code is already running. Please wait.");
            return;
        }

        setIsExecuting(true);
        setActivePanel("terminal");
        setTerminals(prev => prev.map(t =>
            t.id === activeTerminalId ? { ...t, output: [...t.output, `▶ Executing ${activeFile.name}...`], busy: true } : t
        ));

        if (socketRef.current?.connected) {
            console.log(`[Frontend] 🚀 Sending execution request with mode: "${executionMode}"`);
            socketRef.current.emit("execute", {
                language: getFileLanguage(activeFile.name),
                code: activeFile.content,
                fileName: activeFile.name,
                executionMode: executionMode
            });
        } else {
            setTerminals(prev => prev.map(t =>
                t.id === activeTerminalId ? { ...t, output: [...t.output, "\n❌ Error: Socket not connected.\n"] } : t
            ));
            setIsExecuting(false);
        }
    }, [activeFile, activeTerminalId, isExecuting, executionMode]);

    const handleSave = useCallback(() => {
        if (!activeFileId || !activeFile) return;

        setIsSaving(true);
        const pathArr = getPathFromId(files, activeFileId);
        if (pathArr) {
            const fullPath = pathArr.join('/');
            if (socketRef.current?.connected) {
                socketRef.current.emit("file:save", { path: fullPath, content: activeFile.content });
                console.log("[Save] Saved to backend:", fullPath);
            }
        }
        setTimeout(() => setIsSaving(false), 800);
    }, [activeFileId, activeFile, files, getPathFromId]);

    const handleCreateItem = useCallback((isDir) => {
        const name = prompt(`Enter ${isDir ? 'folder' : 'file'} name:`);
        if (!name) return;
        const newItem = {
            id: generateId(),
            name,
            isDir,
            isOpen: isDir,
            children: isDir ? [] : undefined,
            content: isDir ? undefined : ""
        };
        setFiles(prev => addItem(prev, selectedFolderId, newItem));

        const parentPathArr = getPathFromId(files, selectedFolderId) || [];
        const fullPath = [...parentPathArr, name].join('/');

        if (socketRef.current?.connected) {
            socketRef.current.emit("file:save", { path: fullPath, content: "", isDir: isDir });
            if (isDir) socketRef.current.emit("terminal:input", `mkdir "${fullPath}"\n`);
        }
    }, [files, selectedFolderId, getPathFromId]);

    const handleRenameCommit = useCallback((id, newName) => {
        const oldPathArr = getPathFromId(files, id);
        if (oldPathArr) {
            const oldPath = oldPathArr.join('/');
            const newPathArr = [...oldPathArr];
            newPathArr[newPathArr.length - 1] = newName;
            const newPath = newPathArr.join('/');

            if (socketRef.current?.connected) {
                socketRef.current.emit("file:rename", { oldPath, newPath });
            }
        }

        setFiles(prev => renameItemRecursive(prev, id, newName));
        setOpenFiles(prev => prev.map(f => f.id === id ? { ...f, name: newName } : f));
        setEditingId(null);
    }, [files, getPathFromId]);

    const openFile = useCallback(file => {
        if (!openFiles.find(f => f.id === file.id)) {
            setOpenFiles(prev => [...prev, file]);
        }
        setActiveFileId(file.id);

        if (file.content === null && socketRef.current?.connected) {
            socketRef.current.emit("file:read", { path: file.id });
        }
    }, [openFiles]);

    const closeFile = useCallback((e, id) => {
        e.stopPropagation();
        const rest = openFiles.filter(f => f.id !== id);
        setOpenFiles(rest);
        if (id === activeFileId) {
            setActiveFileId(rest.length ? rest[rest.length - 1].id : null);
        }
    }, [openFiles, activeFileId]);

    const handleContextMenu = useCallback((e, item) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, item });
    }, []);

    const handleContextAction = useCallback((actionId, item) => {
        if (actionId === 'rename') setEditingId(item.id);
        if (actionId === 'delete') {
            if (window.confirm(`Delete ${item.name}?`)) {
                const pathArr = getPathFromId(files, item.id);
                if (pathArr && socketRef.current?.connected) {
                    const fullPath = pathArr.join('/');
                    socketRef.current.emit("file:delete", { path: fullPath });
                }
                setFiles(prev => deleteItem(prev, item.id));
                setOpenFiles(prev => prev.filter(f => f.id !== item.id));
            }
        }
        if (actionId === 'new-file') {
            setSelectedFolderId(item.id);
            handleCreateItem(false);
        }
        if (actionId === 'new-folder') {
            setSelectedFolderId(item.id);
            handleCreateItem(true);
        }
        if (actionId === 'copy-path') {
            navigator.clipboard.writeText(item.name);
        }
    }, [files, getPathFromId, handleCreateItem]);

    /* ================= EFFECTS ================= */

    useEffect(() => {
        activeTerminalIdRef.current = activeTerminalId;
    }, [activeTerminalId]);

    useEffect(() => {
        socketRef.current = io(BACKEND_URL);

        socketRef.current.on("connect", () => {
            socketRef.current.emit("terminal:init");
            socketRef.current.emit("files:list");
        });

        socketRef.current.on("output", data => {
            const lines = data.toString().split(/\r?\n/).map(stripAnsi);
            setTerminals(prev => prev.map(t =>
                t.id === activeTerminalIdRef.current ? { ...t, output: [...t.output, ...lines] } : t
            ));
        });

        socketRef.current.on("files:list:response", (fileTree) => {
            setFiles(prev => mergeFolderStates(prev, fileTree));
        });

        socketRef.current.on("terminal:cwd", (path) => {
            setCurrentPath(path);
        });

        socketRef.current.on("file:read:response", ({ path, content }) => {
            setOpenFiles(prev => prev.map(f => f.id === path ? { ...f, content } : f));
        });

        socketRef.current.on("execution_complete", () => setIsExecuting(false));

        socketRef.current.on("terminal:status", ({ busy }) => {
            setTerminals(prev => prev.map(t => t.id === activeTerminalIdRef.current ? { ...t, busy } : t));
        });

        socketRef.current.on("terminal:clear", () => {
            setTerminals(prev => prev.map(t =>
                t.id === activeTerminalIdRef.current ? { ...t, output: [] } : t
            ));
        });

        socketRef.current.on("error", errorMsg => {
            setTerminals(prev => prev.map(t =>
                t.id === activeTerminalIdRef.current ? { ...t, output: [...t.output, `\n❌ Error: ${errorMsg}\n`] } : t
            ));
            setIsExecuting(false);
        });

        return () => socketRef.current.disconnect();
    }, [mergeFolderStates]);

    useEffect(() => {
        const handleGlobalKeyDown = (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); setIsCommandPaletteOpen(true); }
            else if (e.ctrlKey && e.key === 'p') { e.preventDefault(); setIsCommandPaletteOpen(true); }
            else if (e.ctrlKey && e.key === 's') { e.preventDefault(); handleSave(); }
            else if (e.ctrlKey && e.key === 'b') { e.preventDefault(); setIsSidebarVisible(prev => !prev); }
            else if (e.altKey && e.key === 'n') { e.preventDefault(); handleCreateItem(false); }
            else if (e.altKey && e.shiftKey && e.key === 'N') { e.preventDefault(); handleCreateItem(true); }
            else if (e.key === 'F5' || (e.ctrlKey && e.key === 'Enter')) { e.preventDefault(); handleRunCode(); }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [handleRunCode, handleSave, handleCreateItem]);

    useEffect(() => {
        if (!activeFileId || files.length === 0) return;
        const timeoutId = setTimeout(() => {
            const file = openFiles.find(f => f.id === activeFileId);
            if (!file) return;
            const pathArr = getPathFromId(files, activeFileId);
            if (pathArr && socketRef.current?.connected) {
                socketRef.current.emit("file:save", { path: pathArr.join('/'), content: file.content });
            }
        }, 2000);
        return () => clearTimeout(timeoutId);
    }, [openFiles, activeFileId, files, getPathFromId]);

    /* ================= RENDER HELPERS ================= */

    const renderTree = (items, level = 0, parentId = null) =>
        items.map(item => (
            <div key={item.id}>
                <div
                    className={`file-tree-row ${activeFileId === item.id ? "active" : ""
                        } ${selectedFolderId === item.id ? "selected" : ""}`}
                    style={{ paddingLeft: `${level * 14 + 12}px` }}
                    onContextMenu={(e) => handleContextMenu(e, item)}
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent bubbling to background
                        if (item.isDir) {
                            setFiles(prev => toggleFolderRecursive(prev, item.id));
                            setSelectedFolderId(item.id);
                        } else {
                            openFile(item);
                            // Set context to the parent folder when a file is clicked
                            setSelectedFolderId(parentId);
                        }
                    }}
                >
                    <FileTreeItem
                        name={item.name}
                        isDir={item.isDir}
                        isOpen={item.isOpen}
                        isEditing={editingId === item.id}
                        onCommit={(newName) => handleRenameCommit(item.id, newName)}
                        onCancel={() => setEditingId(null)}
                    />
                </div>
                {item.isDir && item.isOpen && item.children && (
                    <div className="tree-children">{renderTree(item.children, level + 1, item.id)}</div>
                )}
            </div>
        ));

    /* ================= TERMINAL/OTHER ================= */

    const addTerminal = () => {
        const id = generateId();
        setTerminals(prev => [...prev, { id, title: `terminal ${prev.length + 1}`, output: [], busy: false }]);
        setActiveTerminalId(id);
    };

    const closeTerminal = (e, id) => {
        e.stopPropagation();
        if (terminals.length > 1) {
            const rest = terminals.filter(t => t.id !== id);
            setTerminals(rest);
            if (id === activeTerminalId) {
                setActiveTerminalId(rest[rest.length - 1].id);
            }
        }
    };

    const handleTerminalCommand = cmd => {
        const rawCmd = cmd.trim();
        // Allow empty commands if sending newline to stdin
        if (rawCmd === '' && terminals.find(t => t.id === activeTerminalId)?.busy) {
            if (socketRef.current?.connected) socketRef.current.emit("terminal:input", '\n');
            return;
        }
        if (!rawCmd) return;

        setTerminals(prev => prev.map(t => {
            if (t.id === activeTerminalId) {
                // If busy, we are sending stdin to a running process (which usually echoes back).
                // So DO NOT print it locally to avoid double echo.
                if (t.busy) {
                    return t;
                }
                // If not busy, it's a shell command, so show the prompt line.
                const promptPath = currentPath ? `\\${currentPath}` : "";
                const logLine = `Teachgrid${promptPath}> ${rawCmd}`;
                return { ...t, output: [...t.output, logLine] };
            }
            return t;
        }));

        if (socketRef.current?.connected) {
            // If it's a special signal like (Ctrl+C), send as is.
            if (rawCmd === '\x03') {
                socketRef.current.emit("terminal:input", rawCmd);
            } else {
                // Otherwise append newline specifically
                socketRef.current.emit("terminal:input", rawCmd + '\n');
            }
        }
    };

    const commands = [
        { id: 'run', label: 'Run Code', icon: <Play size={14} />, shortcut: 'F5', action: handleRunCode },
        { id: 'preview', label: 'Toggle Web Preview', icon: <Eye size={14} />, shortcut: 'Ctrl+Shift+P', action: () => setShowPreview(!showPreview) },
        { id: 'new-file', label: 'New File', icon: <FilePlus size={14} />, shortcut: 'Alt+N', action: () => handleCreateItem(false) },
        { id: 'new-folder', label: 'New Folder', icon: <FolderPlus size={14} />, shortcut: 'Alt+Shift+N', action: () => handleCreateItem(true) },
        { id: 'sidebar', label: 'Toggle Sidebar', icon: <ChevronRight size={14} />, shortcut: 'Ctrl+B', action: () => setIsSidebarVisible(!isSidebarVisible) },
        { id: 'settings', label: 'Open Settings', icon: <Settings size={14} />, shortcut: 'Ctrl+,', action: () => alert('Settings coming soon!') },
    ];

    return (
        <div className="ide-root">
            <MenuBar onRun={handleRunCode} />
            <main className="ide-workspace">
                <ActivityBar activeView={activeSidebarView} onViewChange={setActiveSidebarView} modules={modules} />

                {isSidebarVisible && (
                    <aside className="ide-sidebar">
                        <header className="sidebar-header">
                            <span>{modules.find(m => m.id === activeSidebarView)?.title || 'EXPLORER'}</span>
                            {activeSidebarView === 'explorer' && (
                                <div className="sidebar-actions">
                                    <FilePlus size={16} onClick={() => handleCreateItem(false)} title="New File" />
                                    <FolderPlus size={16} onClick={() => handleCreateItem(true)} title="New Folder" />
                                    <FolderOpenIcon size={16} onClick={() => setSelectedFolderId(null)} title="Collapse All" />
                                </div>
                            )}
                        </header>
                        <div className="sidebar-tree" onClick={(e) => {
                            // If clicking empty space (not a tree item), reset selection to root
                            if (e.target === e.currentTarget) setSelectedFolderId(null);
                        }}>
                            {activeSidebarView === "explorer" && renderTree(files)}
                            {activeSidebarView === "search" && <SearchView files={files} onFileOpen={openFile} />}
                            {activeSidebarView === "database" && <DBExplorer onSelectTable={(id, db, table) => setActiveDB({ id, db, table })} />}
                            {!['explorer', 'search', 'database'].includes(activeSidebarView) && (
                                <div className="dynamic-module-placeholder">
                                    <Package size={40} opacity={0.2} />
                                    <span>{activeSidebarView.toUpperCase()} Module</span>
                                </div>
                            )}
                        </div>
                    </aside>
                )}

                <section className="ide-main">
                    {/* Tabs Area */}
                    <nav className="ide-tabs">
                        {openFiles.map(file => (
                            <div
                                key={file.id}
                                className={`ide-tab ${file.id === activeFileId ? "active" : ""}`}
                                onClick={() => setActiveFileId(file.id)}
                            >
                                <FileIcon name={file.name} size={14} />
                                <span className="tab-name">{file.name}</span>
                                <X
                                    size={14}
                                    className="lucide-x"
                                    onClick={e => closeFile(e, file.id)}
                                />
                            </div>
                        ))}
                    </nav>

                    {/* Breadcrumbs Area */}
                    <div className="ide-breadcrumbs">
                        <div className="breadcrumb-path">
                            <span>src</span>
                            <ChevronRight size={12} opacity={0.5} />
                            <span>{activeFile ? activeFile.name : "Welcome"}</span>
                        </div>

                        <div className="editor-actions">
                            <select
                                className="mode-select"
                                value={executionMode}
                                onChange={(e) => setExecutionMode(e.target.value)}
                            >
                                <option value="auto">Auto-route</option>
                                <option value="local">Local Engine</option>
                                <option value="piston">Cloud API</option>
                            </select>

                            <div className="action-divider" />

                            <div
                                className={`action-btn ${showPreview ? 'active' : ''}`}
                                onClick={() => setShowPreview(!showPreview)}
                                title="Toggle Web Preview"
                            >
                                {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
                            </div>

                            {isExecuting ? (
                                <div className="spinner-small" />
                            ) : (
                                <div className="action-btn" onClick={handleRunCode} title="Run (F5)">
                                    <Play size={14} />
                                </div>
                            )}

                            <div
                                className={`action-btn ${isSaving ? 'saving' : ''}`}
                                onClick={handleSave}
                                title="Save (Ctrl+S)"
                            >
                                <Save size={14} />
                            </div>

                            <div className="action-btn">
                                <MoreHorizontal size={14} />
                            </div>
                        </div>
                    </div>

                    {/* Editor & Side Panes Container */}
                    <div className="ide-content-area">
                        <div className="ide-editor-container" style={{ flex: showPreview || activeDB ? 1 : '1 0 100%' }}>
                            {activeFile ? (
                                <CodeEditor
                                    activeFile={activeFile}
                                    onCodeChange={code => {
                                        setOpenFiles(prev => prev.map(f => f.id === activeFileId ? { ...f, content: code } : f));
                                        setFiles(prev => {
                                            const updateItemRecursive = (items, id, newCode) => {
                                                return items.map(item => {
                                                    if (item.id === id) return { ...item, content: newCode };
                                                    if (item.children) return { ...item, children: updateItemRecursive(item.children, id, newCode) };
                                                    return item;
                                                });
                                            };
                                            return updateItemRecursive(prev, activeFileId, code);
                                        });
                                    }}
                                />
                            ) : (
                                <div className="empty-state">
                                    <div className="empty-state-logo">
                                        <Package size={80} opacity={0.1} />
                                    </div>
                                    <h2>TeachGrid IDE</h2>
                                    <div className="shortcuts-help">
                                        <div className="shortcut-row">
                                            <span>Show All Commands</span>
                                            <kbd>Ctrl+Shift+P</kbd>
                                        </div>
                                        <div className="shortcut-row">
                                            <span>Go to File</span>
                                            <kbd>Ctrl+P</kbd>
                                        </div>
                                        <div className="shortcut-row">
                                            <span>Toggle Sidebar</span>
                                            <kbd>Ctrl+B</kbd>
                                        </div>
                                        <div className="shortcut-row">
                                            <span>Run Code</span>
                                            <kbd>F5</kbd>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {activeDB && (
                            <div className="side-pane database-pane">
                                <QueryPane
                                    connectionId={activeDB.id}
                                    dbName={activeDB.db}
                                    tablename={activeDB.table}
                                    onClose={() => setActiveDB(null)}
                                />
                            </div>
                        )}

                        {showPreview && activeFile && (
                            <div className="side-pane preview-pane">
                                <WebPreview
                                    fileName={activeFile.name}
                                    fullPath={getPathFromId(files, activeFileId)?.join('/')}
                                    content={activeFile.content}
                                    files={files}
                                />
                            </div>
                        )}
                    </div>

                    {/* Bottom Panel */}
                    <footer className="ide-panel">
                        <div className="panel-tabs">
                            <div className="panel-tabs-main">
                                {["PROBLEMS", "OUTPUT", "TERMINAL"].map(t => (
                                    <div
                                        key={t}
                                        className={`panel-tab ${activePanel === t.toLowerCase() ? "active" : ""}`}
                                        onClick={() => setActivePanel(t.toLowerCase())}
                                    >
                                        {t}
                                    </div>
                                ))}
                            </div>

                            {activePanel === "terminal" && (
                                <div className="terminal-tabs-container">
                                    {terminals.map(t => (
                                        <div
                                            key={t.id}
                                            className={`terminal-tab ${t.id === activeTerminalId ? "active" : ""}`}
                                            onClick={() => setActiveTerminalId(t.id)}
                                        >
                                            <span className="term-title">{t.title}</span>
                                            <X size={12} onClick={(e) => closeTerminal(e, t.id)} />
                                        </div>
                                    ))}
                                    <div className="add-terminal-btn" onClick={addTerminal}>+</div>
                                </div>
                            )}
                        </div>

                        <div className="panel-content">
                            {activePanel === "terminal" && (
                                <Terminal
                                    output={terminals.find(t => t.id === activeTerminalId)?.output || []}
                                    onCommand={handleTerminalCommand}
                                    onClear={() => setTerminals(prev => prev.map(t => t.id === activeTerminalId ? { ...t, output: [] } : t))}
                                    onClose={(e) => closeTerminal(e, activeTerminalId)}
                                    path={currentPath}
                                    busy={terminals.find(t => t.id === activeTerminalId)?.busy || false}
                                />
                            )}
                        </div>
                    </footer>
                </section>
            </main>

            <StatusBar
                language={activeFile ? getFileLanguage(activeFile.name) : "Plain Text"}
                isExecuting={isExecuting}
                isSaving={isSaving}
            />

            {isCommandPaletteOpen && (
                <CommandPalette
                    commands={commands}
                    onClose={() => setIsCommandPaletteOpen(false)}
                    onExecute={(cmd) => {
                        cmd.action();
                        setIsCommandPaletteOpen(false);
                    }}
                />
            )}

            {contextMenu && (
                <ContextMenu
                    position={{ x: contextMenu.x, y: contextMenu.y }}
                    item={contextMenu.item}
                    onAction={handleContextAction}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
