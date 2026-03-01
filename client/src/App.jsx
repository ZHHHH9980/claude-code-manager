import { useState, useEffect } from 'react';
import { ProjectList } from './components/ProjectList';
import { TaskBoard } from './components/TaskBoard';
import { Terminal } from './components/Terminal';
import { useSocket } from './hooks/useSocket';
import { API_BASE_URL } from './config';

const STORAGE_SELECTED_PROJECT_ID = 'ccm-selected-project-id';
const STORAGE_ACTIVE_TASK_ID = 'ccm-active-task-id';
const STORAGE_AGENT_TERMINAL_MODE = 'ccm-agent-terminal-mode';
const DEFAULT_ADAPTERS = [
  {
    name: 'claude',
    label: 'Claude Code',
    color: '#d97757',
    models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
    defaultModel: 'claude-sonnet-4-5',
    supportsChatMode: true,
  },
  {
    name: 'codex',
    label: 'Codex',
    color: '#10a37f',
    models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' }],
    defaultModel: 'gpt-5.3-codex',
    supportsChatMode: false,
  },
];

function modeBadge(name, label) {
  if (name === 'claude') return 'CC';
  if (name === 'codex') return 'CX';
  const words = String(label || name || '')
    .split(/[\s_-]+/)
    .filter(Boolean);
  const badge = words.map((item) => item[0]).join('').slice(0, 2).toUpperCase();
  return badge || String(name || 'AG').slice(0, 2).toUpperCase();
}

function normalizeAdapter(adapter) {
  if (!adapter || !adapter.name) return null;
  return {
    name: String(adapter.name).toLowerCase(),
    label: adapter.label || adapter.name,
    color: adapter.color || '#64748b',
    models: Array.isArray(adapter.models) ? adapter.models : [],
    defaultModel: adapter.defaultModel || null,
    supportsChatMode: Boolean(adapter.supportsChatMode),
  };
}

function isValidAgentMode(mode, adapters) {
  return adapters.some((item) => item.name === mode);
}

function getAgentModeMeta(mode, adapters) {
  return adapters.find((item) => item.name === mode) || adapters[0] || DEFAULT_ADAPTERS[0];
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [selectedProject, setSelectedProject] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [activeTaskTitle, setActiveTaskTitle] = useState('');
  const [activeTaskMode, setActiveTaskMode] = useState('');
  const [isTaskTerminalOpen, setIsTaskTerminalOpen] = useState(false);

  const { socket } = useSocket();
  const [agentTerminalSession, setAgentTerminalSession] = useState(null);
  const [agentTerminalReady, setAgentTerminalReady] = useState(false);
  const [adapters, setAdapters] = useState(DEFAULT_ADAPTERS);
  const [agentTerminalMode, setAgentTerminalMode] = useState(() => {
    const saved = localStorage.getItem(STORAGE_AGENT_TERMINAL_MODE);
    return saved || 'claude';
  });
  const [agentTerminalError, setAgentTerminalError] = useState('');

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
    localStorage.setItem(STORAGE_AGENT_TERMINAL_MODE, agentTerminalMode);
  }, [agentTerminalMode]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/projects`).then((r) => r.json()).then(setProjects);
  }, []);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/adapters`)
      .then((r) => r.json())
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return;
        const normalized = rows.map(normalizeAdapter).filter(Boolean);
        if (normalized.length > 0) setAdapters(normalized);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isValidAgentMode(agentTerminalMode, adapters)) return;
    setAgentTerminalMode((adapters[0] || DEFAULT_ADAPTERS[0]).name);
  }, [agentTerminalMode, adapters]);

  useEffect(() => {
    if (selectedProject) return;
    if (projects.length === 0) return;
    const savedId = localStorage.getItem(STORAGE_SELECTED_PROJECT_ID);
    if (!savedId) {
      setSelectedProject(projects[0] || null);
      return;
    }
    const restored = projects.find((p) => String(p.id) === String(savedId));
    setSelectedProject(restored || projects[0] || null);
  }, [projects, selectedProject]);

  useEffect(() => {
    if (!selectedProject) {
      setTasks([]);
      setTasksLoaded(false);
      return;
    }
    setTasksLoaded(false);
    localStorage.setItem(STORAGE_SELECTED_PROJECT_ID, String(selectedProject.id));
    fetch(`${API_BASE_URL}/api/tasks?projectId=${selectedProject.id}`)
      .then((r) => r.json())
      .then((rows) => {
        setTasks(Array.isArray(rows) ? rows : []);
        setTasksLoaded(true);
      })
      .catch(() => {
        setTasks([]);
        setTasksLoaded(true);
      });
  }, [selectedProject]);

  useEffect(() => {
    if (!activeTaskId || !isTaskTerminalOpen) {
      localStorage.removeItem(STORAGE_ACTIVE_TASK_ID);
      return;
    }
    localStorage.setItem(STORAGE_ACTIVE_TASK_ID, String(activeTaskId));
  }, [activeTaskId, isTaskTerminalOpen]);

  useEffect(() => {
    if (!selectedProject || activeTaskId || !tasksLoaded) return;
    const savedTaskId = localStorage.getItem(STORAGE_ACTIVE_TASK_ID);
    if (!savedTaskId) return;
    const savedTask = tasks.find((task) => String(task.id) === String(savedTaskId));
    if (!savedTask || !savedTask.pty_session) return;
    setActiveSession(savedTask.pty_session);
    setActiveTaskId(savedTask.id);
    setActiveTaskTitle(savedTask.title || savedTask.pty_session);
    setActiveTaskMode(savedTask.mode || '');
    setIsTaskTerminalOpen(true);
  }, [selectedProject, tasks, activeTaskId, tasksLoaded]);

  function clearActiveTaskChat() {
    localStorage.removeItem(STORAGE_ACTIVE_TASK_ID);
    setActiveSession(null);
    setActiveTaskId(null);
    setActiveTaskTitle('');
    setActiveTaskMode('');
    setIsTaskTerminalOpen(false);
  }

  function closeTaskTerminalModal() {
    setIsTaskTerminalOpen(false);
  }

  function refreshAll() {
    fetch(`${API_BASE_URL}/api/projects`).then((r) => r.json()).then(setProjects);
    if (selectedProject) {
      fetch(`${API_BASE_URL}/api/tasks?projectId=${selectedProject.id}`).then((r) => r.json()).then(setTasks);
    }
  }

  async function handleStartTask(task, mode) {
    const requestedMode = mode || (adapters[0] || DEFAULT_ADAPTERS[0]).name;
    const requestedLabel = adapters.find((item) => item.name === requestedMode)?.label || requestedMode;
    const res = await fetch(`${API_BASE_URL}/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreePath: task.worktree_path || selectedProject?.repo_path,
        branch: task.branch || 'main',
        model: task.model,
        mode: requestedMode,
      }),
    });
    let payload = {};
    try { payload = await res.json(); } catch {}
    if (!res.ok || payload?.ptyOk === false || !payload?.sessionName) {
      window.alert(`Failed to start ${requestedLabel}: ${payload?.error || 'unknown error'}`);
      refreshAll();
      return;
    }
    const { sessionName } = payload;
    localStorage.setItem(STORAGE_ACTIVE_TASK_ID, String(task.id));
    setActiveSession(sessionName);
    setActiveTaskId(task.id);
    setActiveTaskTitle(task.title || sessionName);
    setActiveTaskMode(requestedMode || '');
    setIsTaskTerminalOpen(true);
    refreshAll();
  }

  function handleOpenTask(task) {
    if (!task?.pty_session) return;
    localStorage.setItem(STORAGE_ACTIVE_TASK_ID, String(task.id));
    setActiveSession(task.pty_session);
    setActiveTaskId(task.id);
    setActiveTaskTitle(task.title || task.pty_session);
    setActiveTaskMode(task.mode || '');
    setIsTaskTerminalOpen(true);
  }

  async function handleDeleteTask(task) {
    if (!task?.id) return;
    const yes = window.confirm(`Delete task "${task.title}"? This will stop its runtime and remove chat history.`);
    if (!yes) return;
    await fetch(`${API_BASE_URL}/api/tasks/${task.id}`, { method: 'DELETE' });
    if (String(activeTaskId) === String(task.id)) clearActiveTaskChat();
    refreshAll();
  }

  async function handleCreateTask({ title }) {
    if (!selectedProject || !title) return;
    await fetch(`${API_BASE_URL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, projectId: selectedProject.id, branch: 'main' }),
    });
    refreshAll();
  }

  async function startMainAgentTerminal(mode = agentTerminalMode, { suppressError = false } = {}) {
    const safeMode = isValidAgentMode(mode, adapters) ? mode : (adapters[0] || DEFAULT_ADAPTERS[0]).name;
    setAgentTerminalReady(false);
    if (!suppressError) setAgentTerminalError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/agent/terminal/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: safeMode }),
      });
      const payload = await res.json();
      if (!res.ok || payload?.ptyOk === false || !payload?.sessionName) {
        throw new Error(payload?.error || `failed to start ${safeMode}`);
      }
      setAgentTerminalSession(payload.sessionName);
      setAgentTerminalMode(isValidAgentMode(payload.mode, adapters) ? payload.mode : safeMode);
      return true;
    } catch (err) {
      setAgentTerminalSession(null);
      if (!suppressError) {
        setAgentTerminalError(err?.message || `failed to start ${safeMode}`);
      }
      return false;
    } finally {
      setAgentTerminalReady(true);
    }
  }

  async function restartMainAgentTerminal() {
    setAgentTerminalReady(false);
    setAgentTerminalError('');
    try { await fetch(`${API_BASE_URL}/api/agent/terminal/stop`, { method: 'POST' }); } catch {}
    await startMainAgentTerminal(agentTerminalMode);
  }

  async function switchMainAgentTerminal(nextMode) {
    if (!isValidAgentMode(nextMode, adapters) || nextMode === agentTerminalMode) return;
    const prevMode = agentTerminalMode;

    setAgentTerminalReady(false);
    setAgentTerminalError('');
    try { await fetch(`${API_BASE_URL}/api/agent/terminal/stop`, { method: 'POST' }); } catch {}

    const switched = await startMainAgentTerminal(nextMode, { suppressError: true });
    if (switched) return;

    const rolledBack = await startMainAgentTerminal(prevMode, { suppressError: true });
    if (rolledBack) {
      setAgentTerminalError(`Failed to start ${nextMode}, reverted to ${prevMode}.`);
    } else {
      setAgentTerminalError(`Failed to start ${nextMode}, and rollback to ${prevMode} also failed.`);
    }
  }

  useEffect(() => {
    if (!activeSession || !activeTaskId || !tasksLoaded) return;
    const currentTask = tasks.find((task) => String(task.id) === String(activeTaskId));
    if (!currentTask || currentTask.status === 'done' || currentTask.status === 'interrupted') {
      clearActiveTaskChat();
    }
  }, [tasks, activeSession, activeTaskId, tasksLoaded]);

  useEffect(() => {
    startMainAgentTerminal(agentTerminalMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentAgentMode = getAgentModeMeta(agentTerminalMode, adapters);

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
    <div className="flex flex-col border-t h-full min-h-0 overflow-hidden" style={{ borderColor: 'var(--border)', minHeight: isMobile ? '0' : '250px', height: isMobile ? '100%' : '40%' }}>
      <div className="px-4 py-2 text-xs border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="inline-flex items-center justify-center w-5 h-5 rounded-md text-[10px] font-semibold shrink-0"
            style={{ background: currentAgentMode.color, color: '#fff' }}
          >
            {modeBadge(currentAgentMode.name, currentAgentMode.label)}
          </span>
          <span className="truncate">CCM Agent Terminal</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={agentTerminalMode}
            onChange={(e) => switchMainAgentTerminal(e.target.value)}
            className="ccm-button ccm-button-soft text-xs px-2 py-0.5"
            aria-label="Switch agent terminal adapter"
          >
            {adapters.map((item) => (
              <option key={item.name} value={item.name}>{item.label}</option>
            ))}
          </select>
          <button type="button" onClick={restartMainAgentTerminal} className="ccm-button ccm-button-soft text-xs px-2 py-0.5">Restart</button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {agentTerminalReady && agentTerminalSession && socket ? (
          <Terminal socket={socket} sessionName={agentTerminalSession} />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>
            {agentTerminalError || 'Starting agent terminal...'}
          </div>
        )}
      </div>
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
                <TaskBoard tasks={tasks} adapters={adapters} onOpenTerminal={handleOpenTask} onStartTask={handleStartTask} onDeleteTask={handleDeleteTask} onCreateTask={handleCreateTask} mobile />
              )}
              {mobilePane === 'chat' && mainChatPanel}
            </div>
          </div>
        ) : (
          <>
            <ProjectList projects={projects} selectedId={selectedProject?.id} onSelect={setSelectedProject} />
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <TaskBoard tasks={tasks} adapters={adapters} onOpenTerminal={handleOpenTask} onStartTask={handleStartTask} onDeleteTask={handleDeleteTask} onCreateTask={handleCreateTask} />
              {mainChatPanel}
            </div>
          </>
        )}
      </div>

      {activeSession && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 transition-opacity ${isTaskTerminalOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
          style={{ background: 'rgba(0, 0, 0, 0.58)' }}
          aria-hidden={!isTaskTerminalOpen}
        >
          <div className="w-full h-[100dvh] sm:h-[82vh] sm:max-w-5xl rounded-none sm:rounded-2xl flex flex-col overflow-hidden ccm-panel">
            <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b text-xs" style={{ borderColor: 'var(--border)' }}>
              <span className="font-semibold shrink-0">Task Terminal</span>
              <span style={{ color: 'var(--text-3)' }} className="hidden sm:inline">|</span>
              <span className="truncate">{activeTaskTitle}</span>
              <span style={{ color: 'var(--text-3)' }} className="hidden md:inline">({activeSession})</span>
              <button
                onClick={closeTaskTerminalModal}
                className="ml-auto ccm-button ccm-button-soft text-xs px-3 py-1.5"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0">
              <Terminal socket={socket} sessionName={activeSession} forceRedrawOnAttach={activeTaskMode !== 'codex'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
