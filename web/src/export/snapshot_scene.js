// Builds a Three.js group from a baked snapshot (export/snapshot.js).
// Self-contained on purpose: THREE is passed in, so the same file runs in the
// viewer (GLB export) and inside a standalone HTML export.

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function linearColors(u8) {
  const out = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = srgbToLinear(u8[i] / 255);
  return out;
}

/** Load the terrain texture first (GLB export needs it before parsing). */
export function loadTexture(THREE, dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** @returns {Promise<any>} a THREE.Group */
export async function buildGroup(THREE, snap) {
  const group = new THREE.Group();
  group.name = snap.title || 'scene';
  group.userData = { crs: snap.crs, origin: snap.origin, created: snap.created, generator: '02 Geo3D Analyzer' };

  // Terrain.
  const t = snap.terrain;
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
  tg.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
  tg.setIndex(new THREE.BufferAttribute(t.index, 1));
  tg.computeVertexNormals();
  const tex = await loadTexture(THREE, t.texture);
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xb9b4a6, roughness: 0.95 }));
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  group.add(terrain);

  // Extrusions.
  for (const m of snap.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(linearColors(m.colors), 3));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }));
    mesh.name = m.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Trees and poles: instanced.
  const mat4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  for (const inst of snap.instances || []) {
    const d = inst.data;
    const count = d.length / 8;
    if (inst.kind === 'tree') {
      const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), count);
      const trunkGeom = new THREE.CylinderGeometry(0.12, 0.16, 1, 6);
      trunkGeom.translate(0, 0.5, 0);
      const trunks = new THREE.InstancedMesh(trunkGeom, new THREE.MeshStandardMaterial({ color: 0x6b5139 }), count);
      for (let i = 0; i < count; i++) {
        const [x, y, z, h, r] = d.subarray(i * 8, i * 8 + 5);
        const trunkH = Math.max(0.8, h - 1.6 * r);
        mat4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1.4, trunkH + 0.4, 1.4));
        trunks.setMatrixAt(i, mat4);
        mat4.compose(new THREE.Vector3(x, y + h - r, z), q, new THREE.Vector3(r, r * 1.05, r));
        crowns.setMatrixAt(i, mat4);
        col.setRGB(d[i * 8 + 5], d[i * 8 + 6], d[i * 8 + 7], THREE.SRGBColorSpace);
        crowns.setColorAt(i, col);
      }
      crowns.name = `${inst.name} crowns`;
      trunks.name = `${inst.name} trunks`;
      for (const m of [crowns, trunks]) { m.castShadow = true; group.add(m); }
    } else {
      const geom = new THREE.CylinderGeometry(0.22, 0.26, 1, 8);
      geom.translate(0, 0.5, 0);
      const poles = new THREE.InstancedMesh(geom, new THREE.MeshStandardMaterial({ roughness: 0.6 }), count);
      for (let i = 0; i < count; i++) {
        const [x, y, z, h] = d.subarray(i * 8, i * 8 + 4);
        mat4.compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(1, h + 0.2, 1));
        poles.setMatrixAt(i, mat4);
        col.setRGB(d[i * 8 + 5], d[i * 8 + 6], d[i * 8 + 7], THREE.SRGBColorSpace);
        poles.setColorAt(i, col);
      }
      poles.name = inst.name;
      poles.castShadow = true;
      group.add(poles);
    }
  }

  // Facade tiles.
  if (snap.facade && snap.facade.positions.length) {
    const f = snap.facade;
    const n = f.positions.length / 3;
    const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), n);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const nv = new THREE.Vector3();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(f.size, f.size, 1);
    for (let i = 0; i < n; i++) {
      nv.set(f.normals[i * 3], f.normals[i * 3 + 1], f.normals[i * 3 + 2]);
      q.setFromUnitVectors(zAxis, nv);
      p.set(f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]).addScaledVector(nv, 0.08);
      mat4.compose(p, q, s);
      tiles.setMatrixAt(i, mat4);
      col.setRGB(f.colors[i * 3] / 255, f.colors[i * 3 + 1] / 255, f.colors[i * 3 + 2] / 255, THREE.SRGBColorSpace);
      tiles.setColorAt(i, col);
    }
    tiles.name = 'facade results';
    group.add(tiles);
  }

  // Flood surface.
  if (snap.water) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(snap.water.positions, 3));
    g.computeVertexNormals();
    const w = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2f7fc1, transparent: true, opacity: 0.62, roughness: 0.15 }));
    w.name = 'water';
    group.add(w);
  }
  return group;
}

/** JSON with typed arrays as base64 (the HTML export embeds the snapshot like this). */
const TYPES = { Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array };
export function decodeSnapshot(json) {
  return JSON.parse(json, (k, v) => {
    if (v && typeof v === 'object' && v.__ta && TYPES[v.__ta]) {
      const bin = atob(v.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TYPES[v.__ta](bytes.buffer);
    }
    return v;
  });
}
