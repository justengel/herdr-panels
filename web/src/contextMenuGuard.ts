/** Windows can send a right-click for the panel under a left-button drag. */

export interface PointerGesture {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function suppressContextMenu(gesture: PointerGesture | null): boolean {
  if (!gesture) return false;
  return gesture.button === 0 && !gesture.ctrlKey && !gesture.metaKey;
}

export interface GuardPointer {
  button: number;
  buttons: number;
  ctrlKey: boolean;
  metaKey: boolean;
  time: number;
}

const HOLD_MS = 1000;
/** A right-click this soon after a left release is the drag's leftover event. */
const SYNTHETIC_RIGHT_MS = 400;

export function createContextMenuGuard() {
  let suppressUntil = 0;
  let leftDown = false;
  let leftUpAt = Number.NEGATIVE_INFINITY;

  const releaseLeft = (time: number) => {
    if (!leftDown) return;
    leftDown = false;
    leftUpAt = time;
    suppressUntil = time + HOLD_MS;
  };

  return {
    pointerDown(event: GuardPointer) {
      if (suppressContextMenu(event)) {
        leftDown = true;
        suppressUntil = Number.POSITIVE_INFINITY;
        return;
      }
      const syntheticRight =
        event.button === 2 &&
        (leftDown || (event.buttons & 1) !== 0 || event.time - leftUpAt < SYNTHETIC_RIGHT_MS);
      if (syntheticRight) return;
      leftDown = false;
      suppressUntil = 0;
    },
    pointerUp(event: { button: number; time: number }) {
      if (event.button !== 0) return;
      releaseLeft(event.time);
    },
    pointerCancel(time: number) {
      releaseLeft(time);
    },
    swallow(time: number) {
      return suppressUntil > time;
    },
  };
}

/** Swallow that extra menu until a real right-click or Ctrl/Command-click. */
export function installContextMenuGuard(): () => void {
  const guard = createContextMenuGuard();

  const remember = (event: PointerEvent) => {
    guard.pointerDown({
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      time: event.timeStamp,
    });
  };

  const release = (event: PointerEvent) => {
    guard.pointerUp({ button: event.button, time: event.timeStamp });
  };

  const cancel = (event: PointerEvent) => {
    guard.pointerCancel(event.timeStamp);
  };

  const onMenu = (event: Event) => {
    if (!guard.swallow(event.timeStamp)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("contextmenu", onMenu, true);
  return () => {
    document.removeEventListener("pointerdown", remember, true);
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("contextmenu", onMenu, true);
  };
}
