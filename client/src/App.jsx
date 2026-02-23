import { useState, useEffect } from 'react';
import { ProjectList } from './components/ProjectList';
import { TaskBoard } from './components/TaskBoard';
import { Terminal } from './components/Terminal';
import { useSocket } from './hooks/useSocket';

export default function App() {
  const { socket } = useSocket();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [activeTmuxCmd, setActiveTmuxCmd] = useState('');
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', branch: '' });
  const [newProject, setNewProject] = useState({ name: '', repoPath: '' });
  const [deploying, setDeploying] = useState(false);

  async function handleDeploy() {
    setDeploying(true);
    try {
      await fetch('/api/deploy', { method: 'POST' });
    } catch {}
    setTimeout(() => setDeploying(false), 3000);
  }

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(setProjects);
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    fetch(`/api/tasks?projectId=${selectedProject.id}`)
      .then(r => r.json()).then(setTasks);
  }, [selectedProject]);

  async function handleStartTask(task, mode) {
    const res = await fetch(`/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreePath: task.worktree_path || selectedProject.repo_path,
        branch: task.branch || 'main',
        model: task.model,
        mode: mode || 'claude',
      }),
    });
    const { sessionName, tmuxCmd } = await res.json();
    setActiveSession(sessionName);
    setActiveTmuxCmd(tmuxCmd);
    refreshTasks();
  }

  function refreshTasks() {
    if (!selectedProject) return;
    fetch(`/api/tasks?projectId=${selectedProject.id}`)
      .then(r => r.json()).then(setTasks);
  }

  async function handleCreateTask(e) {
    e.preventDefault();
    if (!selectedProject || !newTask.title) return;
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newTask, projectId: selectedProject.id }),
    });
    setNewTask({ title: '', branch: '' });
    setShowNewTask(false);
    refreshTasks();
  }

  async function handleCreateProject(e) {
    e.preventDefault();
    if (!newProject.name) return;
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProject),
    });
    const project = await res.json();
    setProjects(prev => [...prev, project]);
    setSelectedProject(project);
    setNewProject({ name: '', repoPath: '' });
    setShowNewProject(false);
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-mono">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <span className="font-bold text-blue-400">Claude Code Manager</span>
        <div className="flex gap-2">
          <button
            onClick={handleDeploy}
            disabled={deploying}
            className={`text-xs px-3 py-1 rounded ${deploying ? 'bg-yellow-700 text-yellow-300' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            {deploying ? 'Syncing...' : 'Sync'}
          </button>
          <button
            onClick={() => setShowNewProject(true)}
            className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded"
          >
            + Project
          </button>
          <button
            onClick={() => selectedProject && setShowNewTask(true)}
            className={`text-xs px-3 py-1 rounded ${selectedProject ? 'bg-blue-700 hover:bg-blue-600' : 'bg-gray-700 text-gray-500 cursor-not-allowed'}`}
          >
            + Task
          </button>
        </div>
      </div>

      {showNewProject && (
        <form onSubmit={handleCreateProject} className="flex gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
          <input
            placeholder="Project name"
            value={newProject.name}
            onChange={e => setNewProject(p => ({ ...p, name: e.target.value }))}
            className="text-sm bg-gray-700 px-2 py-1 rounded flex-1"
            autoFocus
          />
          <input
            placeholder="Repo path (e.g. /opt/myrepo)"
            value={newProject.repoPath}
            onChange={e => setNewProject(p => ({ ...p, repoPath: e.target.value }))}
            className="text-sm bg-gray-700 px-2 py-1 rounded flex-1"
          />
          <button type="submit" className="text-xs bg-green-700 hover:bg-green-600 px-3 py-1 rounded">Create</button>
          <button type="button" onClick={() => setShowNewProject(false)} className="text-xs bg-gray-600 px-3 py-1 rounded">Cancel</button>
        </form>
      )}

      {showNewTask && (
        <form onSubmit={handleCreateTask} className="flex gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700">
          <input
            placeholder="Task title"
            value={newTask.title}
            onChange={e => setNewTask(t => ({ ...t, title: e.target.value }))}
            className="text-sm bg-gray-700 px-2 py-1 rounded flex-1"
            autoFocus
          />
          <input
            placeholder="Branch (e.g. feature/xxx)"
            value={newTask.branch}
            onChange={e => setNewTask(t => ({ ...t, branch: e.target.value }))}
            className="text-sm bg-gray-700 px-2 py-1 rounded flex-1"
          />
          <button type="submit" className="text-xs bg-green-700 hover:bg-green-600 px-3 py-1 rounded">Create</button>
          <button type="button" onClick={() => setShowNewTask(false)} className="text-xs bg-gray-600 px-3 py-1 rounded">Cancel</button>
        </form>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ProjectList
          projects={projects}
          selectedId={selectedProject?.id}
          onSelect={setSelectedProject}
        />
        <div className="flex flex-col flex-1 overflow-hidden">
          <TaskBoard
            tasks={tasks}
            onOpenTerminal={(task) => {
              setActiveSession(task.tmux_session);
              setActiveTmuxCmd(`tmux attach -t ${task.tmux_session}`);
            }}
            onStartTask={handleStartTask}
          />
          {activeSession && (
            <div className="h-64 border-t border-gray-700 flex flex-col">
              <div className="flex items-center gap-3 px-3 py-1 bg-gray-800 text-xs text-gray-400">
                <span>Terminal: {activeSession}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(activeTmuxCmd)}
                  className="ml-auto hover:text-white"
                >
                  Copy tmux cmd
                </button>
                <button
                  onClick={() => setActiveSession(null)}
                  className="hover:text-white"
                >
                  Detach
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <Terminal socket={socket} sessionName={activeSession} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
