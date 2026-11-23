const root = document.documentElement;
const palette = document.querySelector<HTMLInputElement>('#pink-blue')!;
const mode = document.querySelector<HTMLInputElement>('#light-dark')!;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let modePreference: string | null = null;
try {
  modePreference = localStorage.getItem('colorMode');
} catch {
  // Preferences can still be changed for this visit.
}

palette.checked = root.classList.contains('blue');
mode.checked = root.classList.contains('dark');
root.style.removeProperty('background-color');
root.style.removeProperty('color-scheme');

function applyTheme(): void {
  root.classList.toggle('blue', palette.checked);
  root.classList.toggle('pink', !palette.checked);
  root.classList.toggle('dark', mode.checked);
  root.classList.toggle('light', !mode.checked);
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current choice when storage is unavailable.
  }
}

palette.addEventListener('change', () => {
  remember('palette', palette.checked ? 'blue' : 'pink');
  applyTheme();
});

mode.addEventListener('change', () => {
  modePreference = mode.checked ? 'dark' : 'light';
  remember('colorMode', modePreference);
  applyTheme();
});

systemDark.addEventListener('change', () => {
  if (modePreference === 'dark' || modePreference === 'light') return;
  mode.checked = systemDark.matches;
  applyTheme();
});
