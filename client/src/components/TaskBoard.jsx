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

export function TaskBoard({ tasks, onOpenTerminal, onStartTask, mobile = false }) {
  return (
    <section className="flex-1 p-3 md:p-4 overflow-y-auto">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-3)' }}>Tasks</div>
        <div className="text-xs" style={{ color: 'var(--text-3)' }}>{tasks.length} total</div>
      </div>

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

                {task.status === 'pending' && (
                  <div className={`flex gap-1.5 ${mobile ? 'w-full' : ''}`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartTask(task, 'claude');
                      }}
                      className={`ccm-button text-xs px-2.5 py-1.5 ${mobile ? 'flex-1' : ''}`}
                      style={{
                        color: '#fff',
                        background: 'linear-gradient(135deg, var(--accent-2), color-mix(in srgb, var(--accent-2) 75%, #fff 25%))',
                      }}
                    >
                      Claude
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartTask(task, 'ralph');
                      }}
                      className={`ccm-button text-xs px-2.5 py-1.5 ${mobile ? 'flex-1' : ''}`}
                      style={{
                        color: '#fff',
                        background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff 30%))',
                      }}
                    >
                      Ralph
                    </button>
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
