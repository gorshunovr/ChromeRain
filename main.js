// ============================================================
//  NIGHT CITY — Cyberpunk 3D Scene
//  Three.js r160 module build + UnrealBloomPass
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ── Globals ──
let scene, camera, renderer, clock, composer, bloomPass;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
let isLocked = false;
let rainMesh, rainGeo;
const flickerLights = [];
const pulsingWindows = [];   // windows that pulse with sin(time)
const pulsingSignMats = [];  // sign materials that pulse
const signLights = [];       // PointLights in front of signs (pulse with signs)
const signCanvases = [];     // canvas + ctx pairs for scanline animation on signs
let spinner;                 // flying vehicle
let spinnerAngle = 0;
const rainDropCount = 2500;
const PI = Math.PI;

// ── Helpers ──
function rand(a, b) { return Math.random() * (b - a) + a; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================================================
//  1. SCENE SETUP — renderer, camera, post-processing composer
// ============================================================
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05051a);
  scene.fog = new THREE.Fog(0x0a0a1f, 20, 300);

  // Camera — street-level start
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(15, 5, 40);
  camera.lookAt(0, 5, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;
  document.body.appendChild(renderer.domElement);

  // Post-processing: RenderPass -> UnrealBloomPass -> OutputPass
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.5,   // strength  (tunable via GUI)
    0.5,   // radius    (tunable via GUI)
    0.25   // threshold (tunable via GUI)
  );
  composer.addPass(bloomPass);

  // OutputPass applies tone mapping + color space conversion after bloom
  composer.addPass(new OutputPass());

  clock = new THREE.Clock();
}

// ============================================================
//  2. LIGHTING
// ============================================================
function initLights() {
  // Dim ambient — just enough to see silhouettes
  scene.add(new THREE.AmbientLight(0x111122, 0.4));

  // Faint directional "moonlight"
  const dir = new THREE.DirectionalLight(0x334466, 0.25);
  dir.position.set(50, 80, 30);
  scene.add(dir);

  // Neon point lights scattered around the scene
  const colors = [0x00ffff, 0xff00ff, 0xff0088, 0x00ffaa, 0xff4400, 0x8800ff, 0x00ccff];
  const positions = [
    [0,6,0],[10,4,10],[-10,5,-10],[20,7,5],[-15,3,15],
    [5,10,-20],[25,4,0],[-5,6,25],[0,8,-15],[15,3,20],
    [-20,5,5],[10,6,-25],[30,4,10],[-10,8,30],[5,3,-30],
    [-25,6,0],[20,5,-15],[0,4,35],[-15,7,-20],[35,5,5]
  ];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const c = colors[i % colors.length];
    const light = new THREE.PointLight(c, 1.5, 40, 2);
    light.position.set(p[0], p[1], p[2]);
    scene.add(light);
    flickerLights.push({ light, base: light.intensity, speed: rand(1.5, 4), offset: rand(0, PI * 2) });
  }
}

// ============================================================
//  3. GROUND & STREETS
// ============================================================
function initGround() {
  // Wet dark asphalt — low roughness + metalness for reflective wet look
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.4, metalness: 0.3
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
  ground.rotation.x = -PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  // Road markings — dashed white lines along the two streets
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0x888888, emissive: 0x222222, emissiveIntensity: 1, roughness: 0.5
  });
  for (let z = -80; z < 80; z += 6) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 2), lineMat);
    dash.position.set(0, 0.02, z);
    scene.add(dash);
  }
  for (let x = -80; x < 80; x += 6) {
    const dash2 = new THREE.Mesh(new THREE.BoxGeometry(2, 0.02, 0.2), lineMat);
    dash2.position.set(x, 0.02, 0);
    scene.add(dash2);
  }

  // Sidewalk curbs
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7, metalness: 0.1 });
  [
    { x: 6, z: 0, sx: 0.3, sz: 200 },
    { x: -6, z: 0, sx: 0.3, sz: 200 },
    { x: 0, z: 6, sx: 200, sz: 0.3 },
    { x: 0, z: -6, sx: 200, sz: 0.3 }
  ].forEach(function(c) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(c.sx, 0.3, c.sz), curbMat);
    curb.position.set(c.x, 0.15, c.z);
    scene.add(curb);
  });
}

// ============================================================
//  4. BUILDINGS — procedural cyberpunk towers
// ============================================================
function createBuilding(x, z, height, width, depth) {
  const group = new THREE.Group();

  // Main body — dark tower
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x0c0c0c, roughness: 0.8, metalness: 0.2
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMat);
  body.position.y = height / 2;
  group.add(body);

  // Protruding detail boxes (AC units, ledges, structural)
  const detailCount = Math.floor(rand(2, 5));
  for (let d = 0; d < detailCount; d++) {
    const dw = rand(1, width * 0.4);
    const dh = rand(0.5, 3);
    const dd = rand(1, depth * 0.4);
    const detailMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    const detail = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, dd), detailMat);
    const face = Math.floor(rand(0, 4));
    const dy = rand(2, height - 2);
    if (face === 0) detail.position.set(width / 2 + dw / 4, dy, rand(-depth / 3, depth / 3));
    else if (face === 1) detail.position.set(-width / 2 - dw / 4, dy, rand(-depth / 3, depth / 3));
    else if (face === 2) detail.position.set(rand(-width / 3, width / 3), dy, depth / 2 + dd / 4);
    else detail.position.set(rand(-width / 3, width / 3), dy, -depth / 2 - dd / 4);
    group.add(detail);
  }

  // Windows — small emissive planes on walls (high emissiveIntensity for bloom)
  // toneMapped: false allows emissive values > 1 to pass through to the bloom pass
  const windowColors = [0xffaa33, 0x00ffff, 0xff00ff, 0xffcc00, 0x33ccff, 0xff5588, 0x000000, 0x000000];
  const winCount = Math.floor(rand(30, 60));
  for (let w = 0; w < winCount; w++) {
    const wColor = pick(windowColors);
    const isLit = wColor !== 0x000000;
    let winMat;
    if (isLit) {
      const ei = rand(5, 8);
      winMat = new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: wColor, emissiveIntensity: ei,
        roughness: 0.3, metalness: 0.0, toneMapped: false
      });
    } else {
      winMat = new THREE.MeshStandardMaterial({
        color: 0x050508, emissive: 0x000000,
        transparent: true, opacity: 0.3, roughness: 1, metalness: 0
      });
    }
    const winSize = rand(0.3, 0.8);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(winSize, winSize * rand(0.8, 1.5)), winMat);
    const wy = rand(1, height - 1);
    const side = Math.floor(rand(0, 4));
    if (side === 0) { win.position.set(width / 2 + 0.05, wy, rand(-depth / 2 + 0.5, depth / 2 - 0.5)); win.rotation.y = 0; }
    else if (side === 1) { win.position.set(-width / 2 - 0.05, wy, rand(-depth / 2 + 0.5, depth / 2 - 0.5)); win.rotation.y = PI; }
    else if (side === 2) { win.position.set(rand(-width / 2 + 0.5, width / 2 - 0.5), wy, depth / 2 + 0.05); win.rotation.y = 0; }
    else { win.position.set(rand(-width / 2 + 0.5, width / 2 - 0.5), wy, -depth / 2 - 0.05); win.rotation.y = PI; }
    group.add(win);
    // ~20% of lit windows pulse slowly
    if (isLit && Math.random() < 0.2) {
      pulsingWindows.push({ mat: winMat, base: winMat.emissiveIntensity, speed: rand(0.8, 2.5), offset: rand(0, PI * 2) });
    }
  }

  // Rooftop antenna
  if (Math.random() > 0.3) {
    const antMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
    const antH = rand(3, 8);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, antH, 6), antMat);
    ant.position.set(rand(-width / 4, width / 4), height + antH / 2, rand(-depth / 4, depth / 4));
    group.add(ant);
    const blink = new THREE.PointLight(0xff0000, 0.5, 8);
    blink.position.copy(ant.position);
    blink.position.y += antH / 2;
    group.add(blink);
    flickerLights.push({ light: blink, base: 0.5, speed: rand(2, 6), offset: rand(0, PI * 2) });
  }

  // Neon trim on rooftop edge — high emissive for bloom
  if (Math.random() > 0.5) {
    const trimColor = pick([0x00ffff, 0xff00ff, 0xff0088, 0x00ffaa]);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: trimColor, emissiveIntensity: 6,
      roughness: 0.2, metalness: 0.0, toneMapped: false
    });
    const trimW = width + 0.4;
    const trimD = depth + 0.4;
    [
      { s: [trimW, 0.15, 0.1], p: [0, height, depth / 2 + 0.2] },
      { s: [trimW, 0.15, 0.1], p: [0, height, -depth / 2 - 0.2] },
      { s: [0.1, 0.15, trimD], p: [width / 2 + 0.2, height, 0] },
      { s: [0.1, 0.15, trimD], p: [-width / 2 - 0.2, height, 0] }
    ].forEach(function(s) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(s.s[0], s.s[1], s.s[2]), trimMat);
      strip.position.set(s.p[0], s.p[1], s.p[2]);
      group.add(strip);
    });
  }

  group.position.set(x, 0, z);
  return group;
}

function initBuildings() {
  const layouts = [
    { x: 14, z: 14, h: rand(20, 50), w: rand(6, 10), d: rand(6, 10) },
    { x: 26, z: 14, h: rand(15, 35), w: rand(5, 8),  d: rand(6, 9) },
    { x: 14, z: 26, h: rand(25, 55), w: rand(7, 11), d: rand(5, 9) },
    { x: -14, z: 14, h: rand(30, 60), w: rand(6, 10), d: rand(6, 10) },
    { x: -26, z: 18, h: rand(18, 40), w: rand(5, 9),  d: rand(7, 10) },
    { x: 14, z: -14, h: rand(22, 45), w: rand(7, 10), d: rand(6, 9) },
    { x: 28, z: -16, h: rand(15, 30), w: rand(5, 8),  d: rand(6, 8) },
    { x: 14, z: -28, h: rand(35, 60), w: rand(8, 12), d: rand(6, 10) },
    { x: -14, z: -14, h: rand(25, 50), w: rand(6, 10), d: rand(6, 10) },
    { x: -26, z: -14, h: rand(20, 40), w: rand(6, 9),  d: rand(5, 8) },
    { x: -14, z: -28, h: rand(28, 55), w: rand(7, 11), d: rand(7, 10) },
    { x: -28, z: 28, h: rand(50, 75), w: rand(8, 12), d: rand(8, 12) }
  ];
  layouts.forEach(function(b) {
    scene.add(createBuilding(b.x, b.z, b.h, b.w, b.d));
  });
}

// ============================================================
//  5. NEON SIGNS — emissive materials, PointLights, pulsing, scanlines
// ============================================================

// Draw sign base content onto a canvas
function drawSignBase(text, color, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 15;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  const fontSize = Math.floor(h * 0.35);
  ctx.font = 'bold ' + fontSize + 'px Courier New, monospace';
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 40;
  ctx.fillText(text, w / 2, h / 2);
  return { canvas: c, ctx };
}

function snapshotCanvas(canvas) {
  const snap = document.createElement('canvas');
  snap.width = canvas.width; snap.height = canvas.height;
  snap.getContext('2d').drawImage(canvas, 0, 0);
  return snap;
}

function cssToHex(css) {
  return parseInt(css.replace('#', ''), 16);
}

function initNeonSigns() {
  const signs = [
    { text: 'NEON HEAVEN',        color: '#00ffff', x: 14.5,  y: 12, z: 8.5,  w: 256, h: 64, ry: 0, vertical: false },
    { text: 'KRAKEN CORP',        color: '#ff00ff', x: -9,    y: 18, z: 14.5, w: 256, h: 64, ry: PI / 2, vertical: false },
    { text: '\u6771\u4eac\u96fb\u8133',  color: '#ff0088', x: 14.5,  y: 22, z: -8.5, w: 200, h: 80, ry: 0, vertical: true },
    { text: 'SYNTHWAVE',          color: '#00ffaa', x: -9,    y: 10, z: -14.5,w: 256, h: 64, ry: -PI / 2, vertical: false },
    { text: '\u591c\u306e\u8857', color: '#ffaa00', x: 9,     y: 15, z: 14.5, w: 180, h: 80, ry: 0, vertical: true },
    { text: '2 0 7 7',            color: '#ff4488', x: -14.5, y: 25, z: -9,  w: 200, h: 64, ry: PI / 2, vertical: false },
    { text: '\u30c7\u30fc\u30bf\u30ea\u30f3\u30af', color: '#00ccff', x: 28.5, y: 8, z: -10, w: 256, h: 80, ry: 0, vertical: false }
  ];

  signs.forEach(function(s, idx) {
    const base = drawSignBase(s.text, s.color, s.w, s.h);
    const snapshot = snapshotCanvas(base.canvas);
    const tex = new THREE.CanvasTexture(base.canvas);

    const aspect = s.w / s.h;
    const planeH = s.vertical ? 5 : 2.5;
    const planeW = s.vertical ? 2.5 : planeH * aspect;

    // High emissiveIntensity + toneMapped:false = gorgeous bloom glow
    const emissiveColor = cssToHex(s.color);
    const baseEI = rand(5, 8);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: emissiveColor,
      emissiveIntensity: baseEI,
      roughness: 0.3, metalness: 0.0,
      transparent: true, side: THREE.DoubleSide,
      toneMapped: false
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.rotation.y = s.ry;
    mesh.rotation.z = rand(-0.05, 0.05);
    mesh.rotation.x = rand(-0.03, 0.03);
    scene.add(mesh);

    // Track for pulsing
    pulsingSignMats.push({
      mat, base: baseEI,
      speed: rand(0.5, 1.8), offset: rand(0, PI * 2)
    });

    // Track canvas for scanline animation
    signCanvases.push({
      canvas: base.canvas, ctx: base.ctx,
      snapshot, tex,
      w: s.w, h: s.h
    });

    // Bright PointLight in front of each sign (offset along normal)
    const lightOffset = 2.0;
    let lx = s.x, ly = s.y, lz = s.z;
    lx += Math.sin(s.ry) * lightOffset;
    lz += Math.cos(s.ry) * lightOffset;
    const signLight = new THREE.PointLight(emissiveColor, 3.0, 18, 2);
    signLight.position.set(lx, ly, lz);
    scene.add(signLight);
    signLights.push({ light: signLight, base: 3.0, idx });
  });
}

// Update sign canvases with animated horizontal scanlines
function updateSignScanlines(time) {
  for (let i = 0; i < signCanvases.length; i++) {
    const sc = signCanvases[i];
    const ctx = sc.ctx;
    // Redraw the clean base snapshot
    ctx.drawImage(sc.snapshot, 0, 0);
    // Overlay scrolling dark scan bands
    const lineSpacing = 6;
    const scrollOffset = (time * 30) % lineSpacing;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = scrollOffset; y < sc.h; y += lineSpacing) {
      ctx.fillRect(0, y, sc.w, 2);
    }
    sc.tex.needsUpdate = true;
  }
}

// ============================================================
//  6. RAIN SYSTEM — vertical line streaks
// ============================================================
function initRain() {
  rainGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(rainDropCount * 6);
  const spreadX = 120, spreadZ = 120, maxY = 80;

  for (let i = 0; i < rainDropCount; i++) {
    const x = rand(-spreadX / 2, spreadX / 2);
    const y = rand(0, maxY);
    const z = rand(-spreadZ / 2, spreadZ / 2);
    const len = rand(0.5, 2.0);
    const idx = i * 6;
    positions[idx]     = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
    positions[idx + 3] = x;
    positions[idx + 4] = y - len;
    positions[idx + 5] = z;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const rainMat = new THREE.LineBasicMaterial({
    color: 0x8899cc,
    transparent: true,
    opacity: 0.35
  });
  rainMesh = new THREE.LineSegments(rainGeo, rainMat);
  scene.add(rainMesh);
}

function updateRain(delta) {
  const pos = rainGeo.attributes.position.array;
  const speed = 40;
  const maxY = 80;
  const spreadX = 120, spreadZ = 120;

  for (let i = 0; i < rainDropCount; i++) {
    const idx = i * 6;
    const fall = speed * delta;
    pos[idx + 1] -= fall;
    pos[idx + 4] -= fall;
    if (pos[idx + 4] < 0) {
      const x = rand(-spreadX / 2, spreadX / 2);
      const z = rand(-spreadZ / 2, spreadZ / 2);
      const y = maxY + rand(0, 10);
      const len = rand(0.5, 2.0);
      pos[idx]     = x;
      pos[idx + 1] = y;
      pos[idx + 2] = z;
      pos[idx + 3] = x;
      pos[idx + 4] = y - len;
      pos[idx + 5] = z;
    }
  }
  rainGeo.attributes.position.needsUpdate = true;
}

// ============================================================
//  7. FLYING VEHICLE ("SPINNER")
// ============================================================
function initSpinner() {
  spinner = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.4, metalness: 0.6 });
  spinner.add(new THREE.Mesh(new THREE.BoxGeometry(3, 1, 6), bodyMat));

  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x113344, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.7
  });
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 2.5), canopyMat);
  canopy.position.set(0, 0.7, 0.5);
  spinner.add(canopy);

  const wingMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.6, metalness: 0.4 });
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 2), wingMat);
  wingL.position.set(-3, 0, -1);
  spinner.add(wingL);
  const wingR = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 2), wingMat);
  wingR.position.set(3, 0, -1);
  spinner.add(wingR);

  const nacelleMat = new THREE.MeshStandardMaterial({ color: 0x0a0a15, roughness: 0.5 });
  [-3.5, 3.5].forEach(function(xp) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.5, 8), nacelleMat);
    nac.position.set(xp, -0.5, -1);
    spinner.add(nac);
  });

  // Spinner lights
  const headlight = new THREE.PointLight(0xffffff, 2, 30);
  headlight.position.set(0, -0.3, 3.5);
  spinner.add(headlight);

  const tailR = new THREE.PointLight(0xff0000, 1, 15);
  tailR.position.set(1, 0, -3.5);
  spinner.add(tailR);
  const tailB = new THREE.PointLight(0x0000ff, 1, 15);
  tailB.position.set(-1, 0, -3.5);
  spinner.add(tailB);

  // Thruster glow — high emissive spheres bloom beautifully
  const thrustMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x4488ff, emissiveIntensity: 8,
    toneMapped: false
  });
  [-3.5, 3.5].forEach(function(xp) {
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), thrustMat);
    glow.position.set(xp, -0.8, -1.5);
    spinner.add(glow);
  });

  spinner.position.set(0, 50, 0);
  scene.add(spinner);
}

function updateSpinner() {
  const rx = 35, rz = 25, speed = 0.15;
  spinnerAngle += speed * 0.016;
  const x = Math.cos(spinnerAngle) * rx;
  const z = Math.sin(spinnerAngle) * rz;
  const y = 50 + Math.sin(spinnerAngle * 2) * 3;
  spinner.position.set(x, y, z);
  const nextX = Math.cos(spinnerAngle + 0.05) * rx;
  const nextZ = Math.sin(spinnerAngle + 0.05) * rz;
  spinner.lookAt(nextX, y, nextZ);
}

// ============================================================
//  8. POINTER LOCK CONTROLS
// ============================================================
function initControls() {
  const canvas = renderer.domElement;
  const crosshair = document.getElementById('crosshair');

  canvas.addEventListener('click', function () {
    canvas.requestPointerLock();
    unlockAudio();
  });

  document.addEventListener('pointerlockchange', function () {
    isLocked = document.pointerLockElement === canvas;
    crosshair.style.display = isLocked ? 'block' : 'none';
  });

  document.addEventListener('mousemove', function (e) {
    if (!isLocked) return;
    const sensitivity = 0.002;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * sensitivity;
    euler.x -= e.movementY * sensitivity;
    euler.x = Math.max(-PI / 2.2, Math.min(PI / 2.2, euler.x));
    camera.quaternion.setFromEuler(euler);
  });

  document.addEventListener('keydown', function (e) {
    switch (e.code) {
      case 'KeyW': moveForward  = true; break;
      case 'KeyS': moveBackward = true; break;
      case 'KeyA': moveLeft     = true; break;
      case 'KeyD': moveRight    = true; break;
    }
  });
  document.addEventListener('keyup', function (e) {
    switch (e.code) {
      case 'KeyW': moveForward  = false; break;
      case 'KeyS': moveBackward = false; break;
      case 'KeyA': moveLeft     = false; break;
      case 'KeyD': moveRight    = false; break;
    }
  });
}

// ============================================================
//  8b. AUDIO SYSTEM — single ambience track (rain + synth)
// ============================================================
let audioAmbience;
let ambienceOn = false;
let audioUnlocked = false;

function initAudio() {
  audioAmbience = document.getElementById('audio-ambience');
  audioAmbience.volume = 0.5;

  document.getElementById('audio-toggle').addEventListener('click', function () {
    ambienceOn = !ambienceOn;
    if (ambienceOn) {
      audioAmbience.play().catch(function () {});
    } else {
      audioAmbience.pause();
    }
    document.getElementById('audio-icon').innerHTML = ambienceOn ? '&#x1f50a;' : '&#x1f507;';
  });

  document.getElementById('audio-vol').addEventListener('input', function () {
    audioAmbience.volume = this.value / 100;
  });
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  document.querySelector('.vol-label').textContent = 'Toggle above to play';
}

// ============================================================
//  8c. BLOOM GUI — real-time bloom parameter tuning
// ============================================================
function initBloomGUI() {
  const strengthSlider = document.getElementById('bloom-strength');
  const radiusSlider   = document.getElementById('bloom-radius');
  const thresholdSlider = document.getElementById('bloom-threshold');
  const strengthVal  = document.getElementById('bloom-strength-val');
  const radiusVal    = document.getElementById('bloom-radius-val');
  const thresholdVal = document.getElementById('bloom-threshold-val');

  strengthSlider.addEventListener('input', function () {
    bloomPass.strength = this.value / 100;
    strengthVal.textContent = bloomPass.strength.toFixed(2);
  });
  radiusSlider.addEventListener('input', function () {
    bloomPass.radius = this.value / 100;
    radiusVal.textContent = bloomPass.radius.toFixed(2);
  });
  thresholdSlider.addEventListener('input', function () {
    bloomPass.threshold = this.value / 100;
    thresholdVal.textContent = bloomPass.threshold.toFixed(2);
  });
}

// ============================================================
//  9. MOVEMENT UPDATE
// ============================================================
function updateControls(delta) {
  if (!isLocked) return;
  velocity.x -= velocity.x * 8.0 * delta;
  velocity.z -= velocity.z * 8.0 * delta;
  direction.z = Number(moveForward) - Number(moveBackward);
  direction.x = Number(moveRight) - Number(moveLeft);
  direction.normalize();
  const speed = 30;
  if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
  if (moveLeft || moveRight)       velocity.x -= direction.x * speed * delta;
  camera.translateX(-velocity.x * delta);
  camera.translateZ(velocity.z * delta);
  if (camera.position.y < 5) camera.position.y = 5;
}

// ============================================================
//  10. PUDDLES — reflective ground patches for wet look
// ============================================================
function initPuddles() {
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x050510, roughness: 0.05, metalness: 0.9,
    transparent: true, opacity: 0.6
  });
  for (let i = 0; i < 12; i++) {
    const pw = rand(2, 6), pd = rand(2, 6);
    const puddle = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), puddleMat);
    puddle.rotation.x = -PI / 2;
    puddle.position.set(rand(-30, 30), 0.03, rand(-30, 30));
    scene.add(puddle);
  }
}

// ============================================================
//  11. DISTANT CITY BACKDROP — silhouette towers
// ============================================================
function initBackdrop() {
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x060612 });
  for (let i = 0; i < 30; i++) {
    const bh = rand(30, 90);
    const bw = rand(5, 15);
    const bd = rand(5, 15);
    const bg = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), bgMat);
    const angle = rand(0, PI * 2);
    const dist = rand(100, 180);
    bg.position.set(Math.cos(angle) * dist, bh / 2, Math.sin(angle) * dist);
    scene.add(bg);
    // Lit window clusters — emissive for distant bloom glow
    if (Math.random() > 0.5) {
      const winColor = pick([0x00ffff, 0xff00ff, 0xffaa33]);
      for (let w = 0; w < 8; w++) {
        const wm = new THREE.MeshStandardMaterial({
          color: 0x000000, emissive: winColor, emissiveIntensity: 4,
          toneMapped: false
        });
        const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), wm);
        wn.position.set(
          Math.cos(angle) * dist + rand(-bw / 3, bw / 3),
          rand(2, bh - 2),
          Math.sin(angle) * dist + rand(-bd / 3, bd / 3)
        );
        scene.add(wn);
      }
    }
  }
}

// ============================================================
//  12. SMOKE / GROUND FOG PARTICLES
// ============================================================
function initSmoke() {
  const smokeMat = new THREE.PointsMaterial({
    color: 0x334455, size: 3, transparent: true, opacity: 0.15,
    depthWrite: false
  });
  const smokeGeo = new THREE.BufferGeometry();
  const count = 200;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3]     = rand(-60, 60);
    pos[i * 3 + 1] = rand(0.5, 4);
    pos[i * 3 + 2] = rand(-60, 60);
  }
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(smokeGeo, smokeMat));
}

// ============================================================
//  13. RESIZE HANDLER — update renderer, composer, and camera
// ============================================================
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================
//  14. MAIN ANIMATION LOOP — render via composer (bloom pipeline)
// ============================================================
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  updateRain(delta);
  updateSpinner();
  updateControls(delta);

  // Flicker neon point lights (street / building)
  for (let i = 0; i < flickerLights.length; i++) {
    const fl = flickerLights[i];
    fl.light.intensity = fl.base * (0.7 + 0.3 * Math.sin(time * fl.speed + fl.offset));
  }

  // Pulse emissive windows
  for (let i = 0; i < pulsingWindows.length; i++) {
    const pw = pulsingWindows[i];
    pw.mat.emissiveIntensity = pw.base * (0.6 + 0.4 * Math.sin(time * pw.speed + pw.offset));
  }

  // Pulse neon sign emissiveIntensity + their PointLights in sync
  for (let i = 0; i < pulsingSignMats.length; i++) {
    const ps = pulsingSignMats[i];
    ps.mat.emissiveIntensity = ps.base * (0.7 + 0.3 * Math.sin(time * ps.speed + ps.offset));
  }
  for (let i = 0; i < signLights.length; i++) {
    const sl = signLights[i];
    const ps2 = pulsingSignMats[sl.idx];
    sl.light.intensity = sl.base * (0.7 + 0.3 * Math.sin(time * ps2.speed + ps2.offset));
  }

  // Animate scanlines on sign canvases (~15fps for perf)
  if (Math.floor(time * 15) !== Math.floor((time - delta) * 15)) {
    updateSignScanlines(time);
  }

  // Render through the post-processing composer (bloom pipeline)
  composer.render();
}

// ============================================================
//  BOOT — initialize everything and start the loop
// ============================================================
initScene();
initLights();
initGround();
initBuildings();
initNeonSigns();
initRain();
initSpinner();
initControls();
initAudio();
initBloomGUI();
initPuddles();
initBackdrop();
initSmoke();
window.addEventListener('resize', onResize);
animate();
