const TOOLS = [
  { type: 'function', function: { name: 'list_projects', description: 'List all projects', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_project', description: 'Create a new project', parameters: { type: 'object', properties: { name: { type: 'string' }, repoPath: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'list_tasks', description: 'List tasks for a project', parameters: { type: 'object', properties: { projectId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_task', description: 'Create a new task', parameters: { type: 'object', properties: { title: { type: 'string' }, projectId: { type: 'string' }, branch: { type: 'string' } }, required: ['title', 'projectId'] } } },
  { type: 'function', function: { name: 'start_task', description: 'Start Claude Code session for a task', parameters: { type: 'object', properties: { taskId: { type: 'string' }, mode: { type: 'string', enum: ['claude', 'ralph'] } }, required: ['taskId'] } } },
];

const SYSTEM = 'You are the CCM (Claude Code Manager) assistant. Help users manage projects and tasks. Use tools to accomplish requests. List projects first if you need a project ID. Be concise. Respond in the user\'s language. When creating tasks, generate a reasonable branch name if not specified.';

async function executeTool(name, args) {
  switch (name) {
    case 'list_projects': {
      const r = await fetch('/api/projects');
      return r.json();
    }
    case 'create_project': {
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      return r.json();
    }
    case 'list_tasks': {
      const r = await fetch(`/api/tasks?projectId=${args.projectId || ''}`);
      return r.json();
    }
    case 'create_task': {
      const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      return r.json();
    }
    case 'start_task':
      return { taskId: args.taskId, mode: args.mode || 'claude', action: 'start_task' };
    default:
      return { error: 'Unknown tool' };
  }
}

export async function chat(messages, apiKey) {
  let startAction = null;
  const msgs = [{ role: 'system', content: SYSTEM }, ...messages];

  const callPoe = async (m) => {
    const res = await fetch('https://api.poe.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'claude-3.5-sonnet', messages: m, tools: TOOLS }),
    });
    if (!res.ok) throw new Error(`Poe API ${res.status}: ${await res.text()}`);
    return res.json();
  };

  let res = await callPoe(msgs);
  let msg = res.choices[0].message;
  msgs.push(msg);

  while (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      const result = await executeTool(call.function.name, args);
      if (result?.action === 'start_task') startAction = result;
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    res = await callPoe(msgs);
    msg = res.choices[0].message;
    msgs.push(msg);
  }

  return { messages: msgs.filter(m => m.role !== 'system'), text: msg.content || '', startAction };
}
