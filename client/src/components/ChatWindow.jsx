import { Bubble, Sender } from '@ant-design/x';

export function ChatWindow({
  title,
  statusText,
  messages,
  inputValue,
  onInputChange,
  onSubmit,
  onClear,
  diagnostics,
  placeholder,
  assistantLabel = 'CCM',
  loading = false,
  endRef,
  className = '',
}) {
  const items = messages.map((msg, idx) => ({
    key: `${msg.role}-${idx}`,
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.text,
  }));

  const roles = {
    user: {
      placement: 'end',
      variant: 'filled',
      shape: 'corner',
      styles: {
        content: {
          background: 'color-mix(in srgb, var(--accent-2) 22%, var(--surface-2))',
          color: 'var(--text-1)',
          borderColor: 'var(--border)',
        },
      },
    },
    assistant: {
      placement: 'start',
      variant: 'outlined',
      shape: 'corner',
      header: () => (
        <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-3)' }}>
          {assistantLabel}
        </div>
      ),
      styles: {
        content: {
          background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-2))',
          color: 'var(--text-1)',
          borderColor: 'var(--border)',
        },
      },
    },
  };

  return (
    <div className={`flex flex-col border-t h-full min-h-0 overflow-hidden ${className}`} style={{ borderColor: 'var(--border)' }}>
      <div className="px-4 py-2 text-xs border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
        <span>{title}</span>
        <div className="flex items-center gap-2">
          <span>{statusText}</span>
          {onClear && (
            <button type="button" onClick={onClear} className="ccm-button ccm-button-soft text-xs px-2 py-0.5">
              Clear
            </button>
          )}
        </div>
      </div>

      {diagnostics && (
        <div className="px-4 py-2 text-[11px] border-b flex flex-wrap gap-x-4 gap-y-1" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
          <span>phase: {diagnostics.phase}</span>
          <span>elapsed: {diagnostics.elapsedSec}s</span>
          <span>ttfb: {diagnostics.firstTokenSec != null ? `${diagnostics.firstTokenSec}s` : '-'}</span>
          <span>last gap: {diagnostics.lastGapSec != null ? `${diagnostics.lastGapSec}s` : '-'}</span>
          <span>chunks: {diagnostics.chunks}</span>
          {diagnostics.hint && <span style={{ color: 'var(--warn)' }}>hint: {diagnostics.hint}</span>}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 md:px-4 py-3">
        {messages.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--text-3)' }}>
            No messages yet.
          </div>
        )}

        {messages.length > 0 && (
          <Bubble.List
            autoScroll
            items={items}
            role={roles}
            style={{ background: 'transparent' }}
          />
        )}
        <div ref={endRef} />
      </div>

      <div className="px-3 py-3 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
        <Sender
          value={inputValue}
          onChange={(nextValue) => onInputChange(nextValue)}
          onSubmit={(nextValue) => onSubmit?.(undefined, nextValue)}
          placeholder={placeholder}
          submitType="enter"
          loading={loading}
          autoSize={{ minRows: 1, maxRows: 5 }}
          classNames={{
            root: 'ccm-x-sender',
          }}
          styles={{
            root: {
              background: 'color-mix(in srgb, var(--surface-2) 90%, transparent)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              minHeight: 52,
            },
            content: { minHeight: 40 },
            input: {
              color: 'var(--text-1)',
              minHeight: 24,
              lineHeight: '22px',
            },
          }}
        />
      </div>
    </div>
  );
}
