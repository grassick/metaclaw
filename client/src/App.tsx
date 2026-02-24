import { useState } from "react";

type Panel = "chat" | "settings";

export default function App() {
  const [activePanel, setActivePanel] = useState<Panel>("chat");

  return (
    <div className="d-flex flex-column vh-100">
      {/* Nav */}
      <nav className="navbar navbar-expand navbar-dark bg-dark px-3">
        <span className="navbar-brand fw-bold me-4">Metaclaw</span>
        <div className="navbar-nav">
          <button
            className={`btn btn-sm me-2 ${activePanel === "chat" ? "btn-primary" : "btn-outline-secondary"}`}
            onClick={() => setActivePanel("chat")}
          >
            Chat
          </button>
          <button
            className={`btn btn-sm ${activePanel === "settings" ? "btn-primary" : "btn-outline-secondary"}`}
            onClick={() => setActivePanel("settings")}
          >
            ⚙ Settings
          </button>
        </div>
      </nav>

      {/* Active panel */}
      <main className="flex-grow-1 overflow-hidden">
        {activePanel === "chat" ? <ChatPanel /> : <SettingsPanel />}
      </main>
    </div>
  );
}

function ChatPanel() {
  return (
    <div className="d-flex flex-column h-100 p-3">
      <div className="flex-grow-1 border rounded p-3 mb-3 overflow-auto bg-light">
        <p className="text-muted fst-italic">No messages yet.</p>
      </div>
      <div className="input-group">
        <input
          type="text"
          className="form-control"
          placeholder="Send a message…"
          disabled
        />
        <button className="btn btn-primary" disabled>
          Send
        </button>
      </div>
    </div>
  );
}

function SettingsPanel() {
  return (
    <div className="p-4">
      <h5>Settings</h5>
      <p className="text-muted">System prompt, tools, and state will appear here.</p>
    </div>
  );
}
