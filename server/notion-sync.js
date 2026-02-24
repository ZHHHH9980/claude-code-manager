const notion = require('./notion');

// Async sync to Notion - fire and forget, never blocks the main flow
function syncProjectToNotion(project) {
  if (!process.env.NOTION_TOKEN) return;
  // TODO: create/update project in Notion
  console.log(`[notion-sync] Would sync project: ${project.name}`);
}

function syncTaskToNotion(task) {
  if (!process.env.NOTION_TOKEN) return;
  const data = {
    title: task.title,
    projectId: task.project_id,
    branch: task.branch,
    model: task.model,
  };
  if (task.notion_id) {
    notion.updateTask(task.notion_id, {
      status: task.status,
      worktreePath: task.worktree_path,
      ptySession: task.pty_session,
    }).catch(err => console.error('[notion-sync] update error:', err.message));
  } else {
    notion.createTask(data)
      .then(page => {
        // Store notion_id back to SQLite
        const db = require('./db');
        db.updateTask(task.id, { notionId: page.id });
      })
      .catch(err => console.error('[notion-sync] create error:', err.message));
  }
}

function syncProgressToNotion(taskNotionId, text) {
  if (!process.env.NOTION_TOKEN || !taskNotionId) return;
  notion.appendProgress(taskNotionId, text)
    .catch(err => console.error('[notion-sync] progress error:', err.message));
}

module.exports = { syncProjectToNotion, syncTaskToNotion, syncProgressToNotion };
