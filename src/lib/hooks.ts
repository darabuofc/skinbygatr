import { useSyncExternalStore } from 'react';
import type { Store } from './observable';

export function useStore<T extends object>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
