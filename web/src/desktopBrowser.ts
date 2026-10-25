export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Internals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export function desktopHost(): Internals | null {
  const host = window as Window & { __TAURI_INTERNALS__?: Internals };
  return host.__TAURI_INTERNALS__ ?? null;
}

export function isRemotePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function browserBounds(
  rect: { left: number; top: number; width: number; height: number },
  blocked: boolean,
): BrowserBox | null {
  if (blocked) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 2 || height < 2) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height,
  };
}

/** Keep the largest part of the page that does not sit under a right-click menu. */
export function fitAround(box: BrowserBox, obstacles: BrowserBox[]): BrowserBox | null {
  return obstacles.reduce<BrowserBox | null>((current, obstacle) => {
    if (!current) return null;
    return cutAround(current, obstacle);
  }, box);
}

function cutAround(box: BrowserBox, obstacle: BrowserBox): BrowserBox | null {
  const pad = 6;
  const block = {
    x: obstacle.x - pad,
    y: obstacle.y - pad,
    width: obstacle.width + pad * 2,
    height: obstacle.height + pad * 2,
  };
  const left = Math.max(box.x, block.x);
  const top = Math.max(box.y, block.y);
  const right = Math.min(box.x + box.width, block.x + block.width);
  const bottom = Math.min(box.y + box.height, block.y + block.height);
  if (right <= left || bottom <= top) return box;

  const candidates: BrowserBox[] = [];
  if (top - box.y >= 2) {
    candidates.push({ x: box.x, y: box.y, width: box.width, height: top - box.y });
  }
  if (box.y + box.height - bottom >= 2) {
    candidates.push({ x: box.x, y: bottom, width: box.width, height: box.y + box.height - bottom });
  }
  if (left - box.x >= 2) {
    candidates.push({ x: box.x, y: box.y, width: left - box.x, height: box.height });
  }
  if (box.x + box.width - right >= 2) {
    candidates.push({ x: right, y: box.y, width: box.x + box.width - right, height: box.height });
  }
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0] ?? null;
}

export function menuObstacles(): BrowserBox[] {
  return [...document.querySelectorAll(".panel-menu")].flatMap((node) => {
    const rect = node.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) return [];
    return [{ x: Math.round(rect.left), y: Math.round(rect.top), width, height }];
  });
}

export function browserBlocked(): boolean {
  const body = document.body;
  if (body.classList.contains("is-selecting") || body.classList.contains("panel-dragging")) return true;
  return document.querySelector(".settings-backdrop, .select-menu") !== null;
}

let generation = 0;

export function nextBrowserGeneration(): number {
  generation += 1;
  return generation;
}

export async function placeBrowser(
  label: string,
  url: string,
  bounds: BrowserBox | null,
  generationId: number,
): Promise<void> {
  const host = desktopHost();
  if (!host) throw new Error("desktop shell is not connected");
  await host.invoke("place_browser", {
    label,
    url,
    x: bounds?.x ?? 0,
    y: bounds?.y ?? 0,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
    visible: bounds !== null,
    generation: generationId,
  });
}

export async function closeBrowser(label: string, generationId: number): Promise<void> {
  const host = desktopHost();
  if (!host) return;
  await host.invoke("close_browser", { label, generation: generationId });
}
