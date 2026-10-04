import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural exterior study of a naval Phalanx Block 1B.
 *
 * Coordinates: Y is up; the cannon points along +Z; X is starboard.
 * The dimensions below establish convincing visual proportions, rather than
 * engineering measurements. No interior mechanisms or fire-control model are
 * represented. Static geometry is merged by material within each movable joint.
 */
const PI = Math.PI;
const TAU = PI * 2;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const PIVOT_HEIGHT = 2.08;
const AZIMUTH_HEIGHT = 1.02;
const GUN_HEIGHT = -0.065;
const BARREL_ROOT = 1.08;
const BARREL_LENGTH = 2.04;

function makeMaterials() {
  const standard = (name, color, metalness, roughness, extra = {}) => {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
    material.name = name;
    return material;
  };
  return {
    ivory: standard('Warm naval white', 0xe1e4df, 0.24, 0.41),
    radome: standard('Fiberglass radar cover', 0xebece5, 0.045, 0.47),
    pale: standard('Pale gray castings', 0xaeb9b8, 0.5, 0.38),
    gray: standard('Naval gray chassis', 0x7e9298, 0.62, 0.4),
    darker: standard('Deep gray recesses', 0x36464f, 0.55, 0.49),
    gunmetal: standard('Machined gunmetal', 0x35424b, 0.9, 0.3),
    barrel: standard('Barrel steel', 0x242d35, 0.87, 0.31),
    steel: standard('Exposed stainless steel', 0x9aaab3, 0.9, 0.26),
    aluminum: standard('Brushed aluminum', 0xc1c8c8, 0.86, 0.3),
    rubber: standard('Seals and cable jackets', 0x171e22, 0.06, 0.83),
    black: standard('Optical and barrel interiors', 0x060b10, 0.12, 0.54),
    red: standard('Maintenance red', 0xb9372d, 0.25, 0.44),
    yellow: standard('Safety yellow', 0xdcad3d, 0.15, 0.46),
    lens: new THREE.MeshPhysicalMaterial({
      name: 'Blue optical glass', color: 0x124d6c, metalness: 0.52,
      roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.055,
      emissive: 0x062a37, emissiveIntensity: 0.18,
    }),
    irLens: new THREE.MeshPhysicalMaterial({
      name: 'Infrared optical glass', color: 0x2a1735, metalness: 0.72,
      roughness: 0.11, clearcoat: 1, clearcoatRoughness: 0.05,
      emissive: 0x261422, emissiveIntensity: 0.1,
    }),
  };
}

/** Material batching prevents hundreds of small fasteners becoming draw calls. */
class PartBuilder {
  constructor(parent) {
    this.parent = parent;
    this.batches = new Map();
    this.transform = new THREE.Object3D();
    this.parts = 0;
  }

  add(name, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
    const t = this.transform;
    t.position.fromArray(position);
    if (rotation.isQuaternion) t.quaternion.copy(rotation);
    else t.rotation.set(...rotation);
    t.scale.fromArray(scale);
    t.updateMatrix();
    geometry.applyMatrix4(t.matrix);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
    }
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
    if (nonIndexed !== geometry) geometry.dispose();
    if (!this.batches.has(material)) this.batches.set(material, []);
    this.batches.get(material).push({ name, geometry: nonIndexed });
    this.parts++;
  }

  box(name, size, position, material, radius = 0.014, rotation = [0, 0, 0]) {
    const safeRadius = Math.min(radius, ...size.map(n => n / 2 - 0.0001));
    const geometry = safeRadius > 0.001
      ? new RoundedBoxGeometry(...size, 2, safeRadius)
      : new THREE.BoxGeometry(...size);
    this.add(name, geometry, material, position, rotation);
  }

  cylinder(name, radius, length, position, material, axis = 'y', segments = 48, radiusTop = radius) {
    const rotation = axis === 'z' ? [PI / 2, 0, 0] : axis === 'x' ? [0, 0, PI / 2] : [0, 0, 0];
    this.add(name, new THREE.CylinderGeometry(radiusTop, radius, length, segments), material, position, rotation);
  }

  torus(name, radius, tube, position, material, axis = 'z', arc = TAU, radialSegments = 8, tubularSegments = 64) {
    const rotation = axis === 'y' ? [-PI / 2, 0, 0] : axis === 'x' ? [0, PI / 2, 0] : [0, 0, 0];
    this.add(name, new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments, arc), material, position, rotation);
  }

  rod(name, start, end, radius, material, segments = 12) {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction.clone().normalize());
    this.add(name, new THREE.CylinderGeometry(radius, radius, direction.length(), segments), material, a.add(b).multiplyScalar(0.5).toArray(), quaternion);
  }

  cable(name, points, radius, material, segments = 56) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    this.add(name, new THREE.TubeGeometry(curve, segments, radius, 8, false), material);
    return curve;
  }

  finish() {
    for (const [material, parts] of this.batches) {
      const geometry = mergeGeometries(parts.map(p => p.geometry), false);
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${this.parent.name} / ${material.name}`;
      mesh.castShadow = !material.userData.decal;
      mesh.receiveShadow = true;
      mesh.userData.partNames = parts.map(p => p.name);
      this.parent.add(mesh);
      parts.forEach(part => part.geometry.dispose());
    }
    this.parent.userData.modeledParts = this.parts;
    this.batches.clear();
  }
}

function anchor(parent, name, position) {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.fromArray(position);
  parent.add(node);
  return node;
}

function polygonXZ(builder, name, outline, height, y, material, bevel = 0.015) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel,
    bevelSegments: 1, steps: 1, curveSegments: 1,
  });
  geometry.rotateX(-PI / 2);
  builder.add(name, geometry, material, [0, y, 0]);
}

function plateYZ(builder, name, points, thickness, x, material) {
  const shape = new THREE.Shape(points.map(([y, z]) => new THREE.Vector2(-z, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.012,
    bevelSegments: 2, steps: 1, curveSegments: 1,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.rotateY(PI / 2);
  builder.add(name, geometry, material, [x, 0, 0]);
}

function bolt(builder, name, position, material, axis = 'y', size = 0.023, washer = true) {
  builder.cylinder(`${name} hexagonal head`, size, size * 0.58, position, material, axis, 6);
  if (washer) {
    const p = [...position];
    p[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] -= size * 0.34;
    builder.cylinder(`${name} washer`, size * 1.3, size * 0.16, p, material, axis, 16);
  }
}

function boltCircle(builder, name, center, radius, count, material, axis = 'y', size = 0.023, phase = 0) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU + phase;
    const p = [...center];
    if (axis === 'y') { p[0] += Math.sin(angle) * radius; p[2] += Math.cos(angle) * radius; }
    if (axis === 'x') { p[1] += Math.sin(angle) * radius; p[2] += Math.cos(angle) * radius; }
    if (axis === 'z') { p[0] += Math.sin(angle) * radius; p[1] += Math.cos(angle) * radius; }
    bolt(builder, `${name} ${i + 1}`, p, material, axis, size);
  }
}

function hatch(builder, name, size, position, material, m, axis = 'z') {
  const rot = axis === 'x' ? [0, PI / 2, 0] : [0, 0, 0];
  const [width, height] = size;
  builder.box(`${name} gasket`, [width + 0.032, height + 0.032, 0.027], position, m.rubber, 0.025, rot);
  const p = [...position];
  p[axis === 'x' ? 0 : 2] += 0.017;
  builder.box(name, [width, height, 0.036], p, material, 0.025, rot);
  const place = (u, v, depth) => axis === 'x'
    ? [p[0] + depth, p[1] + v, p[2] - u]
    : [p[0] + u, p[1] + v, p[2] + depth];
  for (const u of [-width / 2 + 0.045, width / 2 - 0.045]) {
    for (const v of [-height / 2 + 0.045, height / 2 - 0.045]) {
      bolt(builder, `${name} captive screw`, place(u, v, 0.027), m.steel, axis, 0.013, false);
    }
  }
  const handleA = place(-0.068, 0, 0.075);
  const handleB = place(0.068, 0, 0.075);
  builder.rod(`${name} handle`, handleA, handleB, 0.014, m.aluminum);
  builder.rod(`${name} handle left return`, handleA, place(-0.068, 0, 0.022), 0.014, m.aluminum);
  builder.rod(`${name} handle right return`, handleB, place(0.068, 0, 0.022), 0.014, m.aluminum);
}

function decalMaterial(title, subtitle = '', theme = 'light') {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dark = theme === 'dark';
  ctx.fillStyle = dark ? '#23353d' : '#dde0d7';
  ctx.fillRect(0, 0, 1024, 384);
  ctx.strokeStyle = dark ? '#758992' : '#748183';
  ctx.lineWidth = 12;
  ctx.strokeRect(12, 12, 1000, 360);
  ctx.fillStyle = dark ? '#dce6df' : '#34444c';
  ctx.font = 'bold 106px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 512, subtitle ? 153 : 192, 945);
  if (subtitle) {
    ctx.font = '42px monospace';
    ctx.fillText(subtitle, 512, 285, 920);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({
    name: `Identification plate: ${title}`, map: texture, roughness: 0.65,
    metalness: 0.08, polygonOffset: true, polygonOffsetFactor: -2,
  });
  material.userData.decal = true;
  return material;
}

function label(builder, text, subtitle, size, position, rotation = [0, 0, 0], theme = 'light') {
  const material = decalMaterial(text, subtitle, theme);
  if (material) builder.add(`Identification plate ${text}`, new THREE.PlaneGeometry(...size), material, position, rotation);
}

function hazardStripes(builder, name, width, height, position, m, rotation = [0, 0, 0]) {
  builder.box(`${name} yellow backing`, [width, height, 0.007], position, m.yellow, 0.001, rotation);
  // Small diagonal strips are modeled, so the warning remains crisp up close.
  const transform = new THREE.Object3D();
  transform.position.fromArray(position);
  transform.rotation.set(...rotation);
  transform.updateMatrix();
  for (let i = 0; i < 7; i++) {
    const x = -width / 2 + (i + 0.5) * width / 7;
    const shape = new THREE.Shape([
      new THREE.Vector2(x - width / 42, -height / 2),
      new THREE.Vector2(x + width / 30, -height / 2),
      new THREE.Vector2(x - width / 30, height / 2),
      new THREE.Vector2(x - width / 9, height / 2),
    ]);
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.translate(0, 0, 0.0041);
    geometry.applyMatrix4(transform.matrix);
    builder.add(`${name} diagonal ${i}`, geometry, m.black);
  }
}

function buildFixedBase(b, m) {
  const width = 1.15;
  const depth = 1.0;
  const cut = 0.22;
  const outline = [
    [-width + cut, -depth], [width - cut, -depth], [width, -depth + cut],
    [width, depth - cut], [width - cut, depth], [-width + cut, depth],
    [-width, depth - cut], [-width, -depth + cut],
  ];
  polygonXZ(b, 'Octagonal deck foundation', outline, 0.12, 0.025, m.gray, 0.022);
  b.cylinder('Foundation flange', 1.045, 0.145, [0, 0.20, 0], m.pale, 'y', 96);
  b.cylinder('Foundation gasket', 0.99, 0.024, [0, 0.287, 0], m.rubber, 'y', 96);
  b.cylinder('Stationary pedestal', 0.88, 0.49, [0, 0.545, 0], m.ivory, 'y', 96, 0.72);
  b.cylinder('Lower bearing lip', 0.85, 0.10, [0, 0.81, 0], m.pale, 'y', 96);
  b.cylinder('Azimuth bearing seal', 0.81, 0.055, [0, 0.888, 0], m.rubber, 'y', 96);
  b.cylinder('Azimuth stationary bearing race', 0.86, 0.105, [0, 0.967, 0], m.steel, 'y', 96);
  b.torus('Bearing race narrow lip', 0.867, 0.014, [0, 0.943, 0], m.darker, 'y');
  b.torus('Pedestal circumferential seam', 0.835, 0.009, [0, 0.455, 0], m.gray, 'y');
  boltCircle(b, 'Deck mounting bolt', [0, 0.294, 0], 0.95, 32, m.steel, 'y', 0.029);
  boltCircle(b, 'Lower bearing bolt', [0, 0.871, 0], 0.79, 28, m.steel, 'y', 0.019);
  for (const x of [-0.94, 0.94]) {
    for (const z of [-0.78, 0.78]) {
      b.box('Deck anchor foot', [0.22, 0.06, 0.19], [x, 0.035, z], m.darker, 0.012);
      bolt(b, 'Deck anchor fastener', [x, 0.178, z], m.steel, 'y', 0.041);
    }
  }
  for (let i = 0; i < 8; i++) {
    const angle = i * TAU / 8;
    b.box('Radial pedestal reinforcing rib', [0.055, 0.33, 0.13],
      [Math.sin(angle) * 0.835, 0.5, Math.cos(angle) * 0.835], m.pale, 0.008, [0, angle, -0.03]);
  }
  hatch(b, 'Pedestal service cover', [0.48, 0.22], [0, 0.49, 0.831], m.ivory, m);
  label(b, 'PHALANX', 'MK 15  /  EXTERIOR STUDY', [0.42, 0.158], [0, 0.511, 0.871]);
  b.cylinder('Deck cable gland', 0.1, 0.12, [-0.47, 0.35, -0.75], m.darker, 'z', 24);
  b.cable('Deck electrical conduit', [[-0.47, 0.34, -0.80], [-0.59, 0.28, -0.97], [-0.82, 0.17, -1.1], [-0.95, 0.15, -1.30]], 0.039, m.rubber, 32);
  for (let i = 0; i < 10; i++) {
    const z = -1.07 - i * 0.024;
    b.torus('Deck conduit corrugation', 0.039, 0.008, [-0.83 - i * 0.013, 0.17 - i * 0.0015, z], m.darker, 'z', TAU, 5, 14);
  }
}

function buildAzimuthCradle(b, m) {
  b.cylinder('Rotating azimuth bearing', 0.865, 0.13, [0, 0.071, 0], m.ivory, 'y', 96);
  b.cylinder('Rotating bearing top face', 0.82, 0.07, [0, 0.167, 0], m.pale, 'y', 96);
  b.torus('Turntable seal', 0.858, 0.012, [0, 0.007, 0], m.rubber, 'y');
  boltCircle(b, 'Rotating race fastener', [0, 0.212, 0], 0.745, 32, m.steel, 'y', 0.021);
  const platform = [[-0.77, -0.57], [-0.57, -0.80], [0.57, -0.80], [0.77, -0.57], [0.77, 0.56], [0.58, 0.72], [-0.58, 0.72], [-0.77, 0.56]];
  polygonXZ(b, 'Fork platform casting', platform, 0.12, 0.21, m.gray, 0.018);
  b.box('Rear traverse housing', [1.27, 0.60, 0.37], [0, 0.60, -0.54], m.ivory, 0.055);
  b.box('Rear housing inset panel', [1.14, 0.43, 0.024], [0, 0.59, -0.739], m.pale, 0.016);
  const sideProfile = [[0.29, -0.55], [0.32, 0.35], [0.82, 0.33], [1.21, 0.13], [1.28, -0.12], [0.90, -0.53]];
  for (const side of [-1, 1]) {
    const x = side * 0.665;
    plateYZ(b, 'Elevation fork side casting', sideProfile, 0.16, x, m.ivory);
    plateYZ(b, 'Fork recessed side face', [[0.41, -0.41], [0.41, 0.2], [0.76, 0.2], [1.13, 0.04], [1.13, -0.1], [0.84, -0.4]], 0.014, side * 0.758, m.pale);
    b.cylinder('Elevation trunnion outer housing', 0.272, 0.16, [side * 0.79, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0], m.gray, 'x', 64);
    b.cylinder('Elevation trunnion seal', 0.23, 0.034, [side * 0.892, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0], m.rubber, 'x', 48);
    b.cylinder('Elevation trunnion cover', 0.211, 0.054, [side * 0.92, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0], m.ivory, 'x', 64);
    b.cylinder('Elevation axis end cap', 0.117, 0.068, [side * 0.957, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0], m.pale, 'x', 48);
    boltCircle(b, 'Elevation cover perimeter bolt', [side * 0.958, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0], 0.175, 12, m.steel, 'x', 0.019);
    for (const [y, z] of [[0.46, 0.22], [0.47, -0.4], [0.70, 0.22], [0.83, -0.34], [1.17, -0.08]]) {
      bolt(b, 'Fork casting bolt', [side * 0.769, y, z], m.steel, 'x', 0.022);
    }
    b.box('Fork lower foot', [0.31, 0.11, 0.78], [x, 0.333, -0.1], m.pale, 0.018);
    for (const z of [-0.39, 0.19]) bolt(b, 'Fork foot anchor', [x, 0.407, z], m.steel, 'y', 0.029);
    b.rod('Fork lifting handle upper', [side * 0.79, 0.64, -0.4], [side * 0.79, 0.86, -0.4], 0.019, m.steel);
    b.rod('Fork lifting handle lower return', [side * 0.76, 0.64, -0.4], [side * 0.83, 0.64, -0.4], 0.019, m.steel);
    b.rod('Fork lifting handle upper return', [side * 0.76, 0.86, -0.4], [side * 0.83, 0.86, -0.4], 0.019, m.steel);
  }
  b.cylinder('Elevation motor main housing', 0.188, 0.43, [-1.12, 0.97, -0.13], m.ivory, 'x', 48);
  b.cylinder('Elevation motor endplate', 0.19, 0.041, [-1.35, 0.97, -0.13], m.pale, 'x', 48);
  boltCircle(b, 'Motor endplate bolt', [-1.378, 0.97, -0.13], 0.148, 8, m.steel, 'x', 0.016);
  for (let i = 0; i < 9; i++) {
    b.cylinder('Elevation motor cooling rib', 0.205, 0.017, [-0.99 - i * 0.035, 0.97, -0.13], m.pale, 'x', 36);
  }
  b.box('Motor junction box', [0.25, 0.19, 0.2], [-1.17, 0.975, -0.33], m.gray, 0.015);
  b.cable('Motor conduit', [[-1.17, 0.97, -0.43], [-1.1, 0.72, -0.49], [-0.95, 0.50, -0.55], [-0.62, 0.45, -0.69]], 0.025, m.rubber, 38);
  b.box('Traverse motor support', [0.41, 0.25, 0.48], [0.64, 0.46, -0.50], m.pale, 0.018);
  b.cylinder('Traverse motor', 0.157, 0.4, [0.70, 0.51, -0.50], m.gray, 'z', 40);
  for (let i = 0; i < 9; i++) b.cylinder('Traverse motor fin', 0.171, 0.014, [0.70, 0.51, -0.65 + i * 0.038], m.pale, 'z', 32);
  b.box('Rear electrical connector cover', [0.30, 0.22, 0.12], [-0.37, 0.68, -0.78], m.darker, 0.016);
  for (let i = 0; i < 3; i++) b.cylinder('Rear sealed connector', 0.038, 0.08, [-0.47 + i * 0.095, 0.68, -0.885], m.steel, 'z', 20);
  for (let i = 0; i < 10; i++) b.box('Rear housing ventilation slot', [0.41, 0.013, 0.009], [0.33, 0.44 + i * 0.033, -0.754], m.darker, 0.003);
  label(b, 'AZIMUTH', 'ROTATING ASSEMBLY', [0.31, 0.116], [0, 0.48, -0.743], [0, PI, 0]);
}

function buildRadarCover(b, m) {
  // A lathed profile retains the characteristic tall, softly capped radome.
  const profile = [
    [0.0, 0.275], [0.50, 0.275], [0.595, 0.30], [0.638, 0.37],
    [0.650, 0.46], [0.650, 1.44], [0.644, 1.60], [0.625, 1.73],
    [0.583, 1.85], [0.516, 1.955], [0.42, 2.04], [0.30, 2.10],
    [0.16, 2.14], [0.0, 2.155],
  ];
  b.add('One-piece fiberglass radome', new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 96), m.radome, [0, 0, -0.34]);
  b.cylinder('Radar cover lower mounting ring', 0.637, 0.085, [0, 0.31, -0.34], m.ivory, 'y', 96);
  b.torus('Radome lower gasket', 0.636, 0.012, [0, 0.365, -0.34], m.rubber, 'y', TAU, 6, 96);
  b.torus('Radome lower lip', 0.65, 0.018, [0, 0.39, -0.34], m.ivory, 'y', TAU, 8, 96);
  b.torus('Radome cap fine seam', 0.649, 0.0045, [0, 1.466, -0.34], m.pale, 'y', TAU, 5, 96);
  b.torus('Radome bottom seam', 0.651, 0.005, [0, 0.50, -0.34], m.pale, 'y', TAU, 5, 96);
  for (let i = 0; i < 24; i++) {
    const a = i * TAU / 24;
    const r = 0.642;
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
    b.add('Radome captive perimeter fastener', new THREE.CylinderGeometry(0.012, 0.012, 0.012, 6), m.steel,
      [Math.sin(a) * r, 0.331, -0.34 + Math.cos(a) * r], q);
  }
  // Subtle seams belong to the external lower housing, not the radar interior.
  for (const side of [-1, 1]) {
    b.box('Radome lower side bracket', [0.09, 0.31, 0.35], [side * 0.588, 0.192, -0.28], m.ivory, 0.025);
    b.rod('Radome side lifting eye stem', [side * 0.50, 1.00, -0.75], [side * 0.595, 1.00, -0.79], 0.023, m.ivory);
    b.torus('Radome side lifting eye', 0.049, 0.014, [side * 0.63, 1.00, -0.80], m.ivory, 'x', TAU, 8, 24);
  }
  b.box('Radar lower frame', [1.12, 0.32, 0.85], [0, 0.16, -0.33], m.pale, 0.047);
  b.box('Radar frame front interface', [0.79, 0.22, 0.20], [0, 0.18, 0.17], m.ivory, 0.022);
  b.box('Rear radome service housing', [0.84, 0.69, 0.33], [0, 0.385, -1.007], m.ivory, 0.048);
  b.box('Rear housing seam', [0.75, 0.56, 0.025], [0, 0.39, -1.186], m.rubber, 0.033);
  b.box('Rear housing access door', [0.72, 0.53, 0.036], [0, 0.39, -1.201], m.ivory, 0.031);
  for (const x of [-0.28, 0.28]) {
    for (const y of [0.16, 0.62]) bolt(b, 'Rear radar access fastener', [x, y, -1.228], m.steel, 'z', 0.017);
  }
  for (const y of [0.20, 0.52]) {
    b.box('Rear housing hinge leaf', [0.105, 0.071, 0.03], [-0.37, y, -1.19], m.pale, 0.008);
    b.cylinder('Rear housing hinge pin', 0.026, 0.10, [-0.409, y, -1.199], m.steel, 'y', 16);
  }
  b.rod('Rear housing access handle', [-0.10, 0.36, -1.28], [0.10, 0.36, -1.28], 0.018, m.steel);
  b.rod('Rear handle left stand-off', [-0.10, 0.36, -1.28], [-0.10, 0.36, -1.22], 0.018, m.steel);
  b.rod('Rear handle right stand-off', [0.10, 0.36, -1.28], [0.10, 0.36, -1.22], 0.018, m.steel);
  label(b, 'RADAR COVER', 'COMPOSITE EXTERIOR', [0.36, 0.135], [0, 0.60, -1.223], [0, PI, 0]);
  label(b, '15', 'BLOCK 1B', [0.27, 0.145], [0, 0.795, 0.312]);
  label(b, 'SERVICE', 'ACCESS PANEL', [0.19, 0.071], [-0.651, 0.72, -0.24], [0, -PI / 2, 0]);
}

function buildReceiverAndMagazine(b, m) {
  b.box('Cannon receiver chassis', [0.61, 0.42, 1.14], [0, GUN_HEIGHT - 0.027, 0.53], m.gunmetal, 0.045);
  b.box('Upper receiver cover', [0.66, 0.115, 0.94], [0, 0.19, 0.54], m.gray, 0.023);
  b.box('Receiver top cover bright lip', [0.57, 0.032, 0.88], [0, 0.251, 0.54], m.pale, 0.009);
  b.box('Receiver underside mount', [0.70, 0.12, 0.82], [0, -0.326, 0.44], m.pale, 0.023);
  b.cylinder('Gun receiver front flange', 0.249, 0.17, [0, GUN_HEIGHT, 1.044], m.gunmetal, 'z', 64);
  b.cylinder('Gun flange machined face', 0.226, 0.033, [0, GUN_HEIGHT, 1.142], m.steel, 'z', 64);
  b.cylinder('Rotor dark aperture', 0.181, 0.016, [0, GUN_HEIGHT, 1.163], m.black, 'z', 64);
  boltCircle(b, 'Receiver flange fastener', [0, GUN_HEIGHT, 1.170], 0.206, 12, m.steel, 'z', 0.015);
  for (const x of [-0.338, 0.338]) {
    b.box('Receiver removable side plate', [0.039, 0.27, 0.76], [x, -0.031, 0.54], m.pale, 0.012);
    b.box('Receiver side inset', [0.048, 0.141, 0.43], [x * 1.025, -0.03, 0.51], m.darker, 0.007);
    for (let i = 0; i < 11; i++) {
      b.box('Receiver side cooling fin', [0.06, 0.153, 0.014], [x * 1.06, -0.03, 0.305 + i * 0.041], m.gunmetal, 0.003);
    }
    for (const z of [0.20, 0.40, 0.68, 0.87]) {
      for (const y of [-0.15, 0.10]) bolt(b, 'Receiver side screw', [x * 1.07, y, z], m.steel, 'x', 0.014);
    }
  }
  for (const x of [-0.25, 0.25]) {
    for (let i = 0; i < 6; i++) bolt(b, 'Receiver top cover bolt', [x, 0.27, 0.21 + i * 0.135], m.steel, 'y', 0.013);
    b.rod('Receiver top guide', [x, 0.30, 0.25], [x, 0.30, 0.94], 0.018, m.steel);
  }
  b.cylinder('Receiver right external drive housing', 0.124, 0.35, [0.484, -0.047, 0.13], m.gray, 'z', 40);
  b.cylinder('Drive housing rear cap', 0.132, 0.04, [0.484, -0.047, -0.068], m.pale, 'z', 40);
  boltCircle(b, 'Drive housing end bolt', [0.484, -0.047, -0.093], 0.101, 8, m.steel, 'z', 0.012);
  for (let i = 0; i < 8; i++) b.cylinder('Receiver drive cooling ring', 0.135, 0.012, [0.484, -0.047, -0.019 + i * 0.037], m.pale, 'z', 32);
  b.box('Receiver exterior identification pad', [0.4, 0.02, 0.17], [0, 0.272, 0.63], m.darker, 0.009);
  label(b, 'ROTARY CANNON', 'EXTERIOR ASSEMBLY', [0.36, 0.135], [0, 0.285, 0.63], [-PI / 2, 0, 0], 'dark');

  // Broad transverse exterior ammunition drum underneath the receiver.
  const drumY = -0.67;
  const drumZ = 0.46;
  b.cylinder('Ammunition drum outer shell', 0.51, 1.25, [0, drumY, drumZ], m.ivory, 'x', 80);
  b.cylinder('Magazine center shell band', 0.517, 0.035, [0, drumY, drumZ], m.pale, 'x', 80);
  for (const side of [-1, 1]) {
    b.cylinder('Magazine end flange seal', 0.526, 0.024, [side * 0.578, drumY, drumZ], m.rubber, 'x', 80);
    b.cylinder('Magazine end flange', 0.539, 0.083, [side * 0.637, drumY, drumZ], m.pale, 'x', 80);
    b.cylinder('Magazine domed end cover', 0.481, 0.095, [side * 0.701, drumY, drumZ], m.ivory, 'x', 80, 0.472);
    b.torus('Magazine end inset seam', 0.443, 0.008, [side * 0.755, drumY, drumZ], m.gray, 'x');
    b.cylinder('Magazine center hub seal', 0.175, 0.02, [side * 0.76, drumY, drumZ], m.rubber, 'x', 48);
    b.cylinder('Magazine center hub', 0.157, 0.074, [side * 0.797, drumY, drumZ], m.pale, 'x', 48);
    b.cylinder('Magazine hub cap', 0.095, 0.018, [side * 0.842, drumY, drumZ], m.steel, 'x', 32);
    boltCircle(b, 'Magazine endcover fastener', [side * 0.764, drumY, drumZ], 0.468, 20, m.steel, 'x', 0.018);
    boltCircle(b, 'Magazine center hub screw', [side * 0.84, drumY, drumZ], 0.123, 6, m.steel, 'x', 0.015);
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8;
      b.rod('Magazine endcover radial stiffener',
        [side * 0.758, drumY + Math.sin(a) * 0.19, drumZ + Math.cos(a) * 0.19],
        [side * 0.758, drumY + Math.sin(a) * 0.41, drumZ + Math.cos(a) * 0.41], 0.012, m.pale, 8);
    }
    b.box('Magazine support saddle', [0.105, 0.22, 0.43], [side * 0.493, -0.283, drumZ], m.gray, 0.019);
    b.rod('Magazine support strut', [side * 0.505, -0.20, -0.10], [side * 0.505, -0.63, -0.005], 0.044, m.pale, 16);
  }
  for (let i = 0; i < 14; i++) {
    const a = i * TAU / 14;
    b.rod('Magazine longitudinal stiffening bead',
      [-0.54, drumY + Math.sin(a) * 0.514, drumZ + Math.cos(a) * 0.514],
      [0.54, drumY + Math.sin(a) * 0.514, drumZ + Math.cos(a) * 0.514], 0.013, m.pale, 8);
  }
  b.box('Magazine forward service access', [0.72, 0.26, 0.055], [0, drumY, 0.975], m.ivory, 0.023);
  hazardStripes(b, 'Magazine service caution stripe', 0.66, 0.055, [0, -0.524, 0.985], m);
  label(b, 'CAUTION', 'MOVING ASSEMBLY', [0.35, 0.13], [0, -0.675, 1.007]);
  for (const x of [-0.285, 0.285]) {
    for (const y of [-0.59, -0.76]) bolt(b, 'Magazine forward hatch fastener', [x, y, 1.012], m.steel, 'z', 0.013);
  }
  // External flexible feed-chute cover: a corrugated path, not internal detail.
  const feed = b.cable('Flexible feed chute outer cover', [
    [0.70, -0.67, 0.22], [0.87, -0.52, 0.08], [0.88, -0.26, 0.035],
    [0.72, -0.12, 0.16], [0.39, -0.09, 0.28],
  ], 0.108, m.rubber, 56);
  for (let i = 0; i < 39; i++) {
    const t = i / 38;
    const p = feed.getPointAt(t);
    const tangent = feed.getTangentAt(t);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    b.add('Feed cover corrugation', new THREE.TorusGeometry(0.107, 0.012, 5, 14), m.pale, p.toArray(), q);
  }
  b.box('Magazine exterior interface cover', [0.27, 0.21, 0.21], [0.70, -0.65, 0.15], m.pale, 0.035);
  b.box('Magazine red service latch', [0.085, 0.035, 0.14], [-0.38, -0.35, 0.884], m.red, 0.012, [0.35, 0, 0]);
  b.rod('Magazine maintenance locking pin', [-0.81, -0.36, 0.71], [-0.91, -0.36, 0.71], 0.018, m.red);
  b.torus('Maintenance pin pull ring', 0.045, 0.008, [-0.937, -0.36, 0.71], m.red, 'x', TAU, 6, 22);
}

function buildBarrelBrace(b, m) {
  const rearZ = 1.03;
  const frontZ = 2.90;
  const radius = 0.253;
  b.torus('Fixed rear barrel support hoop', radius, 0.041, [0, GUN_HEIGHT, rearZ], m.gray, 'z', TAU, 10, 64);
  b.torus('Fixed forward muzzle restraint', radius, 0.034, [0, GUN_HEIGHT, frontZ], m.gunmetal, 'z', TAU, 10, 64);
  b.torus('Forward muzzle restraint bright edge', radius + 0.002, 0.009, [0, GUN_HEIGHT, frontZ + 0.035], m.steel, 'z', TAU, 6, 64);
  // Four slim external braces distinguish the Block 1B gun silhouette.
  for (let i = 0; i < 4; i++) {
    const angle = PI / 4 + i * PI / 2;
    const x = Math.cos(angle) * radius;
    const y = GUN_HEIGHT + Math.sin(angle) * radius;
    b.rod('External barrel brace longitudinal rail', [x, y, rearZ], [x, y, frontZ], 0.022, m.gray, 12);
    b.cylinder('Brace rear ferrule', 0.034, 0.10, [x, y, rearZ + 0.058], m.steel, 'z', 16);
    b.cylinder('Brace forward ferrule', 0.032, 0.10, [x, y, frontZ - 0.04], m.steel, 'z', 16);
    bolt(b, 'Muzzle restraint retaining bolt', [x, y, frontZ + 0.047], m.steel, 'z', 0.018);
  }
  b.box('Receiver brace lower saddle', [0.41, 0.072, 0.34], [0, GUN_HEIGHT - 0.29, 1.07], m.gray, 0.018);
  b.box('Brace upper rear bridge', [0.43, 0.057, 0.16], [0, GUN_HEIGHT + 0.278, 1.08], m.pale, 0.014);
  for (const x of [-0.15, 0.15]) bolt(b, 'Rear brace bridge bolt', [x, GUN_HEIGHT + 0.32, 1.08], m.steel, 'y', 0.018);
}

function buildRotatingBarrels(b, m) {
  const pitchRadius = 0.122;
  b.cylinder('Six-barrel rotor rear core', 0.168, 0.22, [0, 0, 0.075], m.gunmetal, 'z', 64);
  b.cylinder('Rotor central steel shaft', 0.045, BARREL_LENGTH - 0.2, [0, 0, BARREL_LENGTH / 2 - 0.07], m.gunmetal, 'z', 32);
  for (let i = 0; i < 6; i++) {
    const angle = i * TAU / 6;
    const x = Math.cos(angle) * pitchRadius;
    const y = Math.sin(angle) * pitchRadius;
    b.add(`Barrel ${i + 1} external tube`, new THREE.CylinderGeometry(0.039, 0.046, BARREL_LENGTH - 0.10, 24, 1, true),
      m.barrel, [x, y, BARREL_LENGTH / 2], [PI / 2, 0, 0]);
    b.cylinder(`Barrel ${i + 1} rear sleeve`, 0.052, 0.37, [x, y, 0.215], m.gunmetal, 'z', 24);
    b.cylinder(`Barrel ${i + 1} sleeve shoulder`, 0.057, 0.046, [x, y, 0.405], m.steel, 'z', 24);
    b.cylinder(`Barrel ${i + 1} muzzle ferrule`, 0.045, 0.15, [x, y, BARREL_LENGTH - 0.097], m.gunmetal, 'z', 24);
    const muzzleZ = BARREL_LENGTH - 0.018;
    b.add(`Barrel ${i + 1} muzzle bore`, new THREE.RingGeometry(0.024, 0.045, 28), m.steel, [x, y, muzzleZ]);
    b.add(`Barrel ${i + 1} inner bore`, new THREE.CylinderGeometry(0.024, 0.024, 0.11, 24, 1, true), m.black,
      [x, y, muzzleZ - 0.055], [PI / 2, 0, 0]);
    b.cylinder(`Barrel ${i + 1} bore shadow`, 0.024, 0.003, [x, y, muzzleZ - 0.113], m.black, 'z', 24);
    for (const z of [0.7, 1.38, 1.81]) {
      b.cylinder(`Barrel ${i + 1} mounting collar`, 0.044, 0.045, [x, y, z], m.steel, 'z', 20);
      b.rod(`Barrel ${i + 1} rotor web`, [0, 0, z], [x, y, z], 0.032, m.gunmetal, 8);
    }
  }
  for (const z of [0.50, 1.42, 1.79]) {
    b.torus('Rotating barrel cluster hoop', 0.174, 0.022, [0, 0, z], m.gunmetal, 'z', TAU, 8, 48);
    boltCircle(b, 'Barrel cluster hoop screw', [0, 0, z + 0.022], 0.181, 6, m.steel, 'z', 0.011);
  }
}

function buildOpticalPod(b, m) {
  // The separate off-axis optical head is the recognizable Block 1B addition.
  b.box('Optical head support foot', [0.26, 0.15, 0.42], [0.62, 0.73, -0.26], m.gray, 0.025);
  b.box('Optical head outboard bracket', [0.17, 0.56, 0.33], [0.80, 0.80, -0.21], m.ivory, 0.031);
  b.cylinder('Optical head side axis', 0.18, 0.44, [0.86, 1.02, -0.055], m.gray, 'x', 48);
  b.box('Electro-optical sensor housing', [0.46, 0.46, 0.56], [0.95, 1.005, 0.09], m.ivory, 0.066);
  b.box('Sensor face gasket', [0.412, 0.394, 0.036], [0.95, 1.005, 0.395], m.rubber, 0.042);
  b.box('Sensor face plate', [0.40, 0.382, 0.040], [0.95, 1.005, 0.422], m.pale, 0.04);
  b.box('Optical sunshade', [0.48, 0.056, 0.66], [0.95, 1.25, 0.16], m.ivory, 0.014);
  b.box('Sunshade forward edge', [0.482, 0.069, 0.035], [0.95, 1.226, 0.487], m.pale, 0.009);
  const lenses = [
    { x: 0.887, y: 1.06, r: 0.093, glass: m.lens },
    { x: 1.064, y: 1.052, r: 0.055, glass: m.irLens },
    { x: 1.017, y: 0.91, r: 0.045, glass: m.lens },
  ];
  for (const [i, lens] of lenses.entries()) {
    b.cylinder(`Optical aperture ${i + 1} surround`, lens.r + 0.02, 0.055, [lens.x, lens.y, 0.458], m.gunmetal, 'z', 48);
    b.cylinder(`Optical aperture ${i + 1} cavity`, lens.r, 0.008, [lens.x, lens.y, 0.488], m.black, 'z', 48);
    b.cylinder(`Optical aperture ${i + 1} glass`, lens.r * 0.83, 0.01, [lens.x, lens.y, 0.493], lens.glass, 'z', 48);
    b.torus(`Optical aperture ${i + 1} retaining ring`, lens.r * 0.90, 0.009, [lens.x, lens.y, 0.50], m.steel, 'z', TAU, 7, 40);
    b.add(`Optical aperture ${i + 1} highlight`, new THREE.CircleGeometry(lens.r * 0.105, 16), m.aluminum,
      [lens.x - lens.r * 0.26, lens.y + lens.r * 0.31, 0.50]);
  }
  for (const x of [0.80, 1.10]) {
    for (const y of [0.86, 1.15]) bolt(b, 'Optical face captive bolt', [x, y, 0.452], m.steel, 'z', 0.011, false);
  }
  b.cylinder('Optical pod outboard side cap', 0.13, 0.038, [1.21, 1.005, 0.066], m.pale, 'x', 40);
  boltCircle(b, 'Optical pod axis cover screw', [1.24, 1.005, 0.066], 0.102, 8, m.steel, 'x', 0.011);
  for (let i = 0; i < 7; i++) b.box('Optical housing side cooling ridge', [0.028, 0.185, 0.018], [1.193, 1.014, -0.135 + i * 0.041], m.pale, 0.004);
  b.cable('Optical sensor cable loop', [[0.98, 0.83, -0.175], [1.09, 0.66, -0.31], [0.99, 0.46, -0.37], [0.68, 0.39, -0.54], [0.56, 0.46, -0.61]], 0.026, m.rubber, 48);
  b.cylinder('Optical cable rear gland', 0.045, 0.07, [0.98, 0.855, -0.226], m.steel, 'z', 20);
  label(b, 'OPTICS', 'BLOCK 1B', [0.21, 0.079], [1.192, 1.136, 0.067], [0, PI / 2, 0]);
}

function buildExternalDetails(b, m) {
  // Exposed exterior cable looms and small service fittings enrich the sides.
  b.cable('Left radar electrical loom', [[-0.46, 0.27, -0.81], [-0.66, 0.12, -0.8], [-0.74, -0.15, -0.57], [-0.76, -0.30, -0.25], [-0.52, -0.35, 0.0]], 0.037, m.rubber, 56);
  b.cable('Right radar electrical loom', [[0.43, 0.26, -0.86], [0.61, 0.04, -0.85], [0.68, -0.19, -0.52], [0.64, -0.25, -0.21]], 0.028, m.rubber, 44);
  b.cable('Receiver external hydraulic line', [[-0.37, 0.03, 0.17], [-0.49, 0.11, 0.36], [-0.50, 0.05, 0.78], [-0.37, -0.03, 0.89]], 0.017, m.steel, 40);
  for (const side of [-1, 1]) {
    b.cylinder('Rear cable loom connector', 0.059, 0.12, [side * 0.47, 0.26, -0.86], m.steel, 'z', 24);
    b.cylinder('Rear cable connector rubber boot', 0.043, 0.10, [side * 0.47, 0.26, -0.95], m.rubber, 'z', 20);
    b.box('Rear connector protective skirt', [0.15, 0.13, 0.11], [side * 0.48, 0.28, -0.83], m.ivory, 0.017);
    b.box('Cradle edge reinforcement', [0.078, 0.20, 0.83], [side * 0.537, -0.13, -0.14], m.gray, 0.015);
    for (let i = 0; i < 6; i++) bolt(b, 'Cradle edge fixing', [side * 0.58, -0.115, -0.46 + i * 0.12], m.steel, 'x', 0.016);
    b.rod('Upper assembly rear handrail', [side * 0.53, -0.07, -0.93], [side * 0.53, 0.12, -1.17], 0.022, m.ivory);
  }
  b.rod('Rear assembly handrail crosspiece', [-0.53, 0.12, -1.17], [0.53, 0.12, -1.17], 0.022, m.ivory);
  b.box('Receiver service latch base', [0.12, 0.04, 0.19], [-0.31, 0.25, 0.50], m.gray, 0.011);
  b.box('Receiver service latch lever', [0.036, 0.043, 0.17], [-0.31, 0.285, 0.49], m.red, 0.011);
  for (const x of [-0.43, 0.43]) {
    b.torus('Cradle lifting lug', 0.057, 0.022, [x, 0.24, -0.64], m.pale, 'x', TAU, 8, 30);
  }
  hazardStripes(b, 'Rear elevation caution marker', 0.43, 0.061, [0, -0.031, -1.108], m, [0, PI, 0]);
}

export function createPhalanx() {
  const materials = makeMaterials();
  const root = new THREE.Group();
  root.name = 'Phalanx Block 1B exterior';
  root.userData.description = 'Public-reference exterior visualization; proportions and details are interpretive.';

  const azimuth = new THREE.Group();
  azimuth.name = 'Azimuth joint';
  azimuth.position.y = AZIMUTH_HEIGHT;
  root.add(azimuth);

  const elevation = new THREE.Group();
  elevation.name = 'Elevation joint — complete upper assembly';
  elevation.position.y = PIVOT_HEIGHT - AZIMUTH_HEIGHT;
  azimuth.add(elevation);

  const barrels = new THREE.Group();
  barrels.name = 'Six-barrel rotor joint';
  barrels.position.set(0, GUN_HEIGHT, BARREL_ROOT);
  elevation.add(barrels);

  const muzzle = anchor(elevation, 'Muzzle effect anchor', [0, GUN_HEIGHT, BARREL_ROOT + BARREL_LENGTH - 0.018]);

  const fixedBuilder = new PartBuilder(root);
  const azimuthBuilder = new PartBuilder(azimuth);
  const elevationBuilder = new PartBuilder(elevation);
  const barrelBuilder = new PartBuilder(barrels);

  buildFixedBase(fixedBuilder, materials);
  buildAzimuthCradle(azimuthBuilder, materials);
  buildRadarCover(elevationBuilder, materials);
  buildReceiverAndMagazine(elevationBuilder, materials);
  buildBarrelBrace(elevationBuilder, materials);
  buildRotatingBarrels(barrelBuilder, materials);
  buildOpticalPod(elevationBuilder, materials);
  buildExternalDetails(elevationBuilder, materials);

  fixedBuilder.finish();
  azimuthBuilder.finish();
  elevationBuilder.finish();
  barrelBuilder.finish();

  const hotspots = [
    {
      id: 'radome', label: 'Radar radome',
      description: 'The distinctive fiberglass cover encloses the radar installation and tilts with the upper assembly.',
      anchor: anchor(elevation, 'Radar cover inspection point', [-0.22, 1.45, 0.24]),
    },
    {
      id: 'optics', label: 'Electro-optical sensor',
      description: 'The off-axis optical housing is a characteristic exterior feature of the Block 1B.',
      anchor: anchor(elevation, 'Optical sensor inspection point', [1.00, 1.055, 0.52]),
    },
    {
      id: 'barrels', label: 'Six-barrel assembly',
      description: 'Six separately modeled barrel tubes rotate within the exterior brace and forward muzzle restraint.',
      anchor: anchor(elevation, 'Barrel inspection point', [-0.03, GUN_HEIGHT + 0.20, 2.25]),
    },
    {
      id: 'magazine', label: 'Ammunition drum',
      description: 'The exterior drum includes ribbed covers, bolted flanges, access fittings, and a corrugated feed-chute cover.',
      anchor: anchor(elevation, 'Magazine inspection point', [-0.69, -0.63, 0.75]),
    },
    {
      id: 'elevation', label: 'Elevation trunnion',
      description: 'This lateral pivot carries the complete upper assembly as its inclination changes.',
      anchor: anchor(azimuth, 'Elevation bearing inspection point', [-0.97, PIVOT_HEIGHT - AZIMUTH_HEIGHT, 0.12]),
    },
    {
      id: 'azimuth', label: 'Azimuth bearing',
      description: 'The circular pedestal supports the rotating cradle and remains attached to the deck foundation.',
      anchor: anchor(root, 'Azimuth bearing inspection point', [0.72, 0.91, 0.53]),
    },
  ];

  function setWireframe(enabled) {
    root.traverse(object => {
      if (!object.isMesh) return;
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach(material => {
        if (!material.userData.decal) material.wireframe = Boolean(enabled);
      });
    });
  }

  function getStats() {
    let meshes = 0;
    let triangles = 0;
    root.traverse(object => {
      if (!object.isMesh) return;
      meshes++;
      triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    });
    return { meshes, triangles: Math.round(triangles) };
  }

  return { root, azimuth, elevation, barrels, muzzle, hotspots, setWireframe, getStats };
}
