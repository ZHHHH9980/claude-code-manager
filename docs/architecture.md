# Architecture

Detailed technical documentation for Claude Code Manager internals.

## Communication Patterns

Three communication channels between frontend and backend:

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Express Server
    participant P as PTY Session
    participant C as Claude CLI

    Note over B,C: 1. REST API — CRUD Operations
    B->>S: POST /api/tasks/:id/start
    S->>P: Create PTY session
    P->>C: Spawn CLI process
    S-->>B: { sessionName, status }

    Note over B,C: 2. WebSocket — Terminal Real-time I/O
    B->>S: socket.emit('terminal:attach')
    S-->>B: Replay buffer (last 40KB)
    loop Real-time
        B->>S: terminal:input (keystrokes)
        S->>P: Write to PTY stdin
        P-->>S: PTY stdout data
        S-->>B: terminal:data (output)
    end

    Note over B,C: 3. SSE — Chat Streaming
    B->>S: POST /api/tasks/:id/chat {message}
    S->>C: Send to Claude process
    loop Stream
        C-->>S: JSON chunks
        S-->>B: SSE data: {text}
    end
    S-->>B: SSE data: {done: true}
```

## Task Lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: POST /api/tasks
    pending --> in_progress: POST /api/tasks/:id/start
    in_progress --> done: POST /api/tasks/:id/stop
    in_progress --> interrupted: Server restart / error
    interrupted --> in_progress: Session recovery
    done --> [*]

    state in_progress {
        [*] --> PTY_Created
        PTY_Created --> CLI_Running: Spawn adapter
        CLI_Running --> Streaming: Terminal I/O active
        Streaming --> CLI_Running: Chat turn
    }
```

## Task Start Flow

```mermaid
flowchart LR
    A[User clicks Start] --> B[POST /api/tasks/:id/start]
    B --> C{Resolve Adapter}
    C -->|claude| D[Claude CLI config]
    C -->|codex| E[Codex CLI config]
    D & E --> F[Create PTY session]
    F --> G[Init claude-workflow in worktree]
    G --> H[Launch CLI with env vars]
    H --> I[Watch PROGRESS.md]
    H --> J[Frontend attaches via WebSocket]
    J --> K[Live terminal in browser]
```

## Adapter System

Pluggable adapter pattern for different CLI tools:

```mermaid
classDiagram
    class Adapter {
        +String cli
        +String[] models
        +String defaultModel
        +Boolean autoConfirm
        +Boolean chatMode
        +buildArgs(task)
        +buildEnv(task)
    }

    class ClaudeAdapter {
        cli = "claude"
        defaultModel = "sonnet-4.5"
        autoConfirm = true
        chatMode = true (stream-json)
    }

    class CodexAdapter {
        cli = "codex"
        defaultModel = "gpt-5.4"
        autoConfirm = false
        chatMode = false
    }

    Adapter <|-- ClaudeAdapter
    Adapter <|-- CodexAdapter
```

## Session Recovery

PTY sessions survive server restarts:

```mermaid
flowchart TB
    subgraph Shutdown["Graceful Shutdown (SIGTERM)"]
        S1[Persist PTY buffers] --> S2["Write to data/sessions/*.buf"]
    end

    subgraph Startup["Server Startup"]
        R1[Scan in_progress tasks] --> R2{PTY alive?}
        R2 -->|Yes| R3[Re-attach & watch]
        R2 -->|No| R4[Restore from buffer]
        R4 --> R5[Re-launch adapter]
    end

    Shutdown --> Startup
```

## Database Schema

```mermaid
erDiagram
    projects ||--o{ tasks : has
    tasks ||--o{ task_chat_messages : has

    projects {
        text id PK
        text name
        text repo_path
        text github_repo
        text ssh_host
        text notion_id
    }

    tasks {
        text id PK
        text title
        text status "pending | in_progress | done | interrupted"
        text project_id FK
        text branch
        text worktree_path
        text pty_session
        text model
        text mode "claude | codex"
        text chat_session_id
    }

    task_chat_messages {
        int id PK
        text task_id FK
        text role "user | assistant"
        text text
    }

    agent_chat_messages {
        int id PK
        text role
        text text
    }

    kv_store {
        text key PK
        text value
    }
```

## Project Structure

```
claude-code-manager/
├── server/
│   ├── index.js              # Express entry point, routes, socket.io
│   ├── db.js                 # SQLite (WAL mode, auto-migration)
│   ├── pty-manager.js        # PTY session lifecycle & buffer
│   ├── task-chat-runtime.js  # Claude chat with session persistence
│   ├── file-watcher.js       # PROGRESS.md → Notion sync
│   ├── notion-sync.js        # Async Notion API (non-blocking)
│   ├── claude-env.js         # Claude environment setup
│   └── adapters/
│       ├── claude.js          # Claude Code adapter
│       └── codex.js           # Codex adapter
├── client/
│   ├── src/
│   │   ├── App.jsx            # Main state management
│   │   ├── components/
│   │   │   ├── Terminal.jsx       # xterm.js + socket.io
│   │   │   ├── TaskBoard.jsx      # Task list & actions
│   │   │   ├── ProjectList.jsx    # Project CRUD
│   │   │   └── AssistantChatWindow.jsx  # SSE chat UI
│   │   ├── hooks/
│   │   │   └── useSocket.js       # Socket.io singleton
│   │   └── config.js             # API base URL
│   └── dist/                     # Built static files
├── data/
│   ├── manager.db                # SQLite database
│   └── sessions/                 # Persisted PTY buffers
├── deploy.sh                     # Remote deploy script
├── static-server.js              # Static file server :8080
└── package.json
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project + tasks |
| GET | `/api/tasks?projectId=` | List tasks for project |
| POST | `/api/tasks` | Create task |
| POST | `/api/tasks/:id/start` | Start CLI session |
| POST | `/api/tasks/:id/stop` | Stop session |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/chat` | Task-scoped chat (SSE) |
| GET | `/api/tasks/:id/chat/history` | Chat history |
| POST | `/api/agent` | Global agent chat (SSE) |
| POST | `/api/deploy` | Trigger deploy.sh |
| POST | `/api/webhook/github` | GitHub push auto-deploy |
