module.exports = {
  name: 'claude',
  label: 'Claude Code',
  color: '#d97757',
  cli: 'claude',
  defaultArgs: ['--dangerously-skip-permissions'],
  models: [
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { id: 'claude-opus-4', label: 'Opus 4' },
  ],
  defaultModel: 'claude-sonnet-4-5',
  autoConfirm: { enabled: true, delayMs: 3000 },
  chatMode: {
    command: 'claude',
    baseArgs: [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    ],
  },
};
