import * as THREE from 'three';

const LIFETIME = 5;
const FIRE_LIFETIME = 1.2;
const SMOKE_PER_BURST = 12;
const SPARKS_PER_BURST = 48;
const FLAMES_PER_BURST = 5;

/** Bounded fireballs, flame lobes, shockwaves, smoke, and sparks; no external textures. */
export function createImpactEffects(scene, { random = Math.random, capacity = 32 } = {}) {
  const group = new THREE.Group();
  group.name = 'Drone impact effects';
  scene.add(group);
  const bursts = [];
  const matrix = new THREE.Matrix4();
  const orientation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  let disposed = false;

  function billboards(count, kind = 'fire') {
    const isSmoke = kind === 'smoke';
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAge', new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
      uniforms: { uSmoke: { value: isSmoke ? 1 : 0 }, uCore: { value: kind === 'core' ? 1 : 0 } },
      vertexShader: `
        attribute float aOpacity;
        attribute float aAge;
        varying vec2 vUv;
        varying float vOpacity;
        varying float vAge;
        void main() {
          vUv = uv;
          vOpacity = aOpacity;
          vAge = aAge;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0., 0., 0., 1.);
          center.xy += position.xy * length(instanceMatrix[0].xyz);
          gl_Position = projectionMatrix * center;
        }
      `,
      fragmentShader: `
        uniform float uSmoke;
        uniform float uCore;
        varying vec2 vUv;
        varying float vOpacity;
        varying float vAge;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 cell = floor(p);
          vec2 f = fract(p);
          f = f * f * (3. - 2. * f);
          return mix(mix(hash(cell), hash(cell + vec2(1., 0.)), f.x),
                     mix(hash(cell + vec2(0., 1.)), hash(cell + vec2(1., 1.)), f.x), f.y);
        }
        void main() {
          float radius = length(vUv - .5) * 2.;
          float grain = noise(vUv * 9. + vec2(vAge * 1.7, -vAge * 2.5));
          float detail = noise(vUv * 23. - vAge * .9);
          float edge = 1. - smoothstep(.18, 1., radius + (grain - .5) * .24);
          float alpha = edge * (.55 + .45 * detail) * vOpacity;
          if (uCore > .5) alpha = pow(max(0., 1. - radius), 2.) * vOpacity;
          if (alpha < .002) discard;
          float heat = clamp((1. - radius) * (.6 + .65 * grain), 0., 1.);
          vec3 fire = mix(vec3(1., .12, .008), vec3(1., .92, .52), heat);
          vec3 color = mix(fire, mix(vec3(.13, .15, .17), vec3(.31, .33, .34), grain), uSmoke);
          color = mix(color, vec3(1., .98, .85), uCore);
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true, depthWrite: false, toneMapped: false,
      blending: isSmoke ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = isSmoke ? 4 : 5;
    group.add(mesh);
    return mesh;
  }
  const flash = billboards(capacity);
  flash.name = 'Impact fireballs';
  const core = billboards(capacity, 'core');
  core.name = 'Impact white-hot cores';
  const flames = billboards(capacity * FLAMES_PER_BURST);
  flames.name = 'Impact flame lobes';
  const smoke = billboards(capacity * SMOKE_PER_BURST, 'smoke');
  smoke.name = 'Impact smoke';

  const ringGeometry = new THREE.RingGeometry(0.94, 1, 64);
  ringGeometry.rotateX(-Math.PI / 2);
  ringGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
  const ringMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aOpacity;
      varying float vOpacity;
      void main() {
        vOpacity = aOpacity;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.);
      }
    `,
    fragmentShader: `
      varying float vOpacity;
      void main() {
        gl_FragColor = vec4(1., .7, .3, vOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const shockwave = new THREE.InstancedMesh(ringGeometry, ringMaterial, capacity);
  shockwave.name = 'Impact shockwaves';
  shockwave.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shockwave.frustumCulled = false;
  shockwave.count = 0;
  shockwave.renderOrder = 3;
  group.add(shockwave);

  const sparkGeometry = new THREE.BufferGeometry();
  const sparkCount = capacity * SPARKS_PER_BURST;
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(sparkCount), 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sparkCount), 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setDrawRange(0, 0);
  const sparkMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aOpacity;
      attribute float aSize;
      varying float vOpacity;
      void main() {
        vOpacity = aOpacity;
        vec4 p = modelViewMatrix * vec4(position, 1.);
        gl_PointSize = clamp(aSize * 280. / max(.1, -p.z), 1., 24.);
        gl_Position = projectionMatrix * p;
      }
    `,
    fragmentShader: `
      varying float vOpacity;
      void main() {
        float alpha = max(0., 1. - length(gl_PointCoord - .5) * 2.) * vOpacity;
        if (alpha < .002) discard;
        gl_FragColor = vec4(1., .63, .16, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  sparks.name = 'Impact sparks';
  sparks.frustumCulled = false;
  sparks.renderOrder = 5;
  group.add(sparks);
  const light = new THREE.PointLight(0xffb65b, 0, 20, 2);
  group.add(light);

  function setBillboard(mesh, index, center, size, opacity, age) {
    scale.setScalar(size);
    mesh.setMatrixAt(index, matrix.compose(center, orientation, scale));
    mesh.geometry.attributes.aOpacity.setX(index, opacity);
    mesh.geometry.attributes.aAge.setX(index, age);
  }

  function clear() {
    bursts.length = 0;
    flash.count = core.count = flames.count = smoke.count = shockwave.count = 0;
    sparkGeometry.setDrawRange(0, 0);
    light.intensity = 0;
  }

  return {
    burst(center, initialAge = 0) {
      if (disposed || initialAge >= LIFETIME) return;
      if (bursts.length === capacity) bursts.shift();
      const directions = Array.from({ length: SPARKS_PER_BURST }, () => {
        const azimuth = random() * Math.PI * 2;
        const rise = 0.2 + random() * 0.8;
        const horizontal = Math.sqrt(1 - rise * rise);
        return new THREE.Vector3(Math.sin(azimuth) * horizontal, rise, Math.cos(azimuth) * horizontal)
          .multiplyScalar(5 + random() * 8);
      });
      bursts.push({ center: center.clone(), age: initialAge, directions });
    },
    update(deltaTime) {
      if (disposed || !Number.isFinite(deltaTime) || deltaTime < 0) return;
      for (let i = bursts.length - 1; i >= 0; i--) {
        bursts[i].age += deltaTime;
        if (bursts[i].age >= LIFETIME) bursts.splice(i, 1);
      }
      let flashes = 0;
      let cores = 0;
      let lobes = 0;
      let rings = 0;
      let puffs = 0;
      let particles = 0;
      light.intensity = 0;
      for (const burst of bursts) {
        const t = burst.age;
        if (t < FIRE_LIFETIME) {
          const expansion = 1 - Math.exp(-t * 7);
          const fade = 1 - t / FIRE_LIFETIME;
          position.copy(burst.center).y += 1 + t * 1.8;
          setBillboard(flash, flashes++, position, 4.5 + expansion * 7, fade * 1.35, t);
          light.position.copy(position);
          light.intensity = Math.max(light.intensity, fade * 22);
          for (let i = 0; i < FLAMES_PER_BURST; i++) {
            position.copy(burst.center).addScaledVector(burst.directions[i], 0.04 + t * 0.1);
            position.y += 0.6 + t * 1.5;
            setBillboard(flames, lobes++, position, 2.5 + expansion * (3 + i * 0.3), fade * 0.75, t + i * 0.17);
          }
        }
        if (t < 0.3) {
          position.copy(burst.center).y += 1;
          setBillboard(core, cores++, position, 3.5 + t * 7, (1 - t / 0.3) * 2, t);
        }
        if (t < 0.85) {
          position.copy(burst.center).y += 0.05;
          scale.setScalar(1.2 + t * 19);
          shockwave.setMatrixAt(rings, matrix.compose(position, orientation, scale));
          ringGeometry.attributes.aOpacity.setX(rings++, (1 - t / 0.85) * 0.75);
        }
        for (let i = 0; i < SMOKE_PER_BURST; i++) {
          position.copy(burst.center).addScaledVector(burst.directions[i], t * 0.1);
          position.y += 0.7 + t * (0.9 + i * 0.045);
          const opacity = Math.min(1, t * 2.5) * (1 - t / LIFETIME) * 0.48;
          setBillboard(smoke, puffs++, position, 1.6 + t * (1.7 + i * 0.06), opacity, t + i * 0.23);
        }
        if (t < 1.8) {
          for (const direction of burst.directions) {
            position.copy(burst.center).addScaledVector(direction, t);
            position.y = Math.max(0.06, position.y + 0.7 - 3.8 * t * t);
            sparkGeometry.attributes.position.setXYZ(particles, position.x, position.y, position.z);
            sparkGeometry.attributes.aOpacity.setX(particles, 1 - t / 1.8);
            sparkGeometry.attributes.aSize.setX(particles, 0.2);
            particles++;
          }
        }
      }
      flash.count = flashes;
      core.count = cores;
      flames.count = lobes;
      shockwave.count = rings;
      smoke.count = puffs;
      for (const mesh of [flash, core, flames, smoke, shockwave]) {
        mesh.instanceMatrix.needsUpdate = true;
        for (const attribute of Object.values(mesh.geometry.attributes)) {
          if (attribute.isInstancedBufferAttribute) attribute.needsUpdate = true;
        }
      }
      for (const attribute of Object.values(sparkGeometry.attributes)) attribute.needsUpdate = true;
      sparkGeometry.setDrawRange(0, particles);
    },
    clear,
    getActiveCount: () => bursts.length,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      scene.remove(group);
      for (const mesh of [flash, core, flames, smoke, shockwave, sparks]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        if (mesh.isInstancedMesh) mesh.dispose();
      }
      light.dispose();
    },
  };
}
