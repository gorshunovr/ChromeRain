// ============================================================
//  CHROME RAIN — Cyberpunk 3D Scene
//  Three.js r160 + UnrealBloomPass
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ── Globals ──
let scene, camera, renderer, clock, composer, bloomPass;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
const velocity  = new THREE.Vector3();
const direction = new THREE.Vector3();
const euler     = new THREE.Euler(0, 0, 0, 'YXZ');
let isLocked = false;

// Rain — GPU-side LineSegments + ShaderMaterial.
// All animation runs in the vertex shader; the CPU only updates one uniform (uTime).
// No per-frame JS loop, no BufferAttribute uploads → near-zero CPU cost.
let rainLines, rainMat;
const RAIN_COUNT = 3000; // cheap to increase — GPU animates all of them

const flickerLights   = [];
const pulsingWindows  = [];   // windows that pulse with sin(time)
const pulsingSignMats = [];   // sign materials that pulse
const signLights      = [];   // PointLights in front of signs (pulse with signs)
const signCanvases    = [];   // canvas + ctx pairs for scanline animation on signs

let spinner;                  // flying vehicle
let spinnerAngle = 0;

// Collision — AABB list built at initBuildings() time, checked every frame
const buildingAABBs = [];     // { minX, maxX, minZ, maxZ } per building
const PLAYER_RADIUS = 1.2;    // collision half-extent around the camera (world units)
const MAP_LIMIT     = 85;     // invisible boundary wall distance from origin

// FPS counter state
let fpsFrames = 0, fpsLast = 0, fpsEl;

// Sign scanline throttle
let scanlineFrame = 0;
// PERF: only redraw sign canvases every 5 frames (~12fps at 60fps) instead of 15fps
const SCANLINE_EVERY = 5;

const PI = Math.PI;

function rand(a, b) { return Math.random() * (b - a) + a; }
function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================================================
//  1. SCENE SETUP
// ============================================================
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05051a);
  scene.fog = new THREE.Fog(0x0a0a1f, 20, 300);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(15, 5, 40);
  camera.lookAt(0, 5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // PERF: cap pixel ratio at 1.8 so Retina renders at ~3.5M px instead of ~5M px
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;
  document.body.appendChild(renderer.domElement);

  // Post-processing: RenderPass -> UnrealBloomPass -> OutputPass
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // PERF: lower bloom defaults — less blur passes = less GPU fill rate
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.5,   // strength  — default 0.5, max 1.0 via GUI slider
    0.4,   // radius    — tighter = fewer blur iterations
    0.3    // threshold — higher = fewer pixels enter bloom pipeline
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  clock = new THREE.Clock();
}

// ============================================================
//  2. LIGHTING
// PERF: reduced from 20 point lights to 13 — kept the most visible
//  street-level and sign-adjacent ones; removed distant weak ones.
//  Flicker speed halved so sin() oscillates slower (less visual noise
//  at distance AND cheaper perceptually justified updates).
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
    // Street-level intersection — highest impact
    [0, 6, 0], [10, 4, 10], [-10, 5, -10], [20, 7, 5], [-15, 3, 15],
    // Mid-range building walls
    [5, 10, -20], [25, 4, 0], [-5, 6, 25], [0, 8, -15],
    // Outer corners — fewer than before
    [-20, 5, 5], [10, 6, -25], [30, 4, 10], [-10, 8, 30]
  ];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const c = colors[i % colors.length];
    const light = new THREE.PointLight(c, 1.5, 40, 2);
    light.position.set(p[0], p[1], p[2]);
    scene.add(light);
    flickerLights.push({ light, base: light.intensity, speed: rand(0.6, 1.8), offset: rand(0, PI * 2) });
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
  scene.add(ground);

  // Road dashes — shared material instance (one material, many meshes)
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
    { x:  6, z: 0, sx: 0.3, sz: 200 },
    { x: -6, z: 0, sx: 0.3, sz: 200 },
    { x: 0, z:  6, sx: 200, sz: 0.3 },
    { x: 0, z: -6, sx: 200, sz: 0.3 }
  ].forEach(c => {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(c.sx, 0.3, c.sz), curbMat);
    curb.position.set(c.x, 0.15, c.z);
    scene.add(curb);
  });
}

// ============================================================
//  4. BUILDINGS — procedural cyberpunk towers
//  PERF: window count reduced by ~30% (20–42 per building vs 30–60).
//  Unlit windows removed entirely — they add draw calls with no visual gain.
//  Window pulsing rate reduced to 12% of windows (was 20%).
// ============================================================
function createBuilding(x, z, height, width, depth) {
  const group = new THREE.Group();

  // Main body — dark tower
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.8, metalness: 0.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMat);
  body.position.y = height / 2;
  group.add(body);

  // Detail protrusions — shared material per building
  const detailMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const detailCount = Math.floor(rand(2, 4));
  for (let d = 0; d < detailCount; d++) {
    const dw = rand(1, width * 0.4);
    const dh = rand(0.5, 3);
    const dd = rand(1, depth * 0.4);
    const detail = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, dd), detailMat);
    const face = Math.floor(rand(0, 4));
    const dy = rand(2, height - 2);
    if      (face === 0) detail.position.set( width / 2 + dw / 4, dy, rand(-depth / 3, depth / 3));
    else if (face === 1) detail.position.set(-width / 2 - dw / 4, dy, rand(-depth / 3, depth / 3));
    else if (face === 2) detail.position.set(rand(-width / 3, width / 3), dy,  depth / 2 + dd / 4);
    else                 detail.position.set(rand(-width / 3, width / 3), dy, -depth / 2 - dd / 4);
    group.add(detail);
  }

  // Windows — only lit ones
  // toneMapped: false lets high emissiveIntensity feed the bloom pass unclipped
  const windowColors = [0xffaa33, 0x00ffff, 0xff00ff, 0xffcc00, 0x33ccff, 0xff5588];
  const winCount = Math.floor(rand(20, 42)); // was 30–60
  for (let w = 0; w < winCount; w++) {
    const wColor = pick(windowColors);
    const ei = rand(5, 8);
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: wColor, emissiveIntensity: ei,
      roughness: 0.3, metalness: 0.0, toneMapped: false
    });
    const winSize = rand(0.3, 0.8);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(winSize, winSize * rand(0.8, 1.5)), winMat);
    const wy   = rand(1, height - 1);
    const side = Math.floor(rand(0, 4));
    if      (side === 0) { win.position.set( width / 2 + 0.05, wy, rand(-depth / 2 + 0.5, depth / 2 - 0.5)); win.rotation.y = 0;  }
    else if (side === 1) { win.position.set(-width / 2 - 0.05, wy, rand(-depth / 2 + 0.5, depth / 2 - 0.5)); win.rotation.y = PI; }
    else if (side === 2) { win.position.set(rand(-width / 2 + 0.5, width / 2 - 0.5), wy,  depth / 2 + 0.05); win.rotation.y = 0;  }
    else                 { win.position.set(rand(-width / 2 + 0.5, width / 2 - 0.5), wy, -depth / 2 - 0.05); win.rotation.y = PI; }
    group.add(win);
    // PERF: only 12% of windows pulse
    if (Math.random() < 0.12) {
      pulsingWindows.push({ mat: winMat, base: ei, speed: rand(0.5, 1.5), offset: rand(0, PI * 2) });
    }
  }

  // Rooftop antenna + blinking light
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
    flickerLights.push({ light: blink, base: 0.5, speed: rand(1.0, 2.5), offset: rand(0, PI * 2) });
  }

  // Neon rooftop trim
  if (Math.random() > 0.5) {
    const trimColor = pick([0x00ffff, 0xff00ff, 0xff0088, 0x00ffaa]);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: trimColor, emissiveIntensity: 6,
      roughness: 0.2, metalness: 0.0, toneMapped: false
    });
    const trimW = width + 0.4, trimD = depth + 0.4;
    [
      { s: [trimW, 0.15, 0.1], p: [0, height,  depth / 2 + 0.2] },
      { s: [trimW, 0.15, 0.1], p: [0, height, -depth / 2 - 0.2] },
      { s: [0.1, 0.15, trimD], p: [ width / 2 + 0.2, height, 0] },
      { s: [0.1, 0.15, trimD], p: [-width / 2 - 0.2, height, 0] }
    ].forEach(s => {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(...s.s), trimMat);
      strip.position.set(...s.p);
      group.add(strip);
    });
  }

  group.position.set(x, 0, z);
  return group;
}

function initBuildings() {
  const layouts = [
    { x:  14, z:  14, h: rand(20, 50), w: rand(6, 10), d: rand(6, 10) },
    { x:  26, z:  14, h: rand(15, 35), w: rand(5,  8), d: rand(6,  9) },
    { x:  14, z:  26, h: rand(25, 55), w: rand(7, 11), d: rand(5,  9) },
    { x: -14, z:  14, h: rand(30, 60), w: rand(6, 10), d: rand(6, 10) },
    { x: -26, z:  18, h: rand(18, 40), w: rand(5,  9), d: rand(7, 10) },
    { x:  14, z: -14, h: rand(22, 45), w: rand(7, 10), d: rand(6,  9) },
    { x:  28, z: -16, h: rand(15, 30), w: rand(5,  8), d: rand(6,  8) },
    { x:  14, z: -28, h: rand(35, 60), w: rand(8, 12), d: rand(6, 10) },
    { x: -14, z: -14, h: rand(25, 50), w: rand(6, 10), d: rand(6, 10) },
    { x: -26, z: -14, h: rand(20, 40), w: rand(6,  9), d: rand(5,  8) },
    { x: -14, z: -28, h: rand(28, 55), w: rand(7, 11), d: rand(7, 10) },
    { x: -28, z:  28, h: rand(50, 75), w: rand(8, 12), d: rand(8, 12) }
  ];
  layouts.forEach(b => {
    scene.add(createBuilding(b.x, b.z, b.h, b.w, b.d));
    // Register AABB for collision — half-extents from building centre
    buildingAABBs.push({
      minX: b.x - b.w / 2,
      maxX: b.x + b.w / 2,
      minZ: b.z - b.d / 2,
      maxZ: b.z + b.d / 2,
    });
  });
}

// ============================================================
//  5. NEON SIGNS — emissive + PointLights + pulsing + scanlines
// ============================================================
// Renders the static base layer of a neon sign onto a canvas:
// semi-transparent background, glowing border, double-drawn text for a
// soft-glow halo effect.  The canvas is later used as both map + emissiveMap
// on the sign's MeshStandardMaterial so the bloom pass picks it up.
function drawSignBase(text, color, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // Dark translucent panel background
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, h);

  // Glowing neon border
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.shadowColor = color; ctx.shadowBlur = 15;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  // Text — drawn twice: first pass at 20px blur, second at 40px blur
  // so the canvas itself carries the halo before Three.js bloom is applied
  const fontSize = Math.floor(h * 0.35);
  ctx.font = `bold ${fontSize}px Courier New, monospace`;
  ctx.fillStyle = color; ctx.shadowColor = color;
  ctx.shadowBlur = 20; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 40;  // second pass: wider halo
  ctx.fillText(text, w / 2, h / 2);

  return { canvas: c, ctx };
}

// Creates a static copy of a canvas.  Used as the clean "base frame" that the
// scrolling scanline pass draws on top of each frame, so we never lose the
// original sign art when the scanline overlay is redrawn.
function snapshotCanvas(canvas) {
  const snap = document.createElement('canvas');
  snap.width = canvas.width; snap.height = canvas.height;
  snap.getContext('2d').drawImage(canvas, 0, 0);
  return snap;
}

// Converts a CSS hex string like '#ff00ff' to a Three.js numeric color value.
function cssToHex(css) { return parseInt(css.replace('#', ''), 16); }

function initNeonSigns() {
  const signs = [
    { text: 'NEON HEAVEN',                                      color: '#00ffff', x:  14.5, y: 12, z:   8.5, w: 256, h: 64, ry: 0,        vertical: false },
    { text: 'KRAKEN CORP',                                      color: '#ff00ff', x:  -9,   y: 18, z:  14.5, w: 256, h: 64, ry: PI / 2,   vertical: false },
    { text: '\u6771\u4eac\u96fb\u8133',                         color: '#ff0088', x:  14.5, y: 22, z:  -8.5, w: 200, h: 80, ry: 0,        vertical: true  },
    { text: 'SYNTHWAVE',                                        color: '#00ffaa', x:  -9,   y: 10, z: -14.5, w: 256, h: 64, ry: -PI / 2,  vertical: false },
    { text: '\u591c\u306e\u8857',                               color: '#ffaa00', x:   9,   y: 15, z:  14.5, w: 180, h: 80, ry: 0,        vertical: true  },
    { text: '2 0 7 7',                                          color: '#ff4488', x: -14.5, y: 25, z:  -9,   w: 200, h: 64, ry: PI / 2,   vertical: false },
    { text: '\u30c7\u30fc\u30bf\u30ea\u30f3\u30af',             color: '#00ccff', x:  28.5, y:  8, z: -10,   w: 256, h: 80, ry: 0,        vertical: false }
  ];

  signs.forEach((s, idx) => {
    const base     = drawSignBase(s.text, s.color, s.w, s.h);
    const snapshot = snapshotCanvas(base.canvas);
    const tex      = new THREE.CanvasTexture(base.canvas);

    const aspect = s.w / s.h;
    const planeH = s.vertical ? 5 : 2.5;
    const planeW = s.vertical ? 2.5 : planeH * aspect;

    const emissiveColor = cssToHex(s.color);
    const baseEI = rand(5, 8);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex,
      emissive: emissiveColor, emissiveIntensity: baseEI,
      roughness: 0.3, metalness: 0.0,
      transparent: true, side: THREE.DoubleSide, toneMapped: false
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.rotation.y = s.ry;
    mesh.rotation.z = rand(-0.05, 0.05);
    mesh.rotation.x = rand(-0.03, 0.03);
    scene.add(mesh);

    pulsingSignMats.push({ mat, base: baseEI, speed: rand(0.4, 1.2), offset: rand(0, PI * 2) });

    signCanvases.push({ canvas: base.canvas, ctx: base.ctx, snapshot, tex, w: s.w, h: s.h });

    // PointLight in front of sign
    const lx = s.x + Math.sin(s.ry) * 2.0;
    const lz = s.z + Math.cos(s.ry) * 2.0;
    const signLight = new THREE.PointLight(emissiveColor, 3.0, 18, 2);
    signLight.position.set(lx, s.y, lz);
    scene.add(signLight);
    signLights.push({ light: signLight, base: 3.0, idx });
  });
}

// Redraws each sign's scanline overlay onto its canvas each time it's called.
// Technique: stamp the clean snapshot back, then paint thin horizontal dark
// bands that shift downward over time — giving the classic CRT scanline effect.
// PERF: called only every SCANLINE_EVERY frames, not every frame.
function updateSignScanlines(time) {
  for (let i = 0; i < signCanvases.length; i++) {
    const sc  = signCanvases[i];
    const ctx = sc.ctx;

    // Restore the static base art (sign text + border)
    ctx.drawImage(sc.snapshot, 0, 0);

    // Scrolling scanlines: offset advances with time, wraps within lineSpacing
    const lineSpacing  = 6;
    const scrollOffset = (time * 30) % lineSpacing;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = scrollOffset; y < sc.h; y += lineSpacing) {
      ctx.fillRect(0, y, sc.w, 2); // 2px dark band every 6px
    }

    // Flag the texture as dirty so Three.js re-uploads to GPU next render
    sc.tex.needsUpdate = true;
  }
}

// ============================================================
//  6. RAIN SYSTEM — fully GPU-side via ShaderMaterial
//
//  All per-drop state is baked into static buffer attributes at init
//  time and never touched again.  The vertex shader computes each
//  drop's current Y position from a single uTime uniform using modulo
//  arithmetic — one draw call, zero JS loops, zero buffer uploads
//  per frame.
//
//  Each raindrop is a LineSegments pair (2 vertices):
//    vertex 0 (isTop=1): top of the streak
//    vertex 1 (isTop=0): bottom of the streak
//
//  Buffer layout per vertex:
//    position : (spawnX, maxY, spawnZ)  — spawn origin, static
//    aData    : (speed, phase, isTop)   — fall speed (u/s), phase
//               offset (world units), top-vs-bottom flag
//
//  Fog chunks are included so rain fades with the scene fog naturally.
// ============================================================
function initRain() {
  const SPREAD_X = 120, SPREAD_Z = 120, MAX_Y = 80;
  const STREAK   = 0.6; // world-unit streak length

  // 2 vertices per drop (top + bottom of each streak segment)
  const posArr  = new Float32Array(RAIN_COUNT * 2 * 3); // spawnX, maxY, spawnZ
  const dataArr = new Float32Array(RAIN_COUNT * 2 * 3); // speed, phase, isTop

  for (let i = 0; i < RAIN_COUNT; i++) {
    const sx    = rand(-SPREAD_X / 2, SPREAD_X / 2);
    const sz    = rand(-SPREAD_Z / 2, SPREAD_Z / 2);
    const speed = rand(25, 60);           // units per second
    const phase = rand(0, MAX_Y);         // initial Y offset so drops are staggered

    for (let v = 0; v < 2; v++) {
      const pi = (i * 2 + v) * 3;
      // Spawn origin stored in the position attribute (static, never re-uploaded)
      posArr[pi]     = sx;
      posArr[pi + 1] = MAX_Y; // used as the fall-volume height in the shader
      posArr[pi + 2] = sz;
      // Per-vertex animation data
      dataArr[pi]     = speed;
      dataArr[pi + 1] = phase;
      dataArr[pi + 2] = v === 0 ? 1.0 : 0.0; // 1=top vertex, 0=bottom vertex
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr,  3));
  geo.setAttribute('aData',    new THREE.BufferAttribute(dataArr, 3));

  // Vertex shader: compute current Y entirely on the GPU from uTime.
  // Modulo arithmetic wraps each drop back to the top once it hits zero.
  // Three.js fog chunks are included so distant rain fades with scene fog.
  const vertexShader = /* glsl */`
    attribute vec3 aData;   // x=speed (u/s), y=phase (world units), z=isTop
    uniform float uTime;

    #include <fog_pars_vertex>

    void main() {
      float speed = aData.x;
      float phase = aData.y;
      float isTop = aData.z;
      float maxY  = position.y; // maxY is stored in origin's Y slot

      // Linear fall with modulo wrap: drop moves from maxY down to 0, then repeats
      float y = maxY - mod(uTime * speed + phase, maxY);
      // Top vertex sits one STREAK_LEN above the bottom vertex
      y += isTop * ${STREAK.toFixed(2)};

      vec4 mvPosition = modelViewMatrix * vec4(position.x, y, position.z, 1.0);
      gl_Position = projectionMatrix * mvPosition;

      #include <fog_vertex>
    }
  `;

  // Fragment shader: flat blue-white colour; fog applied by the included chunk.
  // fog_pars_fragment already declares fogColor/fogNear/fogFar — don't redeclare.
  const fragmentShader = /* glsl */`
    #include <fog_pars_fragment>

    void main() {
      gl_FragColor = vec4(0.55, 0.65, 0.88, 0.45);
      #include <fog_fragment>
    }
  `;

  rainMat = new THREE.ShaderMaterial({
    uniforms:       THREE.UniformsUtils.merge([
      THREE.UniformsLib['fog'],         // injects fogColor / fogNear / fogFar
      { uTime: { value: 0.0 } }
    ]),
    vertexShader,
    fragmentShader,
    transparent:    true,
    depthWrite:     false,              // avoids depth artefacts with transparent streaks
    fog:            true,              // tells Three.js to keep fog uniforms in sync
  });

  rainLines = new THREE.LineSegments(geo, rainMat);
  scene.add(rainLines);
}

// Zero CPU work per frame — just advance the uTime uniform.
// The vertex shader does all position arithmetic on the GPU.
function updateRain(delta) {
  rainMat.uniforms.uTime.value += delta;
}

// ============================================================
//  7. FLYING VEHICLE ("SPINNER")
//  A Blade-Runner-style police spinner: body + canopy + swept wings +
//  engine nacelles + running lights (white front, red/blue rear) +
//  emissive thruster glows that feed the bloom pass.
//  PERF: updateSpinner now takes delta for frame-rate-independent speed
// ============================================================
function initSpinner() {
  spinner = new THREE.Group();

  // Main fuselage
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.4, metalness: 0.6 });
  spinner.add(new THREE.Mesh(new THREE.BoxGeometry(3, 1, 6), bodyMat));

  // Tinted canopy — slightly transparent so lights inside bleed through
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x113344, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.7
  });
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 2.5), canopyMat);
  canopy.position.set(0, 0.7, 0.5);
  spinner.add(canopy);

  // Swept wings (left = -3, right = +3)
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.6, metalness: 0.4 });
  [-3, 3].forEach(xp => {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 2), wingMat);
    wing.position.set(xp, 0, -1);
    spinner.add(wing);
  });

  // Engine nacelles under each wing
  const nacelleMat = new THREE.MeshStandardMaterial({ color: 0x0a0a15, roughness: 0.5 });
  [-3.5, 3.5].forEach(xp => {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.5, 8), nacelleMat);
    nac.position.set(xp, -0.5, -1);
    spinner.add(nac);
  });

  // White forward headlight
  const headlight = new THREE.PointLight(0xffffff, 2, 30);
  headlight.position.set(0, -0.3, 3.5);
  spinner.add(headlight);

  // Red/blue starboard & port tail navigation lights
  const tailR = new THREE.PointLight(0xff0000, 1, 15);
  tailR.position.set(1, 0, -3.5);
  spinner.add(tailR);

  const tailB = new THREE.PointLight(0x0000ff, 1, 15);
  tailB.position.set(-1, 0, -3.5);
  spinner.add(tailB);

  // Thruster glow — emissive sphere at each nacelle exit.
  // toneMapped: false ensures high emissiveIntensity isn't clamped before bloom.
  const thrustMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x4488ff, emissiveIntensity: 8, toneMapped: false
  });
  [-3.5, 3.5].forEach(xp => {
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), thrustMat);
    glow.position.set(xp, -0.8, -1.5);
    spinner.add(glow);
  });

  spinner.position.set(0, 50, 0);
  scene.add(spinner);
}

// Orbits the spinner around the city in an ellipse at ~50 units height.
// A secondary sin at 2× frequency adds a gentle vertical bob.
// lookAt() is called on the next orbit position (angle + 0.05) so the
// spinner always faces the direction of travel.
// PERF: delta-time angle increment instead of hard-coded 0.016
function updateSpinner(delta) {
  spinnerAngle += 0.15 * delta;
  const x = Math.cos(spinnerAngle) * 35;
  const z = Math.sin(spinnerAngle) * 25;
  const y = 50 + Math.sin(spinnerAngle * 2) * 3; // gentle bob
  spinner.position.set(x, y, z);
  // Point nose toward next position on the orbit path
  spinner.lookAt(
    Math.cos(spinnerAngle + 0.05) * 35,
    y,
    Math.sin(spinnerAngle + 0.05) * 25
  );
}

// ============================================================
//  8. POINTER LOCK CONTROLS
//  Clicking the canvas requests pointer lock (hides OS cursor, gives raw
//  mouse deltas).  While locked, mouse deltas rotate the camera via a
//  YXZ Euler — yaw (Y) is unbounded, pitch (X) is clamped to ±~81° so
//  you can't flip upside down.  WASD sets movement flags; velocity is
//  integrated in updateControls() each frame.  ESC releases the lock.
// ============================================================
function initControls() {
  const canvas    = renderer.domElement;
  const crosshair = document.getElementById('crosshair');

  // Click to lock pointer; also marks audio as user-interacted (iOS/Chrome requirement)
  canvas.addEventListener('click', () => { canvas.requestPointerLock(); unlockAudio(); });

  // Show/hide the CSS crosshair element based on lock state
  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas;
    crosshair.style.display = isLocked ? 'block' : 'none';
  });

  // Raw mouse deltas → camera rotation (YXZ Euler avoids gimbal lock for FPS look)
  document.addEventListener('mousemove', e => {
    if (!isLocked) return;
    const sensitivity = 0.002;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * sensitivity;                                             // yaw
    euler.x  = Math.max(-PI / 2.2, Math.min(PI / 2.2, euler.x - e.movementY * sensitivity)); // pitch, clamped
    camera.quaternion.setFromEuler(euler);
  });

  // WASD — set movement flags (actual velocity applied in updateControls)
  document.addEventListener('keydown', e => {
    if (e.code === 'KeyW') moveForward  = true;
    if (e.code === 'KeyS') moveBackward = true;
    if (e.code === 'KeyA') moveLeft     = true;
    if (e.code === 'KeyD') moveRight    = true;
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'KeyW') moveForward  = false;
    if (e.code === 'KeyS') moveBackward = false;
    if (e.code === 'KeyA') moveLeft     = false;
    if (e.code === 'KeyD') moveRight    = false;
  });
}

// ============================================================
//  8b. AUDIO
//  Browsers block autoplay until a user gesture occurs.  We gate playback
//  behind a click (the pointer-lock click counts) — unlockAudio() updates
//  the helper label once the context is warm.  The toggle button then
//  lets the user start/stop the ambience track independently.
// ============================================================
let audioAmbience, ambienceOn = false, audioUnlocked = false;

function initAudio() {
  audioAmbience = document.getElementById('audio-ambience');
  audioAmbience.volume = 0.5; // initial volume matches the slider default (50)

  // Toggle button — play/pause and flip the speaker icon
  document.getElementById('audio-toggle').addEventListener('click', () => {
    ambienceOn = !ambienceOn;
    ambienceOn ? audioAmbience.play().catch(() => {}) : audioAmbience.pause();
    document.getElementById('audio-icon').innerHTML = ambienceOn ? '&#x1f50a;' : '&#x1f507;';
  });

  // Volume slider → live audio volume (0–1 range)
  document.getElementById('audio-vol').addEventListener('input', function () {
    audioAmbience.volume = this.value / 100;
  });
}

// Called on the first user click (pointer-lock request).
// Updates the hint label to tell the user they can now press the toggle.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  document.querySelector('.vol-label').textContent = 'Toggle above to play';
}

// ============================================================
//  8c. BLOOM GUI
//  Wires the three HTML range sliders to UnrealBloomPass parameters.
//  Sliders store integer values (0–150 / 0–100) and are divided by 100
//  to get the float the pass expects.  On init the sliders are synced
//  back to match the actual bloomPass defaults set in initScene(), so
//  the display never lies about the starting state.
// ============================================================
function initBloomGUI() {
  const ss = document.getElementById('bloom-strength');
  const rs = document.getElementById('bloom-radius');
  const ts = document.getElementById('bloom-threshold');

  // Sync display labels to actual bloomPass values (not the HTML value attribute)
  document.getElementById('bloom-strength-val').textContent  = bloomPass.strength.toFixed(2);
  document.getElementById('bloom-radius-val').textContent    = bloomPass.radius.toFixed(2);
  document.getElementById('bloom-threshold-val').textContent = bloomPass.threshold.toFixed(2);

  // Sync slider thumb positions: multiply float → integer range
  // e.g. strength 1.1 → slider value 110
  ss.value = Math.round(bloomPass.strength  * 100);
  rs.value = Math.round(bloomPass.radius    * 100);
  ts.value = Math.round(bloomPass.threshold * 100);

  ss.addEventListener('input', function () {
    bloomPass.strength = this.value / 100;
    document.getElementById('bloom-strength-val').textContent = bloomPass.strength.toFixed(2);
  });
  rs.addEventListener('input', function () {
    bloomPass.radius = this.value / 100;
    document.getElementById('bloom-radius-val').textContent = bloomPass.radius.toFixed(2);
  });
  ts.addEventListener('input', function () {
    bloomPass.threshold = this.value / 100;
    document.getElementById('bloom-threshold-val').textContent = bloomPass.threshold.toFixed(2);
  });
}

// ============================================================
//  9. FPS COUNTER — updates once per second in the HUD
// ============================================================
function initFPS() {
  fpsEl = document.getElementById('fps-counter');
  fpsLast = performance.now();
}

function updateFPS(now) {
  fpsFrames++;
  const elapsed = now - fpsLast;
  if (elapsed >= 1000) {
    const fps = Math.round(fpsFrames * 1000 / elapsed);
    if (fpsEl) fpsEl.textContent = `${fps} FPS`;
    fpsFrames = 0;
    fpsLast   = now;
  }
}

// ============================================================
//  10. MOVEMENT — delta-time, capped velocity
//  Uses an exponential drag model: velocity decays by 10× per second
//  (instead of a hard cap) so movement feels snappy without an
//  abrupt stop.  translateX/Z operate in camera-local space so
//  strafe/forward always align with where you're looking.
// ============================================================
function updateControls(delta) {
  if (!isLocked) return;

  // Exponential drag — multiplied by delta so it's frame-rate independent.
  // PERF: factor of 10 (was 8) bleeds velocity faster → snappier stops
  velocity.x -= velocity.x * 10.0 * delta;
  velocity.z -= velocity.z * 10.0 * delta;

  // Build a normalised direction vector from the four movement flags
  direction.z = Number(moveForward)  - Number(moveBackward);
  direction.x = Number(moveRight)    - Number(moveLeft);
  direction.normalize(); // diagonal movement stays the same speed

  const speed = 28; // units per second
  if (moveForward  || moveBackward) velocity.z -= direction.z * speed * delta;
  if (moveLeft     || moveRight)    velocity.x -= direction.x * speed * delta;

  // Apply in camera-local space so movement is relative to look direction
  camera.translateX(-velocity.x * delta);
  camera.translateZ( velocity.z * delta);

  // Floor clamp — prevent walking through the ground
  if (camera.position.y < 5) camera.position.y = 5;

  resolveCollisions();
}

// ============================================================
//  10b. COLLISION RESOLUTION
//  Treats the player as an axis-aligned square (half-extent PLAYER_RADIUS)
//  and pushes it out of any building AABB it overlaps.  Runs after every
//  movement update so the player can never pass through a building regardless
//  of frame rate or movement speed.
//
//  Push-out strategy: find the shallowest overlap axis and slide along it.
//  This feels natural — you slide along a wall rather than stopping dead.
//
//  A square map boundary at ±MAP_LIMIT is applied last.
// ============================================================
function resolveCollisions() {
  const pos = camera.position;

  for (const bb of buildingAABBs) {
    // Expand AABB by PLAYER_RADIUS on all sides
    const minX = bb.minX - PLAYER_RADIUS;
    const maxX = bb.maxX + PLAYER_RADIUS;
    const minZ = bb.minZ - PLAYER_RADIUS;
    const maxZ = bb.maxZ + PLAYER_RADIUS;

    if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
      // Compute penetration depth on all four sides
      const dLeft  = pos.x - minX;  // distance to push left
      const dRight = maxX - pos.x;  // distance to push right
      const dFront = pos.z - minZ;  // distance to push toward -Z
      const dBack  = maxZ - pos.z;  // distance to push toward +Z
      // Push out along the shallowest axis (minimum work)
      const minD = Math.min(dLeft, dRight, dFront, dBack);
      if      (minD === dLeft)  pos.x = minX;
      else if (minD === dRight) pos.x = maxX;
      else if (minD === dFront) pos.z = minZ;
      else                      pos.z = maxZ;
    }
  }

  // Hard map boundary — invisible walls at the city perimeter
  pos.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, pos.x));
  pos.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, pos.z));
}

// ============================================================
//  11. PUDDLES
//  Flat planes just above the ground (y=0.03) with near-zero roughness
//  and high metalness — this makes MeshStandardMaterial treat them as
//  mirror-like reflective surfaces, simulating wet asphalt.
//  All 12 puddles share a single material instance (one GPU state block).
// ============================================================
function initPuddles() {
  // Shared material: nearly specular (roughness 0.05), metallic (0.9), semi-transparent
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x050510, roughness: 0.05, metalness: 0.9,
    transparent: true, opacity: 0.6
  });
  for (let i = 0; i < 12; i++) {
    const puddle = new THREE.Mesh(
      new THREE.PlaneGeometry(rand(2, 6), rand(2, 6)), puddleMat
    );
    puddle.rotation.x = -PI / 2;                       // lay flat on ground
    puddle.position.set(rand(-30, 30), 0.03, rand(-30, 30)); // just above y=0
    scene.add(puddle);
  }
}

// ============================================================
//  12. DISTANT CITY BACKDROP
//  PERF: all backdrop towers use MeshBasicMaterial (already the case).
//  Backdrop window clusters also switched to MeshBasicMaterial — they're
//  so far away the lighting cost of MeshStandardMaterial was pure waste.
//  They still emit via emissive color on Basic mat → bloom picks them up.
// ============================================================
function initBackdrop() {
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x060612 });
  for (let i = 0; i < 30; i++) {
    const bh = rand(30, 90), bw = rand(5, 15), bd = rand(5, 15);
    const bg = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), bgMat);
    const angle = rand(0, PI * 2);
    const dist  = rand(100, 180);
    bg.position.set(Math.cos(angle) * dist, bh / 2, Math.sin(angle) * dist);
    scene.add(bg);

    if (Math.random() > 0.5) {
      // PERF: MeshBasicMaterial for backdrop windows — no lighting/PBR overhead
      // Bloom still works because OutputPass sees bright pixels regardless of material type
      const winColor = pick([0x00ffff, 0xff00ff, 0xffaa33]);
      const wm = new THREE.MeshBasicMaterial({ color: winColor });
      for (let w = 0; w < 8; w++) {
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
//  13. SMOKE
//  200 static low-opacity Points hugging the ground (y 0.5–4 u) to
//  simulate steam/exhaust wisps rising from street-level vents.
//  Static geometry — no per-frame updates needed.
//  depthWrite: false prevents the translucent points from punching holes
//  in each other when rendered back-to-front.
// ============================================================
function initSmoke() {
  const smokeMat = new THREE.PointsMaterial({
    color: 0x334455, size: 3, transparent: true, opacity: 0.15,
    depthWrite: false // avoids depth artefacts with overlapping transparent points
  });
  const smokeGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    pos[i * 3]     = rand(-60, 60);
    pos[i * 3 + 1] = rand(0.5, 4); // low to the ground — street-level smoke
    pos[i * 3 + 2] = rand(-60, 60);
  }
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(smokeGeo, smokeMat));
}

// ============================================================
//  14. RESIZE
//  Updates the camera projection matrix, renderer output size, and the
//  EffectComposer (and its internal render targets) whenever the window
//  changes size.  The pixel ratio cap is already set — setSize() respects it.
// ============================================================
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight); // also resizes bloom render targets
}

// ============================================================
//  15. ANIMATION LOOP
//  Drives all per-frame updates in order:
//    1. FPS counter    — counts frames, updates label every second
//    2. Rain           — moves Points geometry downward, recycles at bottom
//    3. Spinner        — orbits flying vehicle around the city
//    4. Controls       — applies WASD velocity to camera position
//    5. Light flicker  — sin-wave intensity on all neon point lights
//    6. Window pulse   — sin-wave emissiveIntensity on 12% of building windows
//    7. Sign pulse     — emissive + front PointLight pulsed together for signs
//    8. Sign scanlines — redrawn on the throttled cadence (every 5 frames)
//    9. Render         — EffectComposer runs RenderPass → BloomPass → OutputPass
// ============================================================
function animate(now) {
  requestAnimationFrame(animate);

  // clock.getDelta() advances the internal clock; cap at 50 ms so a tab
  // coming back from background doesn't produce a giant physics jump
  const delta = Math.min(clock.getDelta(), 0.05); // cap at 50 ms (20 fps floor)
  const time  = clock.elapsedTime;

  updateFPS(now);
  updateRain(delta);
  updateSpinner(delta);
  updateControls(delta);

  // Flicker neon street/building lights — sine wave per light with unique speed+offset
  for (let i = 0; i < flickerLights.length; i++) {
    const fl = flickerLights[i];
    fl.light.intensity = fl.base * (0.7 + 0.3 * Math.sin(time * fl.speed + fl.offset));
  }

  // Pulse emissive building windows (only the ~12% flagged at build time)
  for (let i = 0; i < pulsingWindows.length; i++) {
    const pw = pulsingWindows[i];
    pw.mat.emissiveIntensity = pw.base * (0.6 + 0.4 * Math.sin(time * pw.speed + pw.offset));
  }

  // Pulse neon sign materials AND their front PointLights in sync
  // so the light cast on surrounding geometry follows the sign's brightness
  for (let i = 0; i < pulsingSignMats.length; i++) {
    const ps    = pulsingSignMats[i];
    const pulse = 0.7 + 0.3 * Math.sin(time * ps.speed + ps.offset);
    ps.mat.emissiveIntensity      = ps.base * pulse;
    signLights[i].light.intensity = signLights[i].base * pulse;
  }

  // Throttled scanline redraw — canvas 2D ops every SCANLINE_EVERY frames (~12 fps at 60)
  // PERF: avoids per-frame canvas + GPU texture upload overhead
  scanlineFrame++;
  if (scanlineFrame >= SCANLINE_EVERY) {
    updateSignScanlines(time);
    scanlineFrame = 0;
  }

  // Final render through the post-processing chain
  composer.render();
}

// ============================================================
//  BOOT — initialise all subsystems in dependency order, then start loop
// ============================================================
initScene();       // renderer, camera, composer, bloomPass
initLights();      // ambient, directional, neon point lights
initGround();      // asphalt plane, road dashes, curbs
initBuildings();   // procedural towers with windows + neon trim
initNeonSigns();   // canvas-texture signs + front PointLights
initRain();        // Points geometry for rain drops
initSpinner();     // flying vehicle group
initControls();    // pointer lock + WASD listeners
initAudio();       // HTML audio element + UI panel wiring
initBloomGUI();    // bloom slider wiring + initial sync
initFPS();         // grab #fps-counter element
initPuddles();     // reflective ground puddle planes
initBackdrop();    // distant city silhouettes (MeshBasicMaterial)
initSmoke();       // low-altitude smoke Points
window.addEventListener('resize', onResize);
animate(performance.now()); // kick off the rAF loop
