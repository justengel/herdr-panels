/** Open a file in a new split beside the explorer. */
export function openFileBeside(from: string, target: string) {
  return { target, from, direction: "right" as const };
}
