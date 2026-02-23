export function ProjectList({ projects, selectedId, onSelect, mobile = false }) {
  return (
    <aside className={`w-full ${mobile ? 'h-full' : 'md:w-64'} border-b md:border-b-0 md:border-r p-3 md:p-4 flex flex-col`} style={{ borderColor: 'var(--border)' }}>
      <div className="text-[11px] uppercase tracking-[0.16em] mb-3" style={{ color: 'var(--text-3)' }}>Projects</div>
      <div className={`flex-1 overflow-y-auto space-y-2 pr-1 ${mobile ? 'max-h-none' : 'max-h-40 md:max-h-none'}`}>
        {projects.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--text-3)' }}>No projects yet</div>
        )}
        {projects.map((p) => {
          const selected = selectedId === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p)}
              className="w-full text-left px-3 py-2 rounded-xl text-sm border transition"
              style={selected
                ? {
                    borderColor: 'var(--accent-2)',
                    background: 'color-mix(in srgb, var(--accent-2) 20%, var(--surface-2))',
                    color: 'var(--text-1)',
                  }
                : {
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-2)',
                  }}
            >
              <div className="font-medium truncate">{p.name}</div>
              {p.repo_path && (
                <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--text-3)' }}>
                  {p.repo_path}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
