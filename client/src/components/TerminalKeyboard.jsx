import { useState } from 'react';
import { createPortal } from 'react-dom';

const KEY_MAPPINGS = {
  'ESC': '\x1b',
  'TAB': '\t',
  'CTRL': null, // modifier key
  'UP': '\x1b[A',
  'DOWN': '\x1b[B',
  'LEFT': '\x1b[D',
  'RIGHT': '\x1b[C',
  'ENTER': '\r',
  'BKSP': '\x7f',
  '`': '`',
  '~': '~',
  '|': '|',
  '/': '/',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '[': '[',
  ']': ']',
  '{': '{',
  '}': '}',
  ':': ':',
  ';': ';',
  '"': '"',
  "'": "'",
  '<': '<',
  '>': '>',
  '?': '?',
};

const CTRL_KEYS = [
  { label: '^C', value: '\x03', desc: 'Interrupt' },
  { label: '^D', value: '\x04', desc: 'EOF' },
  { label: '^Z', value: '\x1a', desc: 'Suspend' },
  { label: '^L', value: '\x0c', desc: 'Clear' },
  { label: '^R', value: '\x12', desc: 'Search' },
  { label: '^A', value: '\x01', desc: 'Home' },
  { label: '^E', value: '\x05', desc: 'End' },
  { label: '^K', value: '\x0b', desc: 'Kill' },
  { label: '^U', value: '\x15', desc: 'Clear line' },
];

export function TerminalKeyboard({ onKeyPress, visible = true }) {
  const [showCtrlKeys, setShowCtrlKeys] = useState(false);
  const [ctrlPressed, setCtrlPressed] = useState(false);

  if (!visible) return null;

  const handleKeyPress = (key) => {
    if (key === 'CTRL') {
      setCtrlPressed(!ctrlPressed);
      return;
    }

    let value = KEY_MAPPINGS[key];

    if (ctrlPressed && key.length === 1) {
      // Convert letter to Ctrl+letter
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) {
        value = String.fromCharCode(code - 64);
      }
      setCtrlPressed(false);
    }

    if (value !== null && onKeyPress) {
      onKeyPress(value);
    }
  };

  const KeyButton = ({ label, keyCode, className = '' }) => (
    <button
      type="button"
      onClick={() => handleKeyPress(keyCode || label)}
      className={`
        px-2 py-2 text-xs font-mono rounded
        active:scale-95 transition-transform
        ${ctrlPressed && keyCode !== 'CTRL' ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-100'}
        ${keyCode === 'CTRL' && ctrlPressed ? 'bg-blue-600 text-white ring-2 ring-blue-400' : ''}
        hover:bg-gray-600
        ${className}
      `}
      style={{ minWidth: '44px', minHeight: '44px' }}
    >
      {label}
    </button>
  );

  const keyboardContent = (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-gray-900"
      style={{
        borderColor: 'var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Main keyboard */}
      <div className="p-2 space-y-2">
        {/* Row 1: Control keys */}
        <div className="flex gap-1 justify-between">
          <KeyButton label="ESC" keyCode="ESC" />
          <KeyButton label="TAB" keyCode="TAB" />
          <KeyButton label="CTRL" keyCode="CTRL" />
          <KeyButton label="↑" keyCode="UP" />
          <KeyButton label="↓" keyCode="DOWN" />
          <KeyButton label="←" keyCode="LEFT" />
          <KeyButton label="→" keyCode="RIGHT" />
          <button
            type="button"
            onClick={() => setShowCtrlKeys(!showCtrlKeys)}
            className="px-2 py-2 text-xs font-mono rounded bg-gray-700 text-gray-100 hover:bg-gray-600"
            style={{ minWidth: '44px', minHeight: '44px' }}
          >
            {showCtrlKeys ? '✕' : '^'}
          </button>
        </div>

        {/* Row 2: Special characters */}
        <div className="flex gap-1 justify-between">
          <KeyButton label="`" />
          <KeyButton label="~" />
          <KeyButton label="|" />
          <KeyButton label="/" />
          <KeyButton label="\" />
          <KeyButton label="-" />
          <KeyButton label="=" />
          <KeyButton label="[" />
          <KeyButton label="]" />
        </div>

        {/* Ctrl shortcuts panel */}
        {showCtrlKeys && (
          <div className="grid grid-cols-3 gap-1 p-2 rounded bg-gray-800">
            {CTRL_KEYS.map(({ label, value, desc }) => (
              <button
                key={label}
                type="button"
                onClick={() => onKeyPress && onKeyPress(value)}
                className="px-2 py-2 text-xs font-mono rounded bg-gray-700 text-gray-100 hover:bg-gray-600 active:scale-95 transition-transform flex flex-col items-center"
                style={{ minHeight: '44px' }}
              >
                <span className="font-bold">{label}</span>
                <span className="text-[10px] text-gray-400">{desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {ctrlPressed && (
        <div className="px-2 pb-2 text-xs text-center" style={{ color: 'var(--text-3)' }}>
          Press any key to send Ctrl+Key
        </div>
      )}
    </div>
  );

  if (!visible) return null;

  return createPortal(keyboardContent, document.body);
}
