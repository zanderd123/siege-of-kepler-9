/**
 * Renderer, lighting, environment and the planet itself.
 *
 * Realism here comes from three things rather than from asset detail:
 *  - a physically-lit setup (ACES tonemapping, one hard key light for the sun,
 *    cool fill bounce from the planet, near-black ambient)
 *  - a generated environment map, so metal hulls reflect *something* instead
 *    of reading as flat plastic
 *  - bloom on the emissive engine bells and weapon fire
 */
import * as THREE from 'three';
import { EffectComposer } from '../vendor/EffectComposer.js';
import { RenderPass } from '../vendor/RenderPass.js';
import { UnrealBloomPass } from '../vendor/UnrealBloomPass.js';
import { WORLD } from './config.js';
import { makeRng } from './util.js';

// ---------------------------------------------------------------------------
// Planet surface + clouds, drawn into canvases at load time.
// ---------------------------------------------------------------------------
function planetTexture(seed = 7) {
  const rng = makeRng(seed);
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = size; c.height = size / 2;
  const ctx = c.getContext('2d');

  // Ocean base with a latitude gradient.
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0.0, '#d8e6ef');
  g.addColorStop(0.12, '#2b6d92');
  g.addColorStop(0.5, '#0f4f74');
  g.addColorStop(0.88, '#2b6d92');
  g.addColorStop(1.0, '#dae8f0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  // Continents: blobs of overlapping ellipses, biome-tinted by latitude.
  for (let i = 0; i < 26; i++) {
    const cx = rng() * c.width;
    const cy = c.height * (0.16 + rng() * 0.68);
    const lat = Math.abs(cy / c.height - 0.5) * 2;
    const green = Math.floor(90 + (1 - lat) * 60 + rng() * 30);
    const red = Math.floor(60 + lat * 90 + rng() * 30);
    ctx.fillStyle = `rgb(${red},${green},${Math.floor(48 + rng() * 26)})`;
    const parts = 10 + Math.floor(rng() * 16);
    for (let p = 0; p < parts; p++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * 78;
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.6,
        18 + rng() * 46, 12 + rng() * 30, rng() * Math.PI, 0, Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // Polar caps.
  ctx.fillStyle = 'rgba(238,246,252,0.92)';
  ctx.fillRect(0, 0, c.width, c.height * 0.055);
  ctx.fillRect(0, c.height * 0.945, c.width, c.height * 0.055);

  // Fine noise so the surface isn't flat under close inspection.
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function cloudTexture(seed = 19) {
  const rng = makeRng(seed);
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  // Banded cloud systems — swirls stretched along latitude lines.
  for (let i = 0; i < 110; i++) {
    const cy = rng() * c.height;
    const band = 1 - Math.abs(cy / c.height - 0.5) * 1.4;
    if (rng() > band) continue;
    const cx = rng() * c.width;
    const w = 24 + rng() * 78;
    const h = 6 + rng() * 16;
    for (let p = 0; p < 7; p++) {
      ctx.beginPath();
      ctx.ellipse(cx + (rng() - 0.5) * w, cy + (rng() - 0.5) * h,
        w * (0.25 + rng() * 0.4), h * (0.5 + rng() * 0.6), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Rayleigh-ish rim glow: bright at grazing angles, invisible face-on. */
function makeAtmosphere(radius, color, power, intensity, side) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uIntensity;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        float f = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewW)));
        f = pow(clamp(f, 0.0, 1.0), uPower) * uIntensity;
        gl_FragColor = vec4(uColor * f, f);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: side ?? THREE.BackSide,
  });
}

// ---------------------------------------------------------------------------
// Deep-space backdrop: stars as a point cloud + a couple of nebula sheets.
// ---------------------------------------------------------------------------
function makeStarfield(rng, count = 7000, radius = 12000) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Uniform on a sphere.
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.75 + rng() * 0.25);
    pos[i * 3] = Math.cos(th) * s * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = Math.sin(th) * s * r;

    // Rough stellar-class colour spread, mostly white with blue/orange tails.
    const t = rng();
    if (t < 0.06) c.setHSL(0.58, 0.75, 0.78);
    else if (t < 0.18) c.setHSL(0.08, 0.6, 0.72);
    else c.setHSL(0.6, 0.12, 0.72 + rng() * 0.28);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    // Point size is in screen pixels. Stars must stay near-pointlike: at
    // more than ~3px they stop reading as stars and start reading as snow.
    size[i] = rng() < 0.012 ? 2.6 + rng() * 1.8 : 0.7 + rng() * 1.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: `
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // gl_PointSize is in device pixels, so scale by DPR to keep the
        // apparent size constant across displays.
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d);
        // Hard core with a thin halo — a star, not a puffball.
        float a = smoothstep(0.5, 0.18, r);
        gl_FragColor = vec4(vColor * (0.6 + 0.4 * a), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function nebulaTexture(rng, hue) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  // Keep the cloud mass toward the middle so the quad's edges stay empty.
  for (let i = 0; i < 70; i++) {
    const x = S * (0.5 + (rng() - 0.5) * 0.62);
    const y = S * (0.5 + (rng() - 0.5) * 0.62);
    const r = 40 + rng() * 150;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${hue + rng() * 40 - 20},70%,${30 + rng() * 26}%,0.22)`);
    g.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Radial alpha mask — without this the sheet reads as a lit rectangle
  // hanging in space rather than as a cloud.
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  mask.addColorStop(0.0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  mask.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A tiny emissive "room" rendered to a cubemap via PMREM. Metal hulls need
 * an environment to reflect or they look like matte plastic; this gives them
 * a bright sun side, a planet-lit underside and dark space elsewhere.
 */
function buildEnvironment(renderer) {
  const envScene = new THREE.Scene();
  const add = (color, intensity, pos, scale) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }),
    );
    m.position.set(...pos);
    m.scale.set(...scale);
    envScene.add(m);
  };
  envScene.background = new THREE.Color(0x02030a);
  add(0xfff2e0, 9.0, [40, 20, -30], [26, 26, 2]);   // sun
  add(0x3f7fbf, 1.1, [0, -40, 0], [90, 2, 90]);     // planet bounce
  add(0x121a2a, 0.6, [-45, 10, 25], [2, 60, 60]);   // faint deep-space fill
  add(0x2a1b3a, 0.5, [0, 40, 45], [70, 40, 2]);     // nebula side

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  return rt.texture;
}

export class SpaceScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 40000);
    this.camera.position.set(0, 700, -2400);

    this.env = buildEnvironment(this.renderer);
    this.scene.environment = this.env;

    const rng = makeRng(4242);

    // --- lighting -------------------------------------------------------
    // One hard key light standing in for the local star, plus a cool bounce
    // off the planet. Ambient stays almost black: this is space.
    this.sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    this.sun.position.set(900, 620, -700);
    this.scene.add(this.sun);

    this.bounce = new THREE.DirectionalLight(0x5590d0, 0.55);
    this.bounce.position.set(-300, -600, 300);
    this.scene.add(this.bounce);

    this.scene.add(new THREE.AmbientLight(0x1a2436, 0.35));

    // --- backdrop -------------------------------------------------------
    this.stars = makeStarfield(rng);
    this.scene.add(this.stars);

    // Nebulae sit outside the star shell so they read as far background.
    for (let i = 0; i < 3; i++) {
      const tex = nebulaTexture(rng, [255, 205, 300][i]);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(26000, 26000), mat);
      const a = (i / 3) * Math.PI * 2 + rng() * 1.2;
      sheet.position.set(Math.cos(a) * 15500, (rng() - 0.5) * 6000, Math.sin(a) * 15500);
      sheet.lookAt(0, 0, 0);
      sheet.frustumCulled = false;
      this.scene.add(sheet);
    }

    this.buildPlanet();

    // --- post ------------------------------------------------------------
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.85,
    );
    this.composer.addPass(this.bloom);

    addEventListener('resize', () => this.resize());
  }

  buildPlanet() {
    const R = WORLD.planetRadius;
    this.planet = new THREE.Group();
    this.planet.position.set(...WORLD.planetCenter);
    this.scene.add(this.planet);

    const surface = new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      new THREE.MeshStandardMaterial({
        map: planetTexture(), roughness: 0.92, metalness: 0.0,
        envMapIntensity: 0.25,
      }),
    );
    this.planet.add(surface);
    this.surface = surface;

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.012, 72, 48),
      new THREE.MeshStandardMaterial({
        map: cloudTexture(), transparent: true, opacity: 0.42,
        roughness: 1, metalness: 0, depthWrite: false,
      }),
    );
    this.planet.add(this.clouds);

    // Inner haze hugging the limb, outer halo bleeding into space.
    this.planet.add(new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.035, 64, 40),
      makeAtmosphere(R, 0x5aa9ff, 2.6, 0.9),
    ));
    this.planet.add(new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.14, 64, 40),
      makeAtmosphere(R, 0x2f7fd8, 3.4, 0.55),
    ));
  }

  update(dt) {
    if (this.clouds) this.clouds.rotation.y += dt * 0.004;
    if (this.surface) this.surface.rotation.y += dt * 0.002;
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  render() {
    this.composer.render();
  }
}
