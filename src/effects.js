import * as THREE from 'three';

export const FIRING_VISUALS = Object.freeze({
  streakCount: 80, cameraFar: 6000,
});
const TRACER_STYLE = Object.freeze({
  speed: 1100, lifetime: 1.3, width: 0.08, length: 18,
  minPixelWidth: 3, minPixelLength: 4, brightness: 0.8,
});

/**
 * Firing visuals and per-shot callback. The muzzle's local +Z points down the barrels.
 * Smoke and streaks leave that moving frame and continue in world space.
 * Scene audio is owned by the shared mixer in audio.js.
 */
export function createFiringEffects(scene, muzzle, { onShot = () => {} } = {}) {
  const SMOKE_COUNT = 56;
  const SPARK_COUNT = 64;
  const STREAK_COUNT = FIRING_VISUALS.streakCount;
  const smokeParticles = createParticles(SMOKE_COUNT);
  const sparkParticles = createParticles(SPARK_COUNT);
  const streakParticles = createParticles(STREAK_COUNT);
  const smokeAlpha = new Float32Array(SMOKE_COUNT);
  const sparkAlpha = new Float32Array(SPARK_COUNT);
  const streakAlpha = new Float32Array(STREAK_COUNT);
  const origin = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const localForward = new THREE.Vector3(0, 0, 1);
  const streakCenter = new THREE.Vector3();
  let enabled = true;
  let disposed = false;
  let smokeCursor = 0;
  let sparkCursor = 0;
  let streakCursor = 0;
  let smokeBudget = 0;
  let streakBudget = 0;
  let lastIntensity = 0;

  // A white-hot blast, turbulent crossed jets, and faint pressure pulses.
  const flash = new THREE.Group();
  flash.name = 'Cosmetic muzzle flash';
  flash.visible = false;
  muzzle.add(flash);

  const flashTexture = createRadialTexture(false);
  const glowMaterial = new THREE.SpriteMaterial({
    map: flashTexture,
    color: 0xffa336,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.z = 0.22;
  glow.scale.setScalar(1.45);
  flash.add(glow);

  const coreMaterial = glowMaterial.clone();
  coreMaterial.color.set(0xffffed);
  const core = new THREE.Sprite(coreMaterial);
  core.position.z = 0.12;
  core.scale.setScalar(0.54);
  flash.add(core);

  const plumeMaterial = glowMaterial.clone();
  plumeMaterial.color.set(0xffd778);
  const plume = new THREE.Sprite(plumeMaterial);
  plume.position.z = 0.8;
  plume.scale.setScalar(0.9);
  flash.add(plume);

  const flameGeometry = new THREE.PlaneGeometry(1.3, 2.1);
  flameGeometry.rotateX(Math.PI / 2);
  flameGeometry.translate(0, 0, 1.05);
  const flameMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      varying vec2 vUv;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 cell = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
                   mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
      }
      void main() {
        float along = vUv.y;
        vec2 flow = vec2(vUv.x * 7.0, along * 9.0 - uTime * 37.0);
        float turbulence = noise(flow) * 0.65 + noise(flow * 2.1 + uTime * 5.0) * 0.35;
        float width = mix(0.57, 0.04, pow(along, 0.75));
        width += sin(along * 24.0 - uTime * 51.0) * 0.045;
        float across = abs(vUv.x * 2.0 - 1.0 + (turbulence - 0.5) * along * 0.34);
        float edge = 1.0 - smoothstep(width * 0.5, width + 0.12, across);
        float tip = 1.0 - smoothstep(0.66, 1.0, along + (turbulence - 0.5) * 0.14);
        float hot = exp(-across * across * 24.0) * (1.0 - along);
        vec3 color = mix(vec3(1.0, 0.24, 0.025), vec3(1.0, 0.79, 0.25), turbulence);
        color = mix(color, vec3(1.0, 1.0, 0.92), hot);
        float alpha = edge * tip * (0.55 + turbulence * 0.45) * uIntensity;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  for (let i = 0; i < 3; i++) {
    const jet = new THREE.Mesh(flameGeometry, flameMaterial);
    jet.rotation.z = i * Math.PI / 3;
    flash.add(jet);
  }

  const ringGeometry = new THREE.RingGeometry(0.2, 0.34, 48);
  const ringMaterials = [];
  const rings = [];
  for (let i = 0; i < 2; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffdfa3, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeometry, material);
    ringMaterials.push(material);
    rings.push(ring);
    flash.add(ring);
  }

  const flashLight = new THREE.PointLight(0xffca83, 0, 7, 2);
  flashLight.position.z = 0.26;
  flash.add(flashLight);

  // Billboard smoke uses one instanced draw, with no camera argument required.
  const smokeTexture = createRadialTexture(true);
  const smokeGeometry = new THREE.PlaneGeometry(1, 1);
  smokeGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(smokeAlpha, 1));
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: smokeTexture } },
    vertexShader: /* glsl */ `
      attribute float aOpacity;
      varying vec2 vUv;
      varying float vOpacity;
      void main() {
        vUv = uv;
        vOpacity = aOpacity;
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float size = length(instanceMatrix[0].xyz);
        center.xy += position.xy * size;
        gl_Position = projectionMatrix * center;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vOpacity;
      void main() {
        float alpha = texture2D(uMap, vUv).a * vOpacity;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(vec3(0.46, 0.48, 0.49), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const smoke = new THREE.InstancedMesh(smokeGeometry, smokeMaterial, SMOKE_COUNT);
  smoke.name = 'Muzzle smoke';
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smokeGeometry.attributes.aOpacity.setUsage(THREE.DynamicDrawUsage);
  smoke.frustumCulled = false;
  smoke.renderOrder = 4;
  scene.add(smoke);

  const sparkGeometry = new THREE.PlaneGeometry(1, 1);
  sparkGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(sparkAlpha, 1));
  const sparkMaterial = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: flashTexture } },
    vertexShader: smokeMaterial.vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vOpacity;
      void main() {
        float alpha = texture2D(uMap, vUv).a * vOpacity;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(vec3(1.0, 0.76, 0.28), alpha);
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  });
  const sparks = new THREE.InstancedMesh(sparkGeometry, sparkMaterial, SPARK_COUNT);
  sparks.name = 'Muzzle sparks';
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparkGeometry.attributes.aOpacity.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  sparks.renderOrder = 5;
  scene.add(sparks);

  // Short camera-facing tracer ribbons that stay readable at a distance.
  // These remain cosmetic: gameplay hits are still the original muzzle hitscan.
  const streakGeometry = new THREE.PlaneGeometry(1, 1);
  streakGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(streakAlpha, 1));
  const streakMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uViewport: { value: new THREE.Vector2(1024, 768) },
      uMinWidth: { value: TRACER_STYLE.minPixelWidth },
      uMinLength: { value: TRACER_STYLE.minPixelLength },
      uNear: { value: 0.08 },
    },
    vertexShader: /* glsl */ `
      attribute float aOpacity;
      uniform vec2 uViewport;
      uniform float uMinWidth;
      uniform float uMinLength;
      uniform float uNear;
      varying float vOpacity;
      varying vec2 vUv;
      void main() {
        vOpacity = aOpacity;
        vUv = uv;
        mat4 viewInstance = modelViewMatrix * instanceMatrix;
        vec4 tailView = viewInstance * vec4(0.0, 0.0, -0.5, 1.0);
        vec4 headView = viewInstance * vec4(0.0, 0.0, 0.5, 1.0);
        // Fast tracers can cross the camera in one frame. Clip the segment
        // before projecting so an endpoint behind the eye cannot inflate it.
        float nearZ = -max(uNear, 0.001);
        if (tailView.z > nearZ && headView.z > nearZ) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        if (tailView.z > nearZ) tailView = mix(tailView, headView, (nearZ - tailView.z) / (headView.z - tailView.z));
        if (headView.z > nearZ) headView = mix(headView, tailView, (nearZ - headView.z) / (tailView.z - headView.z));
        vec4 tail = projectionMatrix * tailView;
        vec4 head = projectionMatrix * headView;
        vec2 projected = (head.xy / max(head.w, 0.01) - tail.xy / max(tail.w, 0.01)) * uViewport * 0.5;
        float projectedLength = length(projected);
        vec2 direction = projectedLength > 0.001 ? projected / projectedLength : vec2(0.0, 1.0);
        // Preserve the quad's front-facing winding in view space.
        vec2 side = vec2(direction.y, -direction.x);
        vec4 center = mix(tailView, headView, uv.y);
        vec4 clip = projectionMatrix * center;
        float worldWidth = length(instanceMatrix[0].xyz);
        float pixelWidth = worldWidth * projectionMatrix[1][1] * uViewport.y * 0.5 / max(-center.z, 0.1);
        vec2 offset = side * position.x * max(pixelWidth, uMinWidth);
        offset += direction * position.y * max(0.0, uMinLength - projectedLength);
        clip.xy += offset * 2.0 / uViewport * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vOpacity;
      varying vec2 vUv;
      void main() {
        float across = abs(vUv.x * 2.0 - 1.0);
        float core = exp(-across * across * 36.0);
        float body = exp(-across * across * 6.0);
        float halo = exp(-across * across * 2.5) * (1.0 - across);
        float taper = pow(max(0.0, sin(vUv.y * 3.14159265)), 0.35);
        float alpha = min(1.0, core + body * 0.75 + halo * 0.2) * taper * vOpacity;
        if (alpha < 0.004) discard;
        vec3 color = mix(vec3(1.0, 0.32, 0.035), vec3(1.0, 0.97, 0.78), core);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const streaks = new THREE.InstancedMesh(streakGeometry, streakMaterial, STREAK_COUNT);
  streaks.name = 'Illustrative firing streaks';
  streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streakGeometry.attributes.aOpacity.setUsage(THREE.DynamicDrawUsage);
  streaks.frustumCulled = false;
  streaks.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getSize(streakMaterial.uniforms.uViewport.value);
    streakMaterial.uniforms.uNear.value = camera.near;
  };
  scene.add(streaks);

  // Hide all unused instances from the first frame.
  matrix.makeScale(0, 0, 0);
  for (let i = 0; i < SMOKE_COUNT; i++) smoke.setMatrixAt(i, matrix);
  for (let i = 0; i < SPARK_COUNT; i++) sparks.setMatrixAt(i, matrix);
  for (let i = 0; i < STREAK_COUNT; i++) streaks.setMatrixAt(i, matrix);
  smoke.instanceMatrix.needsUpdate = true;
  sparks.instanceMatrix.needsUpdate = true;
  streaks.instanceMatrix.needsUpdate = true;

  function emitSmoke() {
    const particle = smokeParticles[smokeCursor];
    smokeCursor = (smokeCursor + 1) % SMOKE_COUNT;
    particle.age = 0;
    particle.life = 1.4 + Math.random() * 1.2;
    particle.size = 0.20 + Math.random() * 0.10;
    particle.position.copy(origin).addScaledVector(forward, 0.12);
    particle.velocity.copy(forward).multiplyScalar(0.45 + Math.random() * 0.45);
    particle.velocity.x += 0.08 + Math.random() * 0.10;
    particle.velocity.y += 0.21 + Math.random() * 0.12;
    particle.velocity.z += (Math.random() - 0.5) * 0.08;
  }

  function emitSparks() {
    for (let i = 0; i < 3; i++) {
      const particle = sparkParticles[sparkCursor];
      sparkCursor = (sparkCursor + 1) % SPARK_COUNT;
      particle.age = 0;
      particle.life = 0.18 + Math.random() * 0.24;
      particle.size = 0.06 + Math.random() * 0.08;
      particle.position.copy(origin).addScaledVector(forward, 0.08);
      particle.velocity.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, 10 + Math.random() * 15)
        .applyQuaternion(orientation);
    }
  }

  function emitStreak() {
    const particle = streakParticles[streakCursor];
    streakCursor = (streakCursor + 1) % STREAK_COUNT;
    particle.age = 0;
    particle.distance = 0;
    particle.position.copy(origin).addScaledVector(forward, 0.1);
    particle.velocity.copy(forward);
    particle.orientation.copy(orientation);
    emitSparks();
    // Each emitted streak represents one instantaneous gameplay shot.
    onShot(origin, forward);
  }

  function update(dt, time, intensity = 0) {
    if (disposed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    const now = Number.isFinite(time) ? time : 0;
    const level = enabled && Number.isFinite(intensity) ? THREE.MathUtils.clamp(intensity, 0, 1) : 0;
    const firing = level > 0.01;
    flash.visible = firing;

    if (firing) {
      // Ancestor transforms may have changed since the previous render.
      muzzle.updateWorldMatrix(true, false);
      muzzle.getWorldPosition(origin);
      muzzle.getWorldQuaternion(orientation);
      forward.copy(localForward).applyQuaternion(orientation);

      const flicker = 0.78 + 0.14 * Math.sin(now * 137) + 0.08 * Math.sin(now * 229);
      flash.scale.set(0.85 + flicker * 0.32, 0.85 + flicker * 0.32, 0.75 + flicker * 0.55);
      glowMaterial.opacity = level * flicker * 0.82;
      coreMaterial.opacity = level * (0.85 + flicker * 0.15);
      plumeMaterial.opacity = level * flicker * 0.5;
      flameMaterial.uniforms.uTime.value = now;
      flameMaterial.uniforms.uIntensity.value = level * flicker;
      flashLight.intensity = 28 * level * flicker;
      for (let i = 0; i < rings.length; i++) {
        const phase = (now * 14 + i * 0.5) % 1;
        rings[i].position.z = 0.15 + phase * 1.45;
        rings[i].scale.setScalar(0.65 + phase * 0.85);
        ringMaterials[i].opacity = level * flicker * (1 - phase) * 0.16;
      }

      // The first visual streak appears immediately, including short taps.
      if (lastIntensity <= 0.01) {
        emitStreak();
        emitSmoke();
      }
      smokeBudget += elapsed * 12 * level;
      streakBudget += elapsed * 19 * level;
      while (smokeBudget >= 1) { emitSmoke(); smokeBudget -= 1; }
      // Roundoff at a shot boundary must not change the count with frame size.
      while (streakBudget >= 1 - 1e-9) {
        emitStreak();
        streakBudget = Math.max(0, streakBudget - 1);
      }
    } else {
      flashLight.intensity = 0;
      smokeBudget = 0;
      streakBudget = 0;
    }

    for (let i = 0; i < SMOKE_COUNT; i++) {
      const particle = smokeParticles[i];
      particle.age += elapsed;
      if (particle.age >= particle.life) {
        smokeAlpha[i] = 0;
        continue;
      }
      const progress = particle.age / particle.life;
      particle.position.addScaledVector(particle.velocity, elapsed);
      particle.velocity.multiplyScalar(Math.exp(-0.55 * elapsed));
      particle.velocity.y += 0.12 * elapsed;
      const diameter = particle.size + progress * 0.94;
      scale.setScalar(diameter);
      matrix.compose(particle.position, identity, scale);
      smoke.setMatrixAt(i, matrix);
      smokeAlpha[i] = Math.sin(progress * Math.PI) * (1 - progress) * 0.26;
    }

    for (let i = 0; i < SPARK_COUNT; i++) {
      const particle = sparkParticles[i];
      particle.age += elapsed;
      if (particle.age >= particle.life) {
        sparkAlpha[i] = 0;
        continue;
      }
      const progress = particle.age / particle.life;
      particle.position.addScaledVector(particle.velocity, elapsed);
      particle.velocity.y -= 3 * elapsed;
      scale.setScalar(particle.size * (1.2 - progress * 0.4));
      matrix.compose(particle.position, identity, scale);
      sparks.setMatrixAt(i, matrix);
      sparkAlpha[i] = Math.pow(1 - progress, 0.6) * 0.95;
    }

    for (let i = 0; i < STREAK_COUNT; i++) {
      const particle = streakParticles[i];
      particle.age += elapsed;
      if (particle.age >= TRACER_STYLE.lifetime) {
        particle.age = Infinity;
        streakAlpha[i] = 0;
        continue;
      }
      const progress = particle.age / TRACER_STYLE.lifetime;
      const travel = TRACER_STYLE.speed * elapsed;
      const firstFrame = particle.distance === 0;
      particle.position.addScaledVector(particle.velocity, travel);
      particle.distance += travel;
      // Cover the initial frame's travel so fast shots are visible leaving
      // the muzzle instead of skipping the nearby view between frames.
      const length = Math.min(particle.distance, Math.max(TRACER_STYLE.length, firstFrame ? travel : 0));
      streakCenter.copy(particle.position).addScaledVector(particle.velocity, -length * 0.5);
      scale.set(TRACER_STYLE.width, TRACER_STYLE.width, length);
      matrix.compose(streakCenter, particle.orientation, scale);
      streaks.setMatrixAt(i, matrix);
      // Hold the bright core through most of the flight; fade only at the end.
      streakAlpha[i] = (1 - THREE.MathUtils.smoothstep(progress, 0.75, 1)) * TRACER_STYLE.brightness;
    }

    smoke.instanceMatrix.needsUpdate = true;
    sparks.instanceMatrix.needsUpdate = true;
    streaks.instanceMatrix.needsUpdate = true;
    smokeGeometry.attributes.aOpacity.needsUpdate = true;
    sparkGeometry.attributes.aOpacity.needsUpdate = true;
    streakGeometry.attributes.aOpacity.needsUpdate = true;
    lastIntensity = level;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) {
      flash.visible = false;
      flashLight.intensity = 0;
      smokeBudget = 0;
      streakBudget = 0;
      lastIntensity = 0;
    }
  }

  function dispose() {
    if (disposed) return;
    setEnabled(false);
    disposed = true;
    muzzle.remove(flash);
    scene.remove(smoke, sparks, streaks);
    flashTexture.dispose();
    smokeTexture.dispose();
    flameGeometry.dispose();
    ringGeometry.dispose();
    smokeGeometry.dispose();
    sparkGeometry.dispose();
    streakGeometry.dispose();
    glowMaterial.dispose();
    coreMaterial.dispose();
    plumeMaterial.dispose();
    for (const material of ringMaterials) material.dispose();
    flameMaterial.dispose();
    smokeMaterial.dispose();
    sparkMaterial.dispose();
    streakMaterial.dispose();
    smoke.dispose();
    sparks.dispose();
    streaks.dispose();
  }

  return { update, setEnabled, dispose };
}

function createParticles(count) {
  return Array.from({ length: count }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    age: Infinity,
    life: 0,
    size: 0,
    distance: 0,
  }));
}

/** Small procedural textures keep the effects entirely self-contained. */
function createRadialTexture(smoke) {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const radius = Math.sqrt(nx * nx + ny * ny);
      const i = (y * size + x) * 4;
      let alpha;
      if (smoke) {
        const noise = Math.sin(nx * 13 + Math.sin(ny * 8)) * Math.cos(ny * 11 + nx * 3);
        const edge = Math.max(0, 1 - radius + noise * 0.065);
        alpha = Math.min(1, Math.pow(edge, 1.8) * (0.83 + noise * 0.17));
      } else {
        const angle = Math.atan2(ny, nx);
        const rays = 0.85 + Math.pow(Math.abs(Math.cos(angle * 3)), 14) * 0.15;
        alpha = Math.exp(-radius * radius * 8) * Math.max(0, 1 - radius) * rays;
      }
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = Math.round(THREE.MathUtils.clamp(alpha, 0, 1) * 255);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
