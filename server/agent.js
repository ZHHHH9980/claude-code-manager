const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const tools = [
  {
    name: 'list_projects',
    description: 'List all projects',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description: 'Create a new project',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        repoPath: { type: 'string', description: 'Repo path on server' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks for a project',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task for a project',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        projectId: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['title', 'projectId'],
    },
  },
  {
    name: 'start_task',
    description: 'Start a Claude Code session for a task',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        mode: { type: 'string', enum: ['claude', 'ralph'] },
      },
      required: ['taskId'],
    },
  },
];

function executeTool(name, input) {
  switch (name) {
    case 'list_projects': return db.getProjects();
    case 'create_project': return db.createProject(input);
    case 'list_tasks': return db.getTasks(input.projectId);
    case 'create_task': return db.createTask(input);
    case 'start_task': return { taskId: input.taskId, mode: input.mode || 'claude', action: 'start_task' };
    default: return { error: 'Unknown tool' };
  }
}

const SYSTEM = `You are the CCM (Claude Code Manager) assistant. Help users manage projects and tasks.
Use tools to accomplish requests. List projects first if you need a project ID.
Be concise. Respond in the user's language. When creating tasks, generate a reasonable branch name if not specified.`;

async function chat(messages) {
  let startAction = null;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM,
    tools,
    messages,
  });

  const allMessages = [...messages, { role: 'assistant', content: response.content }];
  let current = response;

  while (current.stop_reason === 'tool_use') {
    const toolResults = [];
    for (const block of current.content) {
      if (block.type !== 'tool_use') continue;
      const result = executeTool(block.name, block.input);
      if (result?.action === 'start_task') startAction = result;
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    allMessages.push({ role: 'user', content: toolResults });

    current = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM,
      tools,
      messages: allMessages,
    });
    allMessages.push({ role: 'assistant', content: current.content });
  }

  let text = '';
  for (const block of current.content) {
    if (block.type === 'text') text += block.text;
  }

  return { messages: allMessages, text, startAction };
}

module.exports = { chat };