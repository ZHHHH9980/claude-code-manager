import { useState } from 'react';

const STATUS_STYLE = {
  pending: { color: 'var(--warn)', label: 'pending' },
  in_progress: { color: 'var(--accent-2)', label: 'in progress' },
  done: { color: 'var(--ok)', label: 'done' },
  failed: { color: 'var(--danger)', label: 'failed' },
  interrupted: { color: 'var(--warn)', label: 'interrupted' },
};

function statusStyle(status) {
  return STATUS_STYLE[status] || { color: 'var(--text-3)', label: status || 'unknown' };
}

function modeBadge(name, label) {
  if (name === 'claude') return 'CC';
  if (name === 'codex') return 'CX';
  const words = String(label || name || '')
    .split(/[\s_-]+/)
    .filter(Boolean);
  const badge = words.map((item) => item[0]).join('').slice(0, 2).toUpperCase();
  return badge || String(name || 'AG').slice(0, 2).toUpperCase();
}

export function TaskBoard({ tasks, adapters = [], onOpenTerminal, onStartTask, onDeleteTask, onCreateTask, mobile = false }) {
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const availableAdapters = adapters.length > 0 ? adapters : [
    { name: 'claude', label: 'Claude Code', color: '#d97757' },
    { name: 'codex', label: 'Codex', color: '#10a37f' },
  ];
  const adapterMap = new Map(availableAdapters.map((adapter) => [String(adapter.name).toLowerCase(), adapter]));

  function handleSubmit(e) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || !onCreateTask) return;
    onCreateTask({ title });
    setNewTitle('');
    setShowForm(false);
  }

  return (
    <section className="flex-1 p-3 md:p-4 overflow-y-auto">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-3)' }}>Tasks</div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>{tasks.length} total</span>
          {onCreateTask && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="ccm-button ccm-button-accent text-xs px-2 py-1"
            >
              {showForm ? '×' : '+'}
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-3 flex gap-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Task title..."
            className="flex-1 text-sm px-3 py-2 rounded-lg border outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-1)' }}
          />
          <button type="submit" className="ccm-button ccm-button-accent text-xs px-3 py-2">
            Create
          </button>
        </form>
      )}

      <div className="space-y-2.5">
        {tasks.length === 0 && (
          <div className="rounded-xl border px-3 py-4 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-3)', background: 'var(--surface-2)' }}>
            Select a project to view tasks.
          </div>
        )}

        {tasks.map((task) => {
          const st = statusStyle(task.status);
          return (
            <article
              key={task.id}
              onClick={() => task.status === 'in_progress' && onOpenTerminal(task)}
              className={`rounded-xl border px-3 py-2.5 transition ${task.status === 'in_progress' ? 'cursor-pointer' : ''}`}
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-2)',
              }}
            >
              <div className={`flex gap-3 ${mobile ? 'flex-col items-start' : 'items-center'}`}>
                <span
                  className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full border"
                  style={{
                    color: st.color,
                    borderColor: 'color-mix(in srgb, var(--border) 70%, transparent)',
                    background: 'color-mix(in srgb, var(--surface-3) 78%, transparent)',
                  }}
                >
                  {st.label}
                </span>

                <span className="flex-1 text-sm font-medium break-words md:truncate w-full" style={{ color: 'var(--text-1)' }}>{task.title}</span>

                <span className={`text-xs truncate ${mobile ? 'max-w-full' : 'max-w-36'}`} style={{ color: 'var(--text-3)' }}>{task.branch || '-'}</span>

                {task.status === 'in_progress' && (
                  (() => {
                    const current = adapterMap.get(String(task.mode || '').toLowerCase());
                    const modeName = String(task.mode || '').toLowerCase();
                    const label = current?.label || (modeName || 'unknown');
                    const color = current?.color || '#64748b';
                    return (
                      <span
                        className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full"
                        style={{ color: '#fff', background: color }}
                        title={`Adapter: ${label}`}
                      >
                        {modeBadge(modeName, label)}
                      </span>
                    );
                  })()
                )}

                {task.status === 'in_progress' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTerminal(task);
                    }}
                    className={`ccm-button ccm-button-accent text-xs px-2.5 py-1.5 ${mobile ? 'w-full' : ''}`}
                  >
                    Chat
                  </button>
                )}

                {typeof onDeleteTask === 'function' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteTask(task);
                    }}
                    className={`ccm-button ccm-button-soft text-xs px-2.5 py-1.5 ${mobile ? 'w-full' : ''}`}
                    style={{ color: 'var(--danger)' }}
                  >
                    Delete
                  </button>
                )}

                {task.status === 'pending' && (
                  <div className={`flex gap-1.5 ${mobile ? 'w-full' : ''}`}>
                    {availableAdapters.map((adapter) => (
                      <button
                        key={adapter.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartTask(task, adapter.name);
                        }}
                        className={`ccm-button text-xs px-2.5 py-1.5 ${mobile ? 'flex-1' : ''}`}
                        style={{
                          color: '#fff',
                          background: `linear-gradient(135deg, ${adapter.color || '#64748b'}, color-mix(in srgb, ${adapter.color || '#64748b'} 72%, #fff 28%))`,
                        }}
                      >
                        {adapter.label || adapter.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
