import { useState } from 'react';

export function ProjectList({ projects, selectedId, onSelect, onCreateProject, mobile = false }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const projectName = name.trim();
    if (!projectName || typeof onCreateProject !== 'function') return;
    onCreateProject({ name: projectName, repoPath: repoPath.trim() });
    setName('');
    setRepoPath('');
    setShowForm(false);
  }

  return (
    <aside className={`w-full ${mobile ? 'h-full' : 'md:w-64'} border-b md:border-b-0 md:border-r p-3 md:p-4 flex flex-col`} style={{ borderColor: 'var(--border)' }}>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-3)' }}>Projects</div>
        {typeof onCreateProject === 'function' && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="ccm-button ccm-button-accent text-xs px-2 py-1"
          >
            {showForm ? '×' : '+'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-3 space-y-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name..."
            className="w-full text-sm px-3 py-2 rounded-lg border outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-1)' }}
          />
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="Repo path (optional)"
            className="w-full text-xs px-3 py-2 rounded-lg border outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }}
          />
          <button type="submit" className="ccm-button ccm-button-accent text-xs px-3 py-1.5 w-full">
            Create
          </button>
        </form>
      )}

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
