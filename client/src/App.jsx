import { useState, useEffect, useRef } from 'react';
import { ProjectList } from './components/ProjectList';
import { TaskBoard } from './components/TaskBoard';
import { ChatWindow } from './components/ChatWindow';
import { useSocket } from './hooks/useSocket';

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

export default function App() {
  const { socket } = useSocket();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [activeTaskTitle, setActiveTaskTitle] = useState('');

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef(null);
  const chatAbortRef = useRef(null);

  const [taskChatInput, setTaskChatInput] = useState('');
  const [taskChatMessages, setTaskChatMessages] = useState([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const taskChatEndRef = useRef(null);
  const taskIdleTimerRef = useRef(null);

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
    fetch('/api/projects').then((r) => r.json()).then(setProjects);
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    fetch(`/api/tasks?projectId=${selectedProject.id}`).then((r) => r.json()).then(setTasks);
  }, [selectedProject]);

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
    setActiveTaskTitle(task.title || sessionName);
    refreshAll();
  }

  function handleOpenTask(task) {
    if (!task?.tmux_session) return;
    setActiveSession(task.tmux_session);
    setActiveTaskTitle(task.title || task.tmux_session);
  }

  async function handleMainChatSubmit(e) {
    e.preventDefault();
    if (!chatInput.trim() || loading) return;

    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }, { role: 'assistant', text: '' }]);
    setLoading(true);

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
              setChatMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') last.text += event.text;
                return updated;
              });
            }
            if (event.done) refreshAll();
          } catch {
            // ignore malformed chunks
          }
        }
      }
      refreshAll();
    } catch (err) {
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
    }
  }

  function handleTaskChatSubmit(e) {
    e.preventDefault();
    if (!socket || !activeSession || !taskChatInput.trim() || taskLoading) return;

    const msg = taskChatInput.trim();
    setTaskChatInput('');
    setTaskLoading(true);
    setTaskChatMessages((prev) => [...prev, { role: 'user', text: msg }, { role: 'assistant', text: '' }]);
    socket.emit('terminal:input', `${msg}\n`);
  }

  useEffect(() => {
    if (!socket || !activeSession) return;

    setTaskChatInput('');
    setTaskLoading(false);
    setTaskChatMessages([
      {
        role: 'assistant',
        text: `Connected to ${activeTaskTitle || activeSession}. You can chat with this task now.`,
      },
    ]);

    socket.emit('terminal:attach', activeSession);

    const onData = (chunk) => {
      const text = stripAnsi(String(chunk || ''));
      if (!text) return;
      setTaskLoading(true);
      if (taskIdleTimerRef.current) clearTimeout(taskIdleTimerRef.current);
      taskIdleTimerRef.current = setTimeout(() => setTaskLoading(false), 450);

      setTaskChatMessages((prev) => {
        if (prev.length === 0) return [{ role: 'assistant', text }];
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') last.text += text;
        else updated.push({ role: 'assistant', text });
        return updated;
      });
    };

    const onError = (msg) => {
      setTaskLoading(false);
      setTaskChatMessages((prev) => [...prev, { role: 'assistant', text: `Error: ${msg}` }]);
    };

    socket.on('terminal:data', onData);
    socket.on('terminal:error', onError);

    return () => {
      socket.off('terminal:data', onData);
      socket.off('terminal:error', onError);
      if (taskIdleTimerRef.current) {
        clearTimeout(taskIdleTimerRef.current);
        taskIdleTimerRef.current = null;
      }
      setTaskLoading(false);
    };
  }, [socket, activeSession, activeTaskTitle]);

  useEffect(() => {
    return () => {
      if (chatAbortRef.current) chatAbortRef.current.abort();
      if (taskIdleTimerRef.current) clearTimeout(taskIdleTimerRef.current);
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
      <ChatWindow
        title="CCM Agent Chat"
        statusText={loading ? 'Thinking...' : 'Idle'}
        messages={chatMessages}
        inputValue={chatInput}
        onInputChange={setChatInput}
        onSubmit={handleMainChatSubmit}
        placeholder="Tell CCM what to do..."
        sendLabel="Send"
        loading={loading}
        endRef={chatEndRef}
      />
    </div>
  );

  return (
    <div className="ccm-shell p-3 md:p-5">
      <div className="ccm-panel rounded-2xl flex items-start md:items-center justify-between gap-3 px-4 py-3 mb-3 md:mb-4">
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

      <div className="ccm-panel rounded-2xl flex flex-col md:flex-row overflow-hidden h-[calc(100dvh-108px)] min-h-[560px] md:min-h-[660px]">
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
            <div className="flex flex-col flex-1 min-w-0">
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
                onClick={() => setActiveSession(null)}
                className="ml-auto ccm-button ccm-button-soft text-xs px-3 py-1.5"
              >
                Close
              </button>
            </div>

            <ChatWindow
              title="Sub Claude Chat"
              statusText={taskLoading ? 'Streaming...' : 'Attached'}
              messages={taskChatMessages}
              inputValue={taskChatInput}
              onInputChange={setTaskChatInput}
              onSubmit={handleTaskChatSubmit}
              placeholder="Send message to this sub task..."
              sendLabel="Send"
              assistantLabel="Task"
              loading={taskLoading}
              endRef={taskChatEndRef}
              className="border-t-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
