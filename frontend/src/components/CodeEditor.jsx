import React, { useEffect, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import "./codeEditor.css";

// Configure Monaco to load from UNPKG instead of JSDelivr to bypass tracking prevention
loader.config({
    paths: {
        vs: "https://unpkg.com/monaco-editor@0.55.1/min/vs"
    }
});

export default function CodeEditor({ activeFile, onCodeChange }) {
    const [code, setCode] = useState("");

    useEffect(() => {
        if (activeFile) {
            setCode(activeFile.content || "");
        }
    }, [activeFile]);

    const getLanguage = (fileName) => {
        if (!fileName) return "javascript";
        const ext = fileName.split(".").pop().toLowerCase();
        const map = {
            js: "javascript",
            jsx: "javascript",
            ts: "typescript",
            tsx: "typescript",
            css: "css",
            html: "html",
            json: "json",
            py: "python",
            md: "markdown",
        };
        return map[ext] || "javascript";
    };

    return (
        <div className="editor-container">
            {/* Header */}
            <div className="editor-header">
                <span className="editor-file">
                    {activeFile?.name || "Untitled"}
                </span>
            </div>

            {/* Monaco Editor */}
            <div className="editor-body">
                <Editor
                    height="100%"
                    language={getLanguage(activeFile?.name)}
                    value={code}
                    theme="vs-dark"
                    onChange={(value) => {
                        setCode(value);
                        onCodeChange?.(value);
                    }}

                    options={{
                        fontSize: 14,
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        tabSize: 4,
                        wordWrap: "on",
                    }}
                />
            </div>
        </div>
    );
}
