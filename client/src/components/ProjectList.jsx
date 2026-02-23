export function ProjectList({ projects, selectedId, onSelect }) {
  return (
    <div className="w-48 border-r border-gray-700 p-3 flex flex-col gap-1">
      <div className="text-xs text-gray-400 uppercase mb-2">Projects</div>
      {projects.map(p => (
        <button
          key={p.id}
          onClick={() => onSelect(p)}
          className={`text-left px-2 py-1 rounded text-sm ${
            selectedId === p.id ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'
          }`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
