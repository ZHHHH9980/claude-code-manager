import { useState, useEffect, useRef } from 'react';
import { ProjectList } from './components/ProjectList';
import { TaskBoard } from './components/TaskBoard';
import { Terminal } from './components/Terminal';
import { useSocket } from './hooks/useSocket';
import { chat as agentChat } from './agent';

export default function App() {
  const { socket } = useSocket();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [activeTmuxCmd, setActiveTmuxCmd] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [agentMessages, setAgentMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('poe_api_key') || '');
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(setProjects);
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    fetch(`/api/tasks?projectId=${selectedProject.id}`)
      .then(r => r.json()).then(setTasks);
  }, [selectedProject]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  function refreshAll() {
    fetch('/api/projects').then(r => r.json()).then(setProjects);
    if (selectedProject) {
      fetch(`/api/tasks?projectId=${selectedProject.id}`)
        .then(r => r.json()).then(setTasks);
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
    const { sessionName, tmuxCmd } = await res.json();
    setActiveSession(sessionName);
    setActiveTmuxCmd(tmuxCmd);
    refreshAll();
  }

  function saveApiKey(key) {
    setApiKey(key);
    localStorage.setItem('poe_api_key', key);
  }

  async function handleChat(e) {
    e.preventDefault();
    if (!chatInput.trim() || loading) return;
    if (!apiKey) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: 'Please set your Poe API key first (click the key icon).' }]);
      return;
    }
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    try {
      const msgs = [...agentMessages, { role: 'user', content: userMsg }];
      const data = await agentChat(msgs, apiKey);
      setChatMessages(prev => [...prev, { role: 'assistant', text: data.text }]);
      setAgentMessages(data.messages);
      if (data.startAction) {
        const task = tasks.find(t => t.id === data.startAction.taskId);
        if (task) handleStartTask(task, data.startAction.mode);
      }
      refreshAll();
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err.message}` }]);
    }
    setLoading(false);
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-mono">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <span className="font-bold text-blue-400">Claude Code Manager</span>
        <div className="flex items-center gap-2">
          {!apiKey ? (
            <input
              placeholder="Poe API Key"
              onKeyDown={e => e.key === 'Enter' && saveApiKey(e.target.value)}
              onBlur={e => e.target.value && saveApiKey(e.target.value)}
              className="text-xs bg-gray-800 px-2 py-1 rounded w-48"
            />
          ) : (
            <button onClick={() => saveApiKey('')} className="text-xs text-gray-500 hover:text-white">Key: ...{apiKey.slice(-6)}</button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <ProjectList projects={projects} selectedId={selectedProject?.id} onSelect={setSelectedProject} />
        <div className="flex flex-col flex-1 overflow-hidden">
          <TaskBoard
            tasks={tasks}
            onOpenTerminal={(task) => { setActiveSession(task.tmux_session); setActiveTmuxCmd(`tmux attach -t ${task.tmux_session}`); }}
            onStartTask={handleStartTask}
          />

          {activeSession && (
            <div className="h-64 border-t border-gray-700 flex flex-col">
              <div className="flex items-center gap-3 px-3 py-1 bg-gray-800 text-xs text-gray-400">
                <span>Terminal: {activeSession}</span>
                <button onClick={() => navigator.clipboard.writeText(activeTmuxCmd)} className="ml-auto hover:text-white">Copy tmux cmd</button>
                <button onClick={() => setActiveSession(null)} className="hover:text-white">Detach</button>
              </div>
              <div className="flex-1 overflow-hidden">
                <Terminal socket={socket} sessionName={activeSession} />
              </div>
            </div>
          )}

          <div className="border-t border-gray-700 flex flex-col" style={{ height: '200px' }}>
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
              {chatMessages.length === 0 && (
                <div className="text-gray-500 text-xs">Tell me what you want to do. e.g. "给 CCM 加个任务：优化终端体验"</div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-blue-300' : 'text-gray-300'}`}>
                  <span className="text-xs text-gray-500 mr-2">{msg.role === 'user' ? '>' : 'CCM'}</span>
                  {msg.text}
                </div>
              ))}
              {loading && <div className="text-xs text-yellow-400">thinking...</div>}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleChat} className="flex gap-2 px-3 py-2 border-t border-gray-800">
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Tell CCM what to do..."
                className="flex-1 bg-gray-800 text-sm px-3 py-1.5 rounded outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
              <button type="submit" disabled={loading} className="text-xs bg-blue-700 hover:bg-blue-600 px-4 py-1.5 rounded disabled:opacity-50">Send</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
