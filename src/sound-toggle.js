/** Keep the toolbar mute button in sync with the scene's audio settings. */
export function createSoundToggle(button, sound) {
  let enabled;

  function sync() {
    const nextEnabled = sound.getState().enabled;
    if (nextEnabled === enabled) return;
    enabled = nextEnabled;
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Mute sound' : 'Unmute sound');
    button.title = enabled ? 'Mute sound' : 'Unmute sound';
  }

  function toggle() {
    sound.setEnabled(!sound.getState().enabled);
    sync();
  }

  button.addEventListener('click', toggle);
  sync();

  return {
    sync,
    destroy() { button.removeEventListener('click', toggle); },
  };
}
