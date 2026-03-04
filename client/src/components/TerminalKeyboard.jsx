import { useState, useEffect } from 'react';
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
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!visible) return;

    // 监听 visualViewport 变化来检测键盘高度
    const handleResize = () => {
      if (window.visualViewport) {
        const vh = window.innerHeight;
        const vvh = window.visualViewport.height;
        const kbHeight = Math.max(0, vh - vvh);
        setKeyboardHeight(kbHeight);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
      handleResize();
      return () => {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      };
    }
  }, [visible]);

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
        px-1.5 py-1.5 text-[11px] font-mono rounded
        active:scale-95 transition-transform
        ${ctrlPressed && keyCode !== 'CTRL' ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-100'}
        ${keyCode === 'CTRL' && ctrlPressed ? 'bg-blue-600 text-white ring-2 ring-blue-400' : ''}
        hover:bg-gray-600
        ${className}
      `}
      style={{ minWidth: '36px', minHeight: '36px' }}
    >
      {label}
    </button>
  );

  const keyboardContent = (
    <div
      className="fixed left-0 right-0 z-50 border-t bg-gray-900"
      style={{
        bottom: `${keyboardHeight}px`,
        borderColor: '#374151',
        paddingBottom: keyboardHeight > 0 ? '0' : 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="px-2 pt-2 pb-1 space-y-1.5">
        {/* Row 1 */}
        <div className="flex gap-1">
          <KeyButton label="ESC" keyCode="ESC" />
          <KeyButton label="TAB" keyCode="TAB" />
          <KeyButton label="CTRL" keyCode="CTRL" />
          <div className="flex-1" />
          <KeyButton label="↑" keyCode="UP" />
          <KeyButton label="↓" keyCode="DOWN" />
          <KeyButton label="←" keyCode="LEFT" />
          <KeyButton label="→" keyCode="RIGHT" />
          <button
            type="button"
            onClick={() => setShowCtrlKeys(!showCtrlKeys)}
            className="px-1.5 py-1.5 text-[11px] font-mono rounded bg-gray-600 text-gray-300 hover:bg-gray-500"
            style={{ minWidth: '36px', minHeight: '36px' }}
          >
            {showCtrlKeys ? '✕' : '^'}
          </button>
        </div>

        {/* Row 2 */}
        <div className="flex gap-1">
          {['`', '~', '|', '/', '\\', '-', '=', '[', ']'].map(k => (
            <KeyButton key={k} label={k} />
          ))}
        </div>

        {/* Ctrl shortcuts */}
        {showCtrlKeys && (
          <div className="grid grid-cols-5 gap-1 pt-1 border-t border-gray-700">
            {CTRL_KEYS.map(({ label, value, desc }) => (
              <button
                key={label}
                type="button"
                onClick={() => onKeyPress && onKeyPress(value)}
                className="py-1.5 text-[11px] font-mono rounded bg-gray-700 text-gray-100 hover:bg-gray-600 active:scale-95 transition-transform flex flex-col items-center"
              >
                <span className="font-bold text-blue-400">{label}</span>
                <span className="text-[9px] text-gray-500">{desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {ctrlPressed && (
        <div className="px-2 pb-1 text-[10px] text-center text-blue-400">
          Ctrl+? — press a key
        </div>
      )}
    </div>
  );

  if (!visible) return null;

  return createPortal(keyboardContent, document.body);
}
