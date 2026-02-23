import { useEffect } from 'react';

export function ChatWindow({
  title,
  statusText,
  messages,
  inputValue,
  onInputChange,
  onSubmit,
  placeholder,
  sendLabel = 'Send',
  assistantLabel = 'CCM',
  loading = false,
  endRef,
  className = '',
}) {
  useEffect(() => {
    endRef?.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, endRef]);

  return (
    <div className={`flex flex-col border-t h-full ${className}`} style={{ borderColor: 'var(--border)' }}>
      <div className="px-4 py-2 text-xs border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
        <span>{title}</span>
        <span>{statusText}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--text-3)' }}>
            No messages yet.
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            <div className={`chat-bubble text-sm ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
              {msg.role === 'assistant' && (
                <div className="text-[10px] mb-1 uppercase tracking-wide" style={{ color: 'var(--text-3)' }}>
                  {assistantLabel}
                </div>
              )}
              {msg.text}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col md:flex-row gap-2 px-3 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <input
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={placeholder}
          className="ccm-input flex-1"
          autoFocus
        />
        <button type="submit" disabled={loading} className="ccm-button ccm-button-accent text-xs px-4 py-2">
          {sendLabel}
        </button>
      </form>
    </div>
  );
}
