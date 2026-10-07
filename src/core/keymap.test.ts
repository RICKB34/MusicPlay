import { describe, expect, it } from 'vitest'
import {
  buildKeymap,
  cloneKeyBindings,
  DEFAULT_KEY_BINDINGS,
  isBindableKeyCode,
  keyHint,
  keyLabel,
  normalizeBindingSet,
  normalizeKeyBindings,
} from './keymap'

describe('key bindings', () => {
  it('keeps the documented defaults', () => {
    expect(DEFAULT_KEY_BINDINGS[4]).toEqual(['KeyD', 'KeyF', 'KeyJ', 'KeyK'])
    expect(DEFAULT_KEY_BINDINGS[6]).toEqual(['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'])
  })

  it('clones both binding sets instead of sharing arrays', () => {
    const copy = cloneKeyBindings(DEFAULT_KEY_BINDINGS)
    expect(copy).toEqual(DEFAULT_KEY_BINDINGS)
    expect(copy[4]).not.toBe(DEFAULT_KEY_BINDINGS[4])
    expect(copy[6]).not.toBe(DEFAULT_KEY_BINDINGS[6])
  })

  it('rejects reserved and modifier-only keys', () => {
    expect(isBindableKeyCode('KeyD')).toBe(true)
    expect(isBindableKeyCode('Space')).toBe(true)
    expect(isBindableKeyCode('Escape')).toBe(false)
    expect(isBindableKeyCode('ControlLeft')).toBe(false)
    expect(isBindableKeyCode('Unidentified')).toBe(false)
  })

  it('repairs malformed bindings without leaving duplicate lanes', () => {
    expect(normalizeBindingSet(['KeyA', 'KeyA', 'Escape', 'KeyL'], 4)).toEqual([
      'KeyA',
      'KeyD',
      'KeyF',
      'KeyL',
    ])
    expect(normalizeBindingSet(['KeyA'], 6)).toEqual(DEFAULT_KEY_BINDINGS[6])
  })

  it('normalizes old or partial persisted settings', () => {
    expect(normalizeKeyBindings({ 4: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], 6: ['KeyZ'] })).toEqual({
      4: ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
      6: DEFAULT_KEY_BINDINGS[6],
    })
  })

  it('builds a first-lane-wins keymap and formats labels', () => {
    expect(buildKeymap(['KeyA', 'KeyS', 'KeyA'])).toEqual({ KeyA: 0, KeyS: 1 })
    expect(keyLabel('KeyD')).toBe('D')
    expect(keyLabel('Digit1')).toBe('1')
    expect(keyLabel('Numpad1')).toBe('Num 1')
    expect(keyLabel('ArrowLeft')).toBe('←')
    expect(keyHint(4)).toBe('D F  J K')
    expect(keyHint(6)).toBe('S D F  J K L')
  })
})
