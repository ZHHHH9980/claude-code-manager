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
    fetch(`/api/tasks?projectId=${selectedProject.id}`)
      .then(r => r.json()).then(setTasks);
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-mono">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <span className="font-bold text-blue-400">Claude Code Manager</span>
        <button className="text-xs bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded">
          + New Task
        </button>
      </div>

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
