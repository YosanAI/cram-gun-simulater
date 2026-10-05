/** Fullscreen keeps the scene and camera tabs mounted, preserving panel state. */
export function createFullscreenView(stage, button) {
  const document = stage.ownerDocument;
  let fallback = false;
  let pending = false;
  let disposed = false;

  function sync() {
    const active = !disposed && (fallback || document.fullscreenElement === stage);
    stage.dataset.fullscreen = String(active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    button.title = active ? 'Exit fullscreen (Esc)' : 'Enter fullscreen';
  }

  async function toggle() {
    if (pending || disposed) return;
    pending = true;
    // Move keyboard focus out of panels that are about to be hidden.
    button.focus({ preventScroll: true });
    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else if (fallback) {
        fallback = false;
      } else if (stage.requestFullscreen && document.fullscreenEnabled !== false) {
        try { await stage.requestFullscreen(); }
        catch { if (!disposed) fallback = true; }
      } else {
        // Unsupported or restricted browsers still get the unobstructed view.
        fallback = true;
      }
    } catch (error) {
      console.error('Could not exit fullscreen:', error);
    } finally {
      pending = false;
      if (!disposed) sync();
      else if (document.fullscreenElement === stage) {
        void document.exitFullscreen().catch(() => {});
      }
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !fallback) return;
    event.preventDefault();
    fallback = false;
    sync();
  }

  button.addEventListener('click', toggle);
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('keydown', onKeyDown);
  sync();

  return {
    destroy() {
      if (disposed) return;
      disposed = true;
      button.removeEventListener('click', toggle);
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('keydown', onKeyDown);
      fallback = false;
      sync();
      if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
    },
  };
}
