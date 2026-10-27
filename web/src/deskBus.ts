type Listener = () => void;

const listeners = new Set<Listener>();
let silent = 0;

export function subscribeDesk(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function touchDesk() {
  if (silent > 0) return;
  for (const listener of listeners) listener();
}

export function silenceDesk(run: () => void) {
  silent += 1;
  try {
    run();
  } finally {
    silent -= 1;
  }
}
