import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** An original delta-wing silhouette with a rounded fuselage and twin tip fins. */
export function createDroneAirframe() {
  const geometries = [];
  const own = geometry => (geometries.push(geometry), geometry);
  const shape = points => new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const extrude = (points, depth) => own(new THREE.ExtrudeGeometry(shape(points), {
    depth, bevelEnabled: false, steps: 1,
  }));

  // The nose points along local +Z; the wing lies in the XZ plane.
  const wing = extrude([[0, 0.55], [-1.45, -0.9], [-1.45, -1.4], [1.45, -1.4], [1.45, -0.9]], 0.09);
  wing.rotateX(Math.PI / 2).translate(0, 0.045, 0);
  const fuselage = own(new THREE.LatheGeometry([
    [0, -1.43], [0.17, -1.4], [0.22, -1.1], [0.2, -0.45],
    [0.18, 0.8], [0.15, 1.16], [0.08, 1.4], [0, 1.5],
  ].map(([radius, length]) => new THREE.Vector2(radius, length)), 20));
  fuselage.rotateX(Math.PI / 2).translate(0, 0.06, 0);

  const fins = [-1, 1].map(side => {
    const fin = extrude([[-1.4, -0.24], [-1.4, 0.35], [-1.03, 0.35], [-0.9, 0.08], [-1.02, -0.24]], 0.055);
    fin.rotateY(-Math.PI / 2).translate(side * 1.45 + 0.0275, 0, 0);
    return fin;
  });
  const body = own(mergeGeometries([wing, own(fuselage.toNonIndexed()), ...fins], false));

  const trim = [-1, 1].map(side => own(new THREE.BoxGeometry(1.12, 0.014, 0.13))
    .translate(side * 0.78, 0.053, -1.31));
  const engine = own(new THREE.CylinderGeometry(0.115, 0.15, 0.16, 12));
  engine.rotateX(Math.PI / 2).translate(0, 0.06, -1.48);
  const accents = own(mergeGeometries([...trim.map(geometry => own(geometry.toNonIndexed())), own(engine.toNonIndexed())], false));
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xc8cabc, metalness: 0.12, roughness: 0.72 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x434b4b, metalness: 0.24, roughness: 0.65 });

  // Keep only the two merged geometries; temporary construction buffers are freed.
  for (const geometry of geometries) if (geometry !== body && geometry !== accents) geometry.dispose();
  let disposed = false;
  return {
    parts: [
      { name: 'Delta-wing airframes', geometry: body, material: bodyMaterial },
      { name: 'Airframe trailing-edge details', geometry: accents, material: trimMaterial },
    ],
    dispose() {
      if (disposed) return;
      disposed = true;
      body.dispose();
      accents.dispose();
      bodyMaterial.dispose();
      trimMaterial.dispose();
    },
  };
}
