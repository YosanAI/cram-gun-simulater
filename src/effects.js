import * as THREE from 'three';

/**
 * Firing visuals and per-shot callback. The muzzle's local +Z points down the barrels.
 * Smoke and streaks leave that moving frame and continue in world space.
 * Scene audio is owned by the shared mixer in audio.js.
 */
export function createFiringEffects(scene, muzzle, { onShot = () => {} } = {}) {
  const SMOKE_COUNT = 40;
  const STREAK_COUNT = 28;
  const smokeParticles = createParticles(SMOKE_COUNT);
  const streakParticles = createParticles(STREAK_COUNT);
  const smokeAlpha = new Float32Array(SMOKE_COUNT);
  const streakAlpha = new Float32Array(STREAK_COUNT);
  const origin = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const localForward = new THREE.Vector3(0, 0, 1);
  let enabled = true;
  let disposed = false;
  let smokeCursor = 0;
  let streakCursor = 0;
  let smokeBudget = 0;
  let streakBudget = 0;
  let lastIntensity = 0;

  // A compact flame and hot central glow leave the barrel assembly readable.
  const flash = new THREE.Group();
  flash.name = 'Cosmetic muzzle flash';
  flash.visible = false;
  muzzle.add(flash);

  const flashTexture = createRadialTexture(false);
  const glowMaterial = new THREE.SpriteMaterial({
    map: flashTexture,
    color: 0xffb450,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.z = 0.09;
  glow.scale.setScalar(0.62);
  flash.add(glow);

  const coreMaterial = glowMaterial.clone();
  coreMaterial.color.set(0xfff4cb);
  const core = new THREE.Sprite(coreMaterial);
  core.position.z = 0.07;
  core.scale.setScalar(0.23);
  flash.add(core);

  const flameGeometry = new THREE.ConeGeometry(0.16, 0.78, 9, 1, true);
  flameGeometry.rotateX(Math.PI / 2);
  flameGeometry.translate(0, 0, 0.39);
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
      void main() {
        float grain = 0.70 + 0.30 * sin(vUv.x * 57.0 + vUv.y * 38.0 - uTime * 113.0);
        float falloff = pow(max(0.0, 1.0 - vUv.y), 0.65);
        vec3 orange = vec3(1.0, 0.19, 0.018);
        vec3 hot = vec3(1.0, 0.93, 0.60);
        vec3 color = mix(orange, hot, pow(1.0 - vUv.y, 3.0));
        gl_FragColor = vec4(color, grain * falloff * uIntensity * 0.62);
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flame = new THREE.Mesh(flameGeometry, flameMaterial);
  flash.add(flame);

  const flashLight = new THREE.PointLight(0xffc078, 0, 4.5, 2);
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

  // Sparse orange light streaks are an illustrative firing cue, not ballistics.
  const streakGeometry = new THREE.CylinderGeometry(1, 1, 1, 4, 1, false);
  streakGeometry.rotateX(Math.PI / 2);
  streakGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(streakAlpha, 1));
  const streakMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute float aOpacity;
      varying float vOpacity;
      varying float vAlong;
      void main() {
        vOpacity = aOpacity;
        vAlong = position.z + 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vOpacity;
      varying float vAlong;
      void main() {
        float taper = sin(clamp(vAlong, 0.0, 1.0) * 3.14159265);
        vec3 color = mix(vec3(1.0, 0.20, 0.025), vec3(1.0, 0.76, 0.28), vAlong);
        gl_FragColor = vec4(color, vOpacity * (0.35 + 0.65 * taper));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const streaks = new THREE.InstancedMesh(streakGeometry, streakMaterial, STREAK_COUNT);
  streaks.name = 'Illustrative firing streaks';
  streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streakGeometry.attributes.aOpacity.setUsage(THREE.DynamicDrawUsage);
  streaks.frustumCulled = false;
  scene.add(streaks);

  // Hide all unused instances from the first frame.
  matrix.makeScale(0, 0, 0);
  for (let i = 0; i < SMOKE_COUNT; i++) smoke.setMatrixAt(i, matrix);
  for (let i = 0; i < STREAK_COUNT; i++) streaks.setMatrixAt(i, matrix);
  smoke.instanceMatrix.needsUpdate = true;
  streaks.instanceMatrix.needsUpdate = true;

  function emitSmoke() {
    const particle = smokeParticles[smokeCursor];
    smokeCursor = (smokeCursor + 1) % SMOKE_COUNT;
    particle.age = 0;
    particle.life = 1.4 + Math.random() * 1.2;
    particle.size = 0.14 + Math.random() * 0.08;
    particle.position.copy(origin).addScaledVector(forward, 0.12);
    particle.velocity.copy(forward).multiplyScalar(0.45 + Math.random() * 0.45);
    particle.velocity.x += 0.08 + Math.random() * 0.10;
    particle.velocity.y += 0.21 + Math.random() * 0.12;
    particle.velocity.z += (Math.random() - 0.5) * 0.08;
  }

  function emitStreak() {
    const particle = streakParticles[streakCursor];
    streakCursor = (streakCursor + 1) % STREAK_COUNT;
    particle.age = 0;
    particle.life = 0.29 + Math.random() * 0.11;
    particle.size = 0.8 + Math.random() * 1.1;
    particle.position.copy(origin).addScaledVector(forward, 0.55);
    particle.velocity.copy(forward).multiplyScalar(57 + Math.random() * 15);
    particle.orientation.copy(orientation);
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

      const flicker = 0.70 + 0.18 * Math.sin(now * 137) + 0.12 * Math.sin(now * 229);
      flash.scale.set(0.85 + flicker * 0.18, 0.85 + flicker * 0.18, 0.72 + flicker * 0.40);
      glowMaterial.opacity = level * flicker * 0.70;
      coreMaterial.opacity = level * (0.70 + flicker * 0.30);
      flameMaterial.uniforms.uTime.value = now;
      flameMaterial.uniforms.uIntensity.value = level * flicker;
      flashLight.intensity = 10 * level * flicker;

      // The first visual streak appears immediately, including short taps.
      if (lastIntensity <= 0.01) {
        emitStreak();
        emitSmoke();
      }
      smokeBudget += elapsed * 8 * level;
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

    for (let i = 0; i < STREAK_COUNT; i++) {
      const particle = streakParticles[i];
      particle.age += elapsed;
      if (particle.age >= particle.life) {
        streakAlpha[i] = 0;
        continue;
      }
      const progress = particle.age / particle.life;
      particle.position.addScaledVector(particle.velocity, elapsed);
      scale.set(0.012, 0.012, particle.size * (0.80 + progress * 0.45));
      matrix.compose(particle.position, particle.orientation, scale);
      streaks.setMatrixAt(i, matrix);
      streakAlpha[i] = Math.pow(1 - progress, 0.6) * 0.84;
    }

    smoke.instanceMatrix.needsUpdate = true;
    streaks.instanceMatrix.needsUpdate = true;
    smokeGeometry.attributes.aOpacity.needsUpdate = true;
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
    scene.remove(smoke, streaks);
    flashTexture.dispose();
    smokeTexture.dispose();
    flameGeometry.dispose();
    smokeGeometry.dispose();
    streakGeometry.dispose();
    glowMaterial.dispose();
    coreMaterial.dispose();
    flameMaterial.dispose();
    smokeMaterial.dispose();
    streakMaterial.dispose();
    smoke.dispose();
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
