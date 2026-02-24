const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function getProjects() {
  const res = await notion.databases.query({
    database_id: process.env.NOTION_PROJECTS_DB,
  });
  return res.results.map(p => ({
    id: p.id,
    name: p.properties.Name?.title?.[0]?.plain_text ?? '',
    repoPath: p.properties['Repo Path']?.rich_text?.[0]?.plain_text ?? '',
    sshHost: p.properties['SSH Host']?.rich_text?.[0]?.plain_text ?? '',
  }));
}

async function getTasks(projectId) {
  const res = await notion.databases.query({
    database_id: process.env.NOTION_TASKS_DB,
    filter: projectId ? {
      property: 'Project',
      relation: { contains: projectId },
    } : undefined,
  });
  return res.results.map(t => ({
    id: t.id,
    title: t.properties.Title?.title?.[0]?.plain_text ?? '',
    status: t.properties.Status?.select?.name ?? 'pending',
    worktreePath: t.properties['Worktree Path']?.rich_text?.[0]?.plain_text ?? '',
    branch: t.properties.Branch?.rich_text?.[0]?.plain_text ?? '',
    ptySession: t.properties['pty Session']?.rich_text?.[0]?.plain_text ?? '',
    model: t.properties.Model?.rich_text?.[0]?.plain_text ?? '',
  }));
}

async function createTask(data) {
  return notion.pages.create({
    parent: { database_id: process.env.NOTION_TASKS_DB },
    properties: {
      Title: { title: [{ text: { content: data.title } }] },
      Status: { select: { name: 'pending' } },
      Project: { relation: [{ id: data.projectId }] },
      Branch: { rich_text: [{ text: { content: data.branch ?? '' } }] },
      Model: { rich_text: [{ text: { content: data.model ?? 'claude-sonnet-4-5' } }] },
    },
  });
}

async function updateTask(taskId, updates) {
  const properties = {};
  if (updates.status) properties.Status = { select: { name: updates.status } };
  if (updates.worktreePath) properties['Worktree Path'] = { rich_text: [{ text: { content: updates.worktreePath } }] };
  if (updates.ptySession) properties['pty Session'] = { rich_text: [{ text: { content: updates.ptySession } }] };
  return notion.pages.update({ page_id: taskId, properties });
}

async function appendProgress(taskId, text) {
  return notion.blocks.children.append({
    block_id: taskId,
    children: [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
    }],
  });
}

module.exports = { getProjects, getTasks, createTask, updateTask, appendProgress };
