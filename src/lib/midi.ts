import type { MidiKind } from './types';

export interface MidiMessage { kind: MidiKind; channel: number; num: number; value: number; on: boolean; }

export class MidiEngine {
  private access: MIDIAccess | null = null;
  ready = false;
  onMessage: (m: MidiMessage) => void = () => {};
  onStatus: (msg: string) => void = () => {};

  async init(): Promise<string> {
    if (typeof navigator.requestMIDIAccess !== 'function') return 'This browser has no MIDI support. Use Chrome or Edge.';
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      this.access = access;
      this.ready = true;
      this.bind();
      access.onstatechange = () => { this.bind(); this.onStatus(this.describe()); };
      return this.describe();
    } catch {
      this.ready = false;
      return 'MIDI access was blocked. Allow it from the address bar and try again.';
    }
  }

  private bind() {
    this.access?.inputs.forEach((input) => {
      input.onmidimessage = (e) => { if (e.data) this.parse(e.data); };
    });
  }

  private describe(): string {
    const names: string[] = [];
    this.access?.inputs.forEach((i) => names.push(i.name || 'Unnamed controller'));
    return names.length ? `Connected to ${names.join(', ')}.` : 'No controller found yet. Plug one in and it connects automatically.';
  }

  private parse(d: Uint8Array) {
    if (!d || d.length < 2) return;
    const status = d[0] & 0xf0;
    const channel = d[0] & 0x0f;
    const value = d[2] ?? 0;
    if (status === 0x90 || status === 0x80) {
      this.onMessage({ kind: 'note', channel, num: d[1], value, on: status === 0x90 && value > 0 });
    } else if (status === 0xb0) {
      this.onMessage({ kind: 'cc', channel, num: d[1], value, on: value > 63 });
    }
  }
}
