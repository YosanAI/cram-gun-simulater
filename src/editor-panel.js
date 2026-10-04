/** Resize the overlay independently of the scene and keep its contents mounted. */
export function createEditorPanel(panel, onLayoutChange) {
  const body = panel.querySelector('#script-body');
  const collapseButton = panel.querySelector('#toggle-editor');
  const resizeHandle = panel.querySelector('#resize-editor');
  const stage = panel.parentElement;
  let drag = null;

  function setSize(width, height) {
    const style = getComputedStyle(panel);
    const maxWidth = Math.max(1, document.documentElement.clientWidth - parseFloat(style.left) - parseFloat(style.getPropertyValue('--panel-right-inset')));
    const maxHeight = Math.max(1, document.documentElement.clientHeight - parseFloat(style.bottom) - parseFloat(style.getPropertyValue('--panel-top-inset')));
    const clamp = (value, min, max) => Math.min(max, Math.max(Math.min(min, max), value));
    panel.style.setProperty('--editor-width', clamp(width, 320, maxWidth) + 'px');
    panel.style.setProperty('--editor-height', clamp(height, 260, maxHeight) + 'px');
  }

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    delete panel.dataset.resizing;
    if (resizeHandle.hasPointerCapture(id)) resizeHandle.releasePointerCapture(id);
  }

  function setCollapsed(collapsed) {
    endDrag();
    panel.dataset.collapsed = String(collapsed);
    body.hidden = collapsed;
    resizeHandle.hidden = collapsed;
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand editor' : 'Collapse editor');
    collapseButton.title = collapsed ? 'Expand editor' : 'Collapse editor';
    onLayoutChange();
  }

  function toggleCollapsed() {
    setCollapsed(panel.dataset.collapsed !== 'true');
  }

  function startDrag(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    panel.dataset.resizing = 'true';
    resizeHandle.setPointerCapture(event.pointerId);
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    setSize(drag.width + event.clientX - drag.x, drag.height + drag.y - event.clientY);
  }

  function resizeWithKeyboard(event) {
    const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    setSize(rect.width + offset[0] * step, rect.height + offset[1] * step);
  }

  const resizeObserver = new ResizeObserver(() => {
    stage.style.setProperty('--editor-panel-height', panel.getBoundingClientRect().height + 'px');
    onLayoutChange();
  });
  resizeObserver.observe(panel);
  collapseButton.addEventListener('click', toggleCollapsed);
  resizeHandle.addEventListener('pointerdown', startDrag);
  resizeHandle.addEventListener('pointermove', moveDrag);
  resizeHandle.addEventListener('pointerup', endDrag);
  resizeHandle.addEventListener('pointercancel', endDrag);
  resizeHandle.addEventListener('lostpointercapture', endDrag);
  resizeHandle.addEventListener('keydown', resizeWithKeyboard);

  return {
    setCollapsed,
    destroy() {
      endDrag();
      resizeObserver.disconnect();
      stage.style.removeProperty('--editor-panel-height');
      collapseButton.removeEventListener('click', toggleCollapsed);
      resizeHandle.removeEventListener('pointerdown', startDrag);
      resizeHandle.removeEventListener('pointermove', moveDrag);
      resizeHandle.removeEventListener('pointerup', endDrag);
      resizeHandle.removeEventListener('pointercancel', endDrag);
      resizeHandle.removeEventListener('lostpointercapture', endDrag);
      resizeHandle.removeEventListener('keydown', resizeWithKeyboard);
    },
  };
}
