import React, { useState, useRef, useLayoutEffect } from "react";
import { Plus, Trash2, SplitSquareHorizontal, X } from "lucide-react";
import "./terminal.css";

export default function Terminal({ output, onCommand, onClear, onClose, path = "~", busy = false }) {
    const endRef = useRef(null);
    const inputRef = useRef(null);
    const [input, setInput] = useState("");

    useLayoutEffect(() => {
        endRef.current?.scrollIntoView({ behavior: "auto" });
    }, [output]);

    const handleKeyDown = (e) => {
        if (e.key === "Enter") {
            onCommand(input);
            setInput("");
        } else if (e.ctrlKey && e.key === "c") {
            // If user has text selected, let browser copy.
            if (!window.getSelection().toString()) {
                e.preventDefault();
                onCommand("\x03", true); // Send SIGINT, set isRaw=true
            }
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onCommand("\x1b[A", true);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onCommand("\x1b[B", true);
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            onCommand("\x1b[D", true);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onCommand("\x1b[C", true);
        } else if (e.key === "Tab") {
            e.preventDefault();
            onCommand("\t", true);
        }
    };

    const handleClick = () => {
        inputRef.current?.focus();
    };

    return (
        <div className="terminal-container" onClick={handleClick}>
            {/* Header omitted for brevity */}
            <div className="terminal-header">
                <div className="terminal-header-left">
                    <span>TERMINAL</span>
                </div>
                <div className="terminal-header-actions">
                    <Plus size={14} className="terminal-action-icon" title="New Terminal" />
                    <Trash2 size={14} className="terminal-action-icon" title="Clear Terminal" onClick={onClear} />
                    <SplitSquareHorizontal size={14} className="terminal-action-icon" title="Split Terminal" />
                    <X size={14} className="terminal-action-icon" title="Kill Terminal" onClick={onClose} />
                </div>
            </div>

            {/* Body */}
            <div className="terminal-body">
                <div className="terminal-welcome">
                    TeachGrid Terminal v1.1.0<br />
                    type <span>help</span> to get started
                </div>

                {output.map((line, i) => (
                    <div key={i} className="terminal-line">
                        {line.includes(">") ? (
                            <>
                                <span className="prompt">{line.split(">")[0]}{'>'}</span>
                                <span className="command">
                                    {line.split(">")[1]}
                                </span>
                            </>
                        ) : (
                            line
                        )}
                    </div>
                ))}

                {/* Input - Always visible to allow interaction with running processes */}
                <div className="terminal-input">
                    {!busy && <span className="prompt">Teachgrid{path === "~" || !path ? "" : `\\${path}`}{'>'}</span>}
                    <input
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        spellCheck="false"
                        autoComplete="off"
                        autoFocus
                    />
                </div>


                <div ref={endRef} />
            </div>
        </div>
    );
}
