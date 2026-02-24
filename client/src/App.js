import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
export default function App() {
    const [activePanel, setActivePanel] = useState("chat");
    return (_jsxs("div", { className: "d-flex flex-column vh-100", children: [_jsxs("nav", { className: "navbar navbar-expand navbar-dark bg-dark px-3", children: [_jsx("span", { className: "navbar-brand fw-bold me-4", children: "Metaclaw" }), _jsxs("div", { className: "navbar-nav", children: [_jsx("button", { className: `btn btn-sm me-2 ${activePanel === "chat" ? "btn-primary" : "btn-outline-secondary"}`, onClick: () => setActivePanel("chat"), children: "Chat" }), _jsx("button", { className: `btn btn-sm ${activePanel === "settings" ? "btn-primary" : "btn-outline-secondary"}`, onClick: () => setActivePanel("settings"), children: "\u2699 Settings" })] })] }), _jsx("main", { className: "flex-grow-1 overflow-hidden", children: activePanel === "chat" ? _jsx(ChatPanel, {}) : _jsx(SettingsPanel, {}) })] }));
}
function ChatPanel() {
    return (_jsxs("div", { className: "d-flex flex-column h-100 p-3", children: [_jsx("div", { className: "flex-grow-1 border rounded p-3 mb-3 overflow-auto bg-light", children: _jsx("p", { className: "text-muted fst-italic", children: "No messages yet." }) }), _jsxs("div", { className: "input-group", children: [_jsx("input", { type: "text", className: "form-control", placeholder: "Send a message\u2026", disabled: true }), _jsx("button", { className: "btn btn-primary", disabled: true, children: "Send" })] })] }));
}
function SettingsPanel() {
    return (_jsxs("div", { className: "p-4", children: [_jsx("h5", { children: "Settings" }), _jsx("p", { className: "text-muted", children: "System prompt, tools, and state will appear here." })] }));
}
