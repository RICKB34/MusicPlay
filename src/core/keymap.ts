/**
 * Keyboard bindings shared by settings persistence, the settings UI, and input.
 *
 * Bindings store KeyboardEvent.code values, not localized key labels. This keeps
 * DFJK-style layouts stable across keyboard layouts and IMEs.
 */

export type KeyColumns = 4 | 6

export interface KeyBindings {
  4: readonly string[]
  6: readonly string[]
}

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
}

const UNBINDABLE_KEY_CODES = new Set([
  'Escape',
  'Tab',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'PrintScreen',
  'Pause',
  'ContextMenu',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

const KEY_CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'",
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
}

export function isBindableKeyCode(code: unknown): code is string {
  return typeof code === 'string' && code.length > 0 && code !== 'Unidentified' && !UNBINDABLE_KEY_CODES.has(code)
}

export function cloneKeyBindings(bindings: KeyBindings = DEFAULT_KEY_BINDINGS): KeyBindings {
  return {
    4: [...bindings[4]],
    6: [...bindings[6]],
  }
}

export function normalizeBindingSet(value: unknown, columns: KeyColumns): string[] {
  const fallback = [...DEFAULT_KEY_BINDINGS[columns]]
  if (!Array.isArray(value) || value.length !== columns) return fallback

  const output: string[] = []
  const used = new Set<string>()

  for (let i = 0; i < columns; i++) {
    const code = value[i]
    if (!isBindableKeyCode(code) || used.has(code)) {
      output.push('')
      continue
    }
    output.push(code)
    used.add(code)
  }

  for (let i = 0; i < columns; i++) {
    if (output[i]) continue
    const replacement = fallback.find((code) => !used.has(code)) ?? fallback[i] ?? ''
    output[i] = replacement
    used.add(replacement)
  }

  return output
}

export function normalizeKeyBindings(value: unknown): KeyBindings {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    4: normalizeBindingSet(source['4'], 4),
    6: normalizeBindingSet(source['6'], 6),
  }
}

export function buildKeymap(codes: readonly string[]): Record<string, number> {
  const keymap: Record<string, number> = {}
  codes.forEach((code, lane) => {
    if (!isBindableKeyCode(code) || keymap[code] !== undefined) return
    keymap[code] = lane
  })
  return keymap
}

export function keyLabel(code: string): string {
  if (KEY_CODE_LABELS[code]) return KEY_CODE_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`
  if (/^F[0-9]{1,2}$/.test(code)) return code
  return code.replace(/^Intl/, '')
}

export function keyHint(
  columns: KeyColumns,
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
): string {
  const labels = bindings[columns].map(keyLabel)
  const split = Math.ceil(columns / 2)
  return `${labels.slice(0, split).join(' ')}  ${labels.slice(split).join(' ')}`
}
