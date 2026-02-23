import { useState, useEffect, useRef } from 'react';
import { ProjectList } from './components/ProjectList';
import { TaskBoard } from './components/TaskBoard';
import { AssistantChatWindow } from './components/AssistantChatWindow';

function createDiagStart() {
  return {
    phase: 'sending',
    startedAt: Date.now(),
    firstTokenAt: null,
    lastTokenAt: null,
    endedAt: null,
    chunks: 0,
    error: null,
  };
}

function updateDiagOnChunk(diag) {
  const now = Date.now();
  return {
    ...diag,
    phase: diag.firstTokenAt ? 'streaming' : 'first_token',
    firstTokenAt: diag.firstTokenAt || now,
    lastTokenAt: now,
    chunks: (diag.chunks || 0) + 1,
  };
}

function finalizeDiag(diag, phase, error = null) {
  return {
    ...diag,
    phase,
    endedAt: Date.now(),
    error,
  };
}

function renderDiag(diag, nowTs) {
  if (!diag) {
    return { phase: 'idle', elapsedSec: 0, firstTokenSec: null, lastGapSec: null, chunks: 0, hint: '' };
  }
  const endTs = diag.endedAt || nowTs;
  const elapsedMs = Math.max(0, endTs - (diag.startedAt || endTs));
  const firstTokenSec = diag.firstTokenAt ? Math.round((diag.firstTokenAt - diag.startedAt) / 100) / 10 : null;
  const lastGapSec = diag.lastTokenAt ? Math.round((Math.max(0, nowTs - diag.lastTokenAt)) / 100) / 10 : null;
  let hint = '';
  if ((diag.phase === 'sending' || diag.phase === 'first_token') && !diag.firstTokenAt && elapsedMs > 8000) {
    hint = 'waiting first token: likely model queue/network/upstream latency';
  } else if (diag.phase === 'streaming' && lastGapSec != null && lastGapSec > 8) {
    hint = 'stream gap > 8s: possible model reasoning stall or network jitter';
  } else if (diag.phase === 'error') {
    hint = diag.error || 'request failed';
  }
  return {
    phase: diag.phase,
    elapsedSec: Math.round(elapsedMs / 100) / 10,
    firstTokenSec,
    lastGapSec,
    chunks: diag.chunks || 0,
    hint,
  };
}

function buildStatusText(diag) {
  if (!diag) return 'Thinking...';
  if (diag.phase === 'sending') return 'Sending...';
  if (diag.phase === 'first_token') return 'Waiting first token...';
  if (diag.phase === 'streaming') return 'Streaming...';
  if (diag.phase === 'error') return 'Error';
  return 'Thinking...';
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [activeTaskTitle, setActiveTaskTitle] = useState('');

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chatDiag, setChatDiag] = useState(null);
  const chatEndRef = useRef(null);
  const chatAbortRef = useRef(null);

  const [taskChatInput, setTaskChatInput] = useState('');
  const [taskChatMessages, setTaskChatMessages] = useState([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskChatDiag, setTaskChatDiag] = useState(null);
  const taskChatEndRef = useRef(null);
  const taskAbortRef = useRef(null);
  const [nowTs, setNowTs] = useState(Date.now());

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('ccm-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [isMobile, setIsMobile] = useState(() => window.matchMedia?.('(max-width: 767px)').matches ?? false);
  const [mobilePane, setMobilePane] = useState('tasks');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ccm-theme', theme);
  }, [theme]);

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch('/api/projects').then((r) => r.json()).then(setProjects);
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    fetch(`/api/tasks?projectId=${selectedProject.id}`).then((r) => r.json()).then(setTasks);
  }, [selectedProject]);

  function closeActiveTaskChat() {
    if (taskAbortRef.current) taskAbortRef.current.abort();
    setActiveSession(null);
    setActiveTaskId(null);
    setActiveTaskTitle('');
    setTaskChatInput('');
    setTaskLoading(false);
    setTaskChatDiag(null);
    setTaskChatMessages([]);
  }

  function refreshAll() {
    fetch('/api/projects').then((r) => r.json()).then(setProjects);
    if (selectedProject) {
      fetch(`/api/tasks?projectId=${selectedProject.id}`).then((r) => r.json()).then(setTasks);
    }
  }

  async function handleStartTask(task, mode) {
    const res = await fetch(`/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreePath: task.worktree_path || selectedProject?.repo_path,
        branch: task.branch || 'main',
        model: task.model,
        mode: mode || 'claude',
      }),
    });
    const { sessionName } = await res.json();
    setActiveSession(sessionName);
    setActiveTaskId(task.id);
    setActiveTaskTitle(task.title || sessionName);
    refreshAll();
  }

  function handleOpenTask(task) {
    if (!task?.tmux_session) return;
    setActiveSession(task.tmux_session);
    setActiveTaskId(task.id);
    setActiveTaskTitle(task.title || task.tmux_session);
  }

  function stopMainChat() {
    if (!chatAbortRef.current) return;
    chatAbortRef.current.abort();
    setChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'error', 'Stopped by user'));
  }

  function stopTaskChat() {
    if (!taskAbortRef.current) return;
    taskAbortRef.current.abort();
    setTaskChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'error', 'Stopped by user'));
  }

  async function handleMainChatSubmit(e, directMessage) {
    if (e?.preventDefault) e.preventDefault();
    const userMsg = String(directMessage ?? chatInput).trim();
    if (!userMsg || loading) return;
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }, { role: 'assistant', text: '' }]);
    setLoading(true);
    setChatDiag(createDiagStart());

    try {
      const controller = new AbortController();
      chatAbortRef.current = controller;

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          if (!chunk || chunk.startsWith(':')) continue;
          const dataLines = chunk
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;

          try {
            const event = JSON.parse(dataLines.join('\n'));
            if (event.ready) continue;
            if (event.text) {
              setChatDiag((prev) => updateDiagOnChunk(prev || createDiagStart()));
              setChatMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') last.text += event.text;
                return updated;
              });
            }
            if (event.done) {
              setChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'done'));
              refreshAll();
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
      refreshAll();
    } catch (err) {
      setChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'error', err?.message || 'request failed'));
      setChatMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const text = `Error: ${err?.message || 'request failed'}`;
        if (last?.role === 'assistant') last.text = text;
        else updated.push({ role: 'assistant', text });
        return updated;
      });
    } finally {
      chatAbortRef.current = null;
      setLoading(false);
      setChatDiag((prev) => {
        if (!prev) return prev;
        if (prev.phase === 'done' || prev.phase === 'error') return prev;
        return finalizeDiag(prev, 'done');
      });
    }
  }

  async function handleTaskChatSubmit(e, directMessage) {
    if (e?.preventDefault) e.preventDefault();
    const msg = String(directMessage ?? taskChatInput).trim();
    if (!activeSession || !activeTaskId || !msg || taskLoading) return;
    setTaskChatInput('');
    setTaskLoading(true);
    setTaskChatMessages((prev) => [...prev, { role: 'user', text: msg }, { role: 'assistant', text: '' }]);
    setTaskChatDiag(createDiagStart());

    try {
      const controller = new AbortController();
      taskAbortRef.current = controller;
      const res = await fetch(`/api/tasks/${activeTaskId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          if (!chunk || chunk.startsWith(':')) continue;
          const dataLines = chunk
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;
          try {
            const event = JSON.parse(dataLines.join('\n'));
            if (event.ready) continue;
            if (event.text) {
              setTaskChatDiag((prev) => updateDiagOnChunk(prev || createDiagStart()));
              setTaskChatMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') last.text += event.text;
                return updated;
              });
            }
            if (event.done) {
              setTaskChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'done'));
              refreshAll();
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
      refreshAll();
    } catch (err) {
      setTaskChatDiag((prev) => finalizeDiag(prev || createDiagStart(), 'error', err?.message || 'request failed'));
      setTaskChatMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const text = `Error: ${err?.message || 'request failed'}`;
        if (last?.role === 'assistant') last.text = text;
        else updated.push({ role: 'assistant', text });
        return updated;
      });
    } finally {
      taskAbortRef.current = null;
      setTaskLoading(false);
      setTaskChatDiag((prev) => {
        if (!prev) return prev;
        if (prev.phase === 'done' || prev.phase === 'error') return prev;
        return finalizeDiag(prev, 'done');
      });
    }
  }

  useEffect(() => {
    if (!activeSession || !activeTaskId) return;
    let cancelled = false;
    setTaskChatInput('');
    setTaskLoading(false);
    setTaskChatDiag(null);
    fetch(`/api/tasks/${activeTaskId}/chat/history`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const messages = Array.isArray(data?.messages)
          ? data.messages
            .filter((entry) => (entry?.role === 'user' || entry?.role === 'assistant') && String(entry?.text || '').trim())
            .map((entry) => ({ role: entry.role, text: String(entry.text) }))
          : [];
        if (messages.length > 0) {
          setTaskChatMessages(messages);
          return;
        }
        setTaskChatMessages([
          { role: 'assistant', text: `Connected to ${activeTaskTitle || activeSession}. You can chat with this task now.` },
        ]);
      })
      .catch(() => {
        if (cancelled) return;
        setTaskChatMessages([
          { role: 'assistant', text: `Connected to ${activeTaskTitle || activeSession}. You can chat with this task now.` },
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession, activeTaskTitle, activeTaskId]);

  useEffect(() => {
    if (!activeSession || !activeTaskId) return;
    const currentTask = tasks.find((task) => String(task.id) === String(activeTaskId));
    if (!currentTask || currentTask.status === 'done' || currentTask.status === 'interrupted') {
      closeActiveTaskChat();
    }
  }, [tasks, activeSession, activeTaskId]);

  useEffect(() => {
    return () => {
      if (chatAbortRef.current) chatAbortRef.current.abort();
      if (taskAbortRef.current) taskAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)');
    if (!media) return;
    const apply = () => setIsMobile(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    if (!selectedProject) setMobilePane('projects');
    else if (mobilePane === 'projects') setMobilePane('tasks');
  }, [isMobile, selectedProject, mobilePane]);

  const mainChatPanel = (
    <div style={{ minHeight: isMobile ? '0' : '250px', height: isMobile ? '100%' : '40%' }}>
      <AssistantChatWindow
        title="CCM Agent Chat"
        endpoint="/api/agent"
        placeholder="Tell CCM what to do..."
        assistantLabel="CCM"
        onAfterDone={refreshAll}
      />
    </div>
  );

  return (
    <div className="ccm-shell p-3 md:p-5 flex flex-col gap-3 md:gap-4 overflow-hidden">
      <div className="ccm-panel rounded-2xl flex items-start md:items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white font-bold text-sm" style={{ background: 'var(--accent)' }}>
            CCM
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-sm md:text-base truncate">Claude Code Manager</div>
            <div className="text-xs" style={{ color: 'var(--text-3)' }}>Task cockpit for sub-Claude sessions</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="ccm-chip text-xs hidden md:inline-flex">Agent: Claude Code</span>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="ccm-button ccm-button-soft text-xs px-3 py-2"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      <div className="ccm-panel rounded-2xl flex flex-col md:flex-row overflow-hidden flex-1 min-h-0">
        {isMobile ? (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="px-3 py-2 border-b flex items-center gap-2 overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => setMobilePane('projects')}
                className={`ccm-button text-xs px-3 py-1.5 ${mobilePane === 'projects' ? 'ccm-button-accent' : 'ccm-button-soft'}`}
              >
                Projects
              </button>
              <button
                onClick={() => setMobilePane('tasks')}
                className={`ccm-button text-xs px-3 py-1.5 ${mobilePane === 'tasks' ? 'ccm-button-accent' : 'ccm-button-soft'}`}
              >
                Tasks
              </button>
              <button
                onClick={() => setMobilePane('chat')}
                className={`ccm-button text-xs px-3 py-1.5 ${mobilePane === 'chat' ? 'ccm-button-accent' : 'ccm-button-soft'}`}
              >
                Chat
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {mobilePane === 'projects' && (
                <ProjectList projects={projects} selectedId={selectedProject?.id} onSelect={setSelectedProject} mobile />
              )}
              {mobilePane === 'tasks' && (
                <TaskBoard tasks={tasks} onOpenTerminal={handleOpenTask} onStartTask={handleStartTask} mobile />
              )}
              {mobilePane === 'chat' && mainChatPanel}
            </div>
          </div>
        ) : (
          <>
            <ProjectList projects={projects} selectedId={selectedProject?.id} onSelect={setSelectedProject} />
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <TaskBoard tasks={tasks} onOpenTerminal={handleOpenTask} onStartTask={handleStartTask} />
              {mainChatPanel}
            </div>
          </>
        )}
      </div>

      {activeSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4" style={{ background: 'rgba(0, 0, 0, 0.58)' }}>
          <div className="w-full h-[100dvh] sm:h-[82vh] sm:max-w-5xl rounded-none sm:rounded-2xl flex flex-col overflow-hidden ccm-panel">
            <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b text-xs" style={{ borderColor: 'var(--border)' }}>
              <span className="font-semibold shrink-0">Task Session Chat</span>
              <span style={{ color: 'var(--text-3)' }} className="hidden sm:inline">|</span>
              <span className="truncate">{activeTaskTitle}</span>
              <span style={{ color: 'var(--text-3)' }} className="hidden md:inline">({activeSession})</span>
              <button
                onClick={closeActiveTaskChat}
                className="ml-auto ccm-button ccm-button-soft text-xs px-3 py-1.5"
              >
                Close
              </button>
            </div>

            <AssistantChatWindow
              title="Sub Claude Chat"
              endpoint={`/api/tasks/${activeTaskId}/chat`}
              placeholder="Send message to this sub task..."
              assistantLabel="Task"
              onAfterDone={refreshAll}
              className="border-t-0 flex-1 min-h-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
