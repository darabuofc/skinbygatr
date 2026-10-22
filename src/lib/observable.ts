type Listener = () => void;

/** Minimal observable store, read by React through useSyncExternalStore. */
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener>();
  constructor(initial: T) { this.state = initial; }
  get = (): T => this.state;
  set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  };
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
}
