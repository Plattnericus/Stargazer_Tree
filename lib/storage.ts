// localStorage throws instead of returning null when storage is blocked (e.g.
// Safari with all cookies blocked). Preferences are optional, so failures are
// swallowed rather than taking the page down.

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
