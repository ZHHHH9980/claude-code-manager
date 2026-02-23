import { useMemo, useRef, useState } from 'react';
import {
  MainContainer,
  ChatContainer,
  MessageList,
  Message,
  MessageInput,
  TypingIndicator,
} from '@chatscope/chat-ui-kit-react';

function getStatusLabel(phase) {
  if (phase === 'streaming') return 'Receiving response...';
  if (phase === 'sending') return 'Sending request...';
  if (phase === 'error') return 'Request failed';
  return 'Idle';
}

export function AssistantChatWindow({
  title,
  endpoint,
  placeholder,
  assistantLabel = 'CCM',
  buildBody,
  onAfterDone,
  className = '',
}) {
  const [messages, setMessages] = useState([]);
  const [phase, setPhase] = useState('idle');
  const abortRef = useRef(null);

  const typing = useMemo(() => {
    if (phase !== 'sending' && phase !== 'streaming') return undefined;
    return <TypingIndicator content={phase === 'sending' ? 'Waiting for first token...' : 'Streaming...'} />;
  }, [phase]);

  const handleSend = async (text) => {
    const userText = String(text || '').trim();
    if (!userText || phase === 'sending' || phase === 'streaming') return;

    setMessages((prev) => [...prev, { role: 'user', text: userText }, { role: 'assistant', text: '' }]);
    setPhase('sending');

    const history = messages
      .filter((m) => m?.role === 'user' || m?.role === 'assistant')
      .map((m) => ({ role: m.role, text: m.text }))
      .filter((m) => String(m.text || '').trim());

    const body = buildBody
      ? buildBody({ message: userText, history, messages })
      : { message: userText };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          if (!chunk || chunk.startsWith(':')) continue;
          const dataLines = chunk
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;

          let event;
          try {
            event = JSON.parse(dataLines.join('\n'));
          } catch {
            continue;
          }

          if (event.ready) continue;
          if (event.error) throw new Error(event.text || 'request failed');

          if (event.text) {
            setPhase('streaming');
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === 'assistant') {
                last.text = `${last.text || ''}${String(event.text)}`;
              }
              return updated;
            });
          }

          if (event.done) {
            setPhase('idle');
            abortRef.current = null;
            onAfterDone?.();
            return;
          }
        }
      }

      setPhase('idle');
      abortRef.current = null;
      onAfterDone?.();
    } catch (err) {
      setPhase('error');
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const text = `Error: ${err?.message || 'request failed'}`;
        if (last?.role === 'assistant') last.text = text;
        else updated.push({ role: 'assistant', text });
        return updated;
      });
      abortRef.current = null;
      setTimeout(() => setPhase('idle'), 1200);
    }
  };

  const handleClear = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPhase('idle');
    setMessages([]);
  };

  return (
    <div className={`flex flex-col border-t h-full min-h-0 overflow-hidden ${className}`} style={{ borderColor: 'var(--border)' }}>
      <div className="px-4 py-2 text-xs border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
        <span>{title}</span>
        <div className="flex items-center gap-2">
          <span>{getStatusLabel(phase)}</span>
          <button type="button" onClick={handleClear} className="ccm-button ccm-button-soft text-xs px-2 py-0.5">Clear</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <MainContainer responsive style={{ background: 'transparent' }}>
          <ChatContainer>
            <MessageList typingIndicator={typing}>
              {messages.map((m, idx) => (
                <Message
                  key={`${m.role}-${idx}`}
                  model={{
                    message: m.text,
                    direction: m.role === 'user' ? 'outgoing' : 'incoming',
                    position: 'single',
                    sender: m.role === 'user' ? 'You' : assistantLabel,
                  }}
                />
              ))}
            </MessageList>
            <MessageInput
              placeholder={placeholder || 'Type a message...'}
              attachButton={false}
              sendButton
              disabled={phase === 'sending' || phase === 'streaming'}
              onSend={handleSend}
            />
          </ChatContainer>
        </MainContainer>
      </div>
    </div>
  );
}
