const STATUS_COLORS = {
  pending: 'text-gray-400',
  in_progress: 'text-blue-400',
  done: 'text-green-400',
  failed: 'text-red-400',
  interrupted: 'text-yellow-400',
};

export function TaskBoard({ tasks, onOpenTerminal, onStartTask }) {
  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <div className="flex flex-col gap-2">
        {tasks.map(task => (
          <div key={task.id} className="flex items-center gap-3 bg-gray-800 rounded px-3 py-2">
            <span className={`text-xs font-mono ${STATUS_COLORS[task.status] ?? 'text-gray-400'}`}>
              {task.status}
            </span>
            <span className="flex-1 text-sm text-white">{task.title}</span>
            <span className="text-xs text-gray-500">{task.branch}</span>
            {task.status === 'in_progress' && (
              <button
                onClick={() => onOpenTerminal(task)}
                className="text-xs bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded"
              >
                Open
              </button>
            )}
            {task.status === 'pending' && (
              <button
                onClick={() => onStartTask(task)}
                className="text-xs bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded"
              >
                Start
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
