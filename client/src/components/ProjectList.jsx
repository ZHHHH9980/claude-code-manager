import { useState } from 'react';

export function ProjectList({
  projects,
  selectedId,
  onSelect,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  mobile = false,
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editRepoPath, setEditRepoPath] = useState('');
  const [editGithubRepo, setEditGithubRepo] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    const projectName = name.trim();
    if (!projectName || typeof onCreateProject !== 'function') return;
    const ok = await onCreateProject({
      name: projectName,
      repoPath: repoPath.trim(),
      githubRepo: githubRepo.trim(),
    });
    if (!ok) return;
    setName('');
    setRepoPath('');
    setGithubRepo('');
    setShowForm(false);
  }

  function startEditing(project) {
    setDeleteConfirmId(null);
    setDeleteConfirmName('');
    setEditingId(project.id);
    setEditName(project.name || '');
    setEditRepoPath(project.repo_path || '');
    setEditGithubRepo(project.github_repo || '');
  }

  function stopEditing() {
    setEditingId(null);
    setEditName('');
    setEditRepoPath('');
    setEditGithubRepo('');
  }

  function startDeleteConfirm(project) {
    stopEditing();
    setDeleteConfirmId(project.id);
    setDeleteConfirmName('');
  }

  function cancelDeleteConfirm() {
    setDeleteConfirmId(null);
    setDeleteConfirmName('');
  }

  async function handleUpdateSubmit(e, projectId) {
    e.preventDefault();
    const projectName = editName.trim();
    if (!projectName || typeof onUpdateProject !== 'function') return;
    const ok = await onUpdateProject(projectId, {
      name: projectName,
      repoPath: editRepoPath.trim(),
      githubRepo: editGithubRepo.trim(),
    });
    if (!ok) return;
    stopEditing();
  }

  async function handleDeleteSubmit(e, project) {
    e.preventDefault();
    if (typeof onDeleteProject !== 'function') return;
    if (deleteConfirmName.trim() !== String(project.name || '').trim()) return;
    const ok = await onDeleteProject(project);
    if (!ok) return;
    cancelDeleteConfirm();
  }

  return (
    <aside className={`w-full ${mobile ? 'h-full' : 'md:w-72'} border-b md:border-b-0 md:border-r p-3 md:p-4 flex flex-col`} style={{ borderColor: 'var(--border)' }}>
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
          <input
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            placeholder="GitHub repo (owner/repo or URL)"
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
          const isEditing = editingId === p.id;
          const isDeleteConfirming = deleteConfirmId === p.id;
          return (
            <div
              key={p.id}
              className="rounded-xl border transition"
              style={selected
                ? {
                    borderColor: 'var(--accent-2)',
                    background: 'color-mix(in srgb, var(--accent-2) 20%, var(--surface-2))',
                  }
                : {
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                  }}
            >
              <button
                onClick={() => onSelect(p)}
                className="w-full text-left px-3 py-2 rounded-xl text-sm"
                style={{ color: selected ? 'var(--text-1)' : 'var(--text-2)' }}
              >
                <div className="font-medium truncate">{p.name}</div>
                <div className="text-[11px] mt-1 space-y-1" style={{ color: 'var(--text-3)' }}>
                  <div className="truncate">{p.repo_path || 'No repo path'}</div>
                  {p.github_repo ? (
                    <div className="truncate">GitHub: {p.github_repo}</div>
                  ) : null}
                </div>
              </button>

              {selected && typeof onUpdateProject === 'function' && (
                <div className="px-3 pb-3">
                  {isEditing ? (
                    <form onSubmit={(e) => handleUpdateSubmit(e, p.id)} className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Project name"
                        className="w-full text-sm px-3 py-2 rounded-lg border outline-none"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', color: 'var(--text-1)' }}
                      />
                      <input
                        value={editRepoPath}
                        onChange={(e) => setEditRepoPath(e.target.value)}
                        placeholder="Repo path"
                        className="w-full text-xs px-3 py-2 rounded-lg border outline-none"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', color: 'var(--text-2)' }}
                      />
                      <input
                        value={editGithubRepo}
                        onChange={(e) => setEditGithubRepo(e.target.value)}
                        placeholder="GitHub repo (owner/repo or URL)"
                        className="w-full text-xs px-3 py-2 rounded-lg border outline-none"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', color: 'var(--text-2)' }}
                      />
                      <div className="flex gap-2">
                        <button type="submit" className="ccm-button ccm-button-accent text-xs px-3 py-1.5 flex-1">
                          Save
                        </button>
                        <button type="button" onClick={stopEditing} className="ccm-button ccm-button-soft text-xs px-3 py-1.5">
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : isDeleteConfirming && typeof onDeleteProject === 'function' ? (
                    <form onSubmit={(e) => handleDeleteSubmit(e, p)} className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <div className="text-[11px] leading-5" style={{ color: 'var(--text-3)' }}>
                        This will delete the project and all of its tasks. Type <span style={{ color: 'var(--danger)' }}>{p.name}</span> to confirm.
                      </div>
                      <input
                        autoFocus
                        value={deleteConfirmName}
                        onChange={(e) => setDeleteConfirmName(e.target.value)}
                        placeholder={`Type "${p.name}" to confirm`}
                        className="w-full text-xs px-3 py-2 rounded-lg border outline-none"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', color: 'var(--text-1)' }}
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={deleteConfirmName.trim() !== String(p.name || '').trim()}
                          className="ccm-button ccm-button-soft text-xs px-3 py-1.5 flex-1"
                          style={{ color: 'var(--danger)' }}
                        >
                          Delete Permanently
                        </button>
                        <button type="button" onClick={cancelDeleteConfirm} className="ccm-button ccm-button-soft text-xs px-3 py-1.5">
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="border-t pt-3 flex gap-2" style={{ borderColor: 'var(--border)' }}>
                      <button type="button" onClick={() => startEditing(p)} className="ccm-button ccm-button-soft text-xs px-3 py-1.5 flex-1">
                        Edit Project
                      </button>
                      {typeof onDeleteProject === 'function' && (
                        <button
                          type="button"
                          onClick={() => startDeleteConfirm(p)}
                          className="ccm-button ccm-button-soft text-xs px-3 py-1.5"
                          style={{ color: 'var(--danger)' }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
