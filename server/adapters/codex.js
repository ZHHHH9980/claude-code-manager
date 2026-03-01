module.exports = {
  name: 'codex',
  label: 'Codex',
  color: '#10a37f',
  cli: 'codex',
  defaultArgs: ['--full-auto'],
  models: [
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex' },
    { id: 'gpt-5-codex', label: 'GPT-5-Codex' },
  ],
  defaultModel: 'gpt-5.3-codex',
  autoConfirm: { enabled: false },
  chatMode: null,
};
