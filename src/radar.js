const TAU = Math.PI * 2;
const MIN_RANGE = 50;

/** Read-only north-up radar, drawn alongside the scene's animation loop. */
export function createRadar() {
  const panel = document.getElementById('radar-widget');
  const body = document.getElementById('radar-body');
  const collapseButton = document.getElementById('toggle-radar');
  const canvas = document.getElementById('radar-canvas');
  const count = document.getElementById('radar-count');
  const rangeLabel = document.getElementById('radar-range');
  const detail = document.getElementById('radar-detail');
  const kills = document.getElementById('radar-kills');
  const context = canvas.getContext('2d');
  const grid = document.createElement('canvas');
  const gridContext = grid.getContext('2d');
  const tracks = new Map();
  const stage = panel.parentElement;
  let size = 0;
  let ratio = 1;
  let range = MIN_RANGE;
  let elapsed = 0;
  let sweep = 0;
  let pointer = null;
  let disposed = false;
  let previousCount;
  let previousDetail;
  let previousKills;

  function setDetail(message) {
    if (message === previousDetail) return;
    detail.textContent = message;
    previousDetail = message;
  }

  function drawGrid() {
    if (!gridContext || !size) return;
    const center = size / 2;
    const radius = size * 0.4;
    gridContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    gridContext.clearRect(0, 0, size, size);
    const background = gridContext.createRadialGradient(center, center, 0, center, center, size / 2);
    background.addColorStop(0, '#102c24');
    background.addColorStop(1, '#040f10');
    gridContext.fillStyle = background;
    gridContext.fillRect(0, 0, size, size);
    gridContext.lineWidth = 0.7;
    gridContext.strokeStyle = '#75dda837';
    gridContext.font = '8px Consolas, monospace';
    for (let ring = 1; ring <= 4; ring++) {
      gridContext.beginPath();
      gridContext.arc(center, center, radius * ring / 4, 0, TAU);
      gridContext.stroke();
      if (ring < 4) {
        gridContext.fillStyle = '#79b8a065';
        gridContext.fillText(String(Math.round(range * ring / 4)), center + 4, center - radius * ring / 4 + 10);
      }
    }
    gridContext.setLineDash([2, 4]);
    gridContext.beginPath();
    gridContext.moveTo(center - radius, center);
    gridContext.lineTo(center + radius, center);
    gridContext.moveTo(center, center - radius);
    gridContext.lineTo(center, center + radius);
    gridContext.stroke();
    gridContext.setLineDash([]);
    for (let i = 0; i < 24; i++) {
      if (i % 6 === 0) continue;
      const angle = i * TAU / 24;
      const inner = radius + 2;
      const outer = radius + (i % 3 === 0 ? 6 : 4);
      gridContext.beginPath();
      gridContext.moveTo(center + Math.sin(angle) * inner, center - Math.cos(angle) * inner);
      gridContext.lineTo(center + Math.sin(angle) * outer, center - Math.cos(angle) * outer);
      gridContext.stroke();
    }
    gridContext.fillStyle = '#96d7b9';
    gridContext.font = '9px Consolas, monospace';
    gridContext.textAlign = 'center';
    gridContext.textBaseline = 'middle';
    const offset = Math.min(radius + 13, size / 2 - 8);
    for (const [label, x, y] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      gridContext.fillText(label, center + x * offset, center + y * offset);
    }
    rangeLabel.textContent = 'RNG ' + range + ' u';
  }

  function resize() {
    if (disposed) return;
    const nextSize = Math.round(canvas.getBoundingClientRect().width);
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    stage.style.setProperty('--radar-panel-height', panel.getBoundingClientRect().height + 'px');
    if (nextSize === size && nextRatio === ratio) return;
    size = nextSize;
    ratio = nextRatio;
    canvas.width = grid.width = Math.max(1, Math.round(size * ratio));
    canvas.height = grid.height = canvas.width;
    drawGrid();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resizeObserver.observe(panel);
  function movePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function leavePointer() { pointer = null; }
  function toggleCollapsed() {
    const collapsed = panel.dataset.collapsed !== 'true';
    panel.dataset.collapsed = String(collapsed);
    body.hidden = collapsed;
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand radar' : 'Collapse radar');
    collapseButton.title = collapsed ? 'Expand radar' : 'Collapse radar';
    pointer = null;
    resize();
  }
  collapseButton.addEventListener('click', toggleCollapsed);
  canvas.addEventListener('pointermove', movePointer);
  canvas.addEventListener('pointerdown', movePointer);
  canvas.addEventListener('pointerleave', leavePointer);
  resize();

  return {
    update(deltaTime, gunAzimuth, radarData, state) {
      if (disposed || !Number.isFinite(deltaTime) || deltaTime < 0) return;
      elapsed += deltaTime;
      sweep = (sweep + deltaTime * 1.15) % TAU;
      if (ratio !== Math.min(window.devicePixelRatio || 1, 2)) resize();
      const snapshot = radarData;
      let required = MIN_RANGE;
      for (const drone of snapshot) required = Math.max(required, drone.distance);
      const nextRange = !snapshot.length && !state.queued ? MIN_RANGE : Math.max(range, Math.ceil(required / 25) * 25);
      if (nextRange !== range) { range = nextRange; drawGrid(); previousCount = undefined; }
      const countText = snapshot.length + ' live / ' + state.queued + ' queued';
      if (previousCount !== countText) {
        count.textContent = countText;
        canvas.setAttribute('aria-label', 'Drone radar, north up, gun at center. ' + countText + '. Range ' + range + ' scene units.');
        previousCount = countText;
      }
      if (previousKills !== state.killed) {
        kills.textContent = state.killed + ' killed';
        previousKills = state.killed;
      }
      const liveIds = new Set(snapshot.map(drone => drone.id));
      for (const id of tracks.keys()) if (!liveIds.has(id)) tracks.delete(id);
      // Keep the header counts live while collapsed or hidden in fullscreen.
      if (body.hidden || !size) return;
      if (!context || !gridContext) {
        setDetail('Radar display unavailable');
        return;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, size, size);
      context.drawImage(grid, 0, 0, size, size);
      const center = size / 2;
      const radius = size * 0.4;
      context.save();
      context.beginPath();
      context.arc(center, center, radius, 0, TAU);
      context.clip();

      // A fading fan trails a narrow scan line; blip positions are always current.
      for (let i = 0; i < 28; i++) {
        const end = sweep - i * 0.025 - Math.PI / 2;
        context.beginPath();
        context.moveTo(center, center);
        context.arc(center, center, radius, end - 0.026, end);
        context.closePath();
        context.fillStyle = 'rgba(93, 255, 173, ' + (0.13 * (1 - i / 28)) + ')';
        context.fill();
      }
      context.strokeStyle = '#8cfac59c';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(center, center);
      context.lineTo(center + Math.sin(sweep) * radius, center - Math.cos(sweep) * radius);
      context.stroke();

      // Show the gun's current animated bearing as a small central arrow.
      context.save();
      context.translate(center, center);
      context.rotate(Number.isFinite(gunAzimuth) ? gunAzimuth : 0);
      context.fillStyle = '#e0fff1';
      context.beginPath();
      context.moveTo(0, -7);
      context.lineTo(-4, 4);
      context.lineTo(0, 2);
      context.lineTo(4, 4);
      context.closePath();
      context.fill();
      context.restore();

      let hovered = null;
      let hoverDistance = 10;
      for (const drone of snapshot) {
        const x = center + drone.pos.x / range * radius;
        const y = center - drone.pos.z / range * radius;
        let history = tracks.get(drone.id);
        if (!history) { history = []; tracks.set(drone.id, history); }
        if (!history.length || elapsed - history.at(-1).time >= 0.1) {
          history.push({ x: drone.pos.x, z: drone.pos.z, time: elapsed });
        }
        while (history.length && elapsed - history[0].time > 0.8) history.shift();
        const distance = drone.distance;
        const color = distance < 10 ? '#ffc477' : '#7bffbc';
        context.beginPath();
        history.forEach((point, index) => {
          const px = center + point.x / range * radius;
          const py = center - point.z / range * radius;
          if (index === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.lineTo(x, y);
        context.strokeStyle = distance < 10 ? '#ffc47750' : '#7bffbc50';
        context.lineWidth = 1.4;
        context.stroke();
        const bearing = Math.atan2(drone.pos.x, drone.pos.z);
        const sinceSweep = ((sweep - bearing) % TAU + TAU) % TAU;
        const brightness = Math.max(0.55, 1 - sinceSweep / 1.1);
        context.globalAlpha = brightness;
        context.shadowColor = color;
        context.shadowBlur = 6;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, distance < 10 ? 3 : 2.3, 0, TAU);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
        if (pointer) {
          const separation = Math.hypot(pointer.x - x, pointer.y - y);
          if (separation < hoverDistance) { hoverDistance = separation; hovered = { drone, x, y, distance }; }
        }
      }
      if (hovered) {
        context.strokeStyle = '#e0fff1';
        context.lineWidth = 1;
        context.beginPath();
        context.arc(hovered.x, hovered.y, 6, 0, TAU);
        context.stroke();
        setDetail('D' + String(hovered.drone.id).padStart(3, '0') + ' · ' + hovered.distance.toFixed(1) + ' u away · h ' + hovered.drone.pos.y.toFixed(1) + ' u');
      } else {
        setDetail(snapshot.length ? 'Hover a blip for distance / height' : state.queued ? 'Awaiting next drone launch' : 'Airspace clear');
      }
      context.restore();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      collapseButton.removeEventListener('click', toggleCollapsed);
      canvas.removeEventListener('pointermove', movePointer);
      canvas.removeEventListener('pointerdown', movePointer);
      canvas.removeEventListener('pointerleave', leavePointer);
      tracks.clear();
      stage.style.removeProperty('--radar-panel-height');
      canvas.width = canvas.height = grid.width = grid.height = 1;
    },
  };
}
