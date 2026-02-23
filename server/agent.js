const OpenAI = require('openai');
const db = require('./db');

const client = new OpenAI({
  apiKey: process.env.POE_API_KEY,
  baseURL: 'https://api.poe.com/v1',
});

const tools = [
  { type: 'function', function: { name: 'list_projects', description: 'List all projects', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_project', description: 'Create a new project', parameters: { type: 'object', properties: { name: { type: 'string' }, repoPath: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'list_tasks', description: 'List tasks for a project', parameters: { type: 'object', properties: { projectId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_task', description: 'Create a new task', parameters: { type: 'object', properties: { title: { type: 'string' }, projectId: { type: 'string' }, branch: { type: 'string' } }, required: ['title', 'projectId'] } } },
  { type: 'function', function: { name: 'start_task', description: 'Start Claude Code session', parameters: { type: 'object', properties: { taskId: { type: 'string' }, mode: { type: 'string', enum: ['claude', 'ralph'] } }, required: ['taskId'] } } },
];

function executeTool(name, args) {
  switch (name) {
    case 'list_projects': return db.getProjects();
    case 'create_project': return db.createProject(args);
    case 'list_tasks': return db.getTasks(args.projectId);
    case 'create_task': return db.createTask(args);
    case 'start_task': return { taskId: args.taskId, mode: args.mode || 'claude', action: 'start_task' };
    default: return { error: 'Unknown tool' };
  }
}

const SYSTEM = 'You are the CCM (Claude Code Manager) assistant. Help users manage projects and tasks. Use tools to accomplish requests. List projects first if you need a project ID. Be concise. Respond in the user\'s language. When creating tasks, generate a reasonable branch name if not specified.';

async function chat(messages) {
  let startAction = null;
  const msgs = [{ role: 'system', content: SYSTEM }, ...messages];

  let res = await client.chat.completions.create({ model: 'claude-3.5-sonnet', messages: msgs, tools });
  let msg = res.choices[0].message;
  msgs.push(msg);

  while (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      const result = executeTool(call.function.name, args);
      if (result?.action === 'start_task') startAction = result;
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    res = await client.chat.completions.create({ model: 'claude-3.5-sonnet', messages: msgs, tools });
    msg = res.choices[0].message;
    msgs.push(msg);
  }

  const simple = msgs.filter(m => m.role === 'user' || (m.role === 'assistant' && m.content)).map(m => ({ role: m.role, content: m.content }));
  return { messages: simple, text: msg.content || '', startAction };
}

module.exports = { chat };
