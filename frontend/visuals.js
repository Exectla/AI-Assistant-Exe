/* ============================================================
   A.B.D. — Couche visuelle "Coruscant" (WebGL natif, zéro dépendance)
   HoloBackground : abîme urbain, flux de trafic lointains (shader)
   HoloOrb        : sphère de particules holographique, audio-réactive
   DustField      : poussière holographique de premier plan (Canvas2D)
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   Utilitaires WebGL
   ------------------------------------------------------------ */

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Compilation shader : ${info}`);
  }
  return shader;
}

function buildProgram(gl, vertexSrc, fragmentSrc) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSrc));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Édition de liens : ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/* ------------------------------------------------------------
   HoloBackground — flux de données / trafic lointain de Coruscant.
   Fines lignes lumineuses (ambre, cyan, blanc) défilant lentement
   dans un abîme noir-gris très profond. Flouté par CSS pour rester
   en arrière-plan sans jamais gêner la lecture.
   ------------------------------------------------------------ */

const BG_VERTEX = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const BG_FRAGMENT = `
precision mediump float;
uniform float u_time;
uniform vec2  u_res;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  /* Abîme : noir profond montant vers un gris-bleu à peine perceptible */
  vec3 col = mix(vec3(0.004, 0.005, 0.007), vec3(0.020, 0.026, 0.034), uv.y);

  /* 5 couches de voies de circulation, parallaxe et vitesses alternées */
  for (int i = 0; i < 5; i++) {
    float fi    = float(i);
    float lanes = 26.0 + fi * 18.0;            /* densité de voies */
    float dir   = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    float speed = dir * (0.006 + 0.012 * fi);

    float y    = uv.y * lanes + fi * 13.7;
    float lane = floor(y);
    float fy   = fract(y) - 0.5;

    float seed = hash(vec2(lane, fi * 7.3));
    if (seed < 0.16) {                          /* voies clairsemées */
      float x = fract(uv.x * (0.55 + 0.3 * seed) + u_time * speed * (0.6 + seed) + seed * 9.0);

      /* Segments lumineux : véhicules filants espacés sur la voie */
      float cells = 5.0 + floor(seed * 7.0);
      float cx    = fract(x * cells + hash(vec2(seed, lane)) * 3.0);
      float head  = smoothstep(0.18, 0.0, cx);          /* tête brillante  */
      float trail = smoothstep(0.55, 0.0, cx) * 0.35;   /* traînée diffuse */
      float gate  = step(hash(vec2(lane * 1.7, floor(x * cells))), 0.6);

      float beam = exp(-fy * fy * (140.0 - fi * 14.0)); /* finesse du trait */

      vec3 tint = seed < 0.05
        ? vec3(1.00, 0.55, 0.22)                        /* ambre profond   */
        : (seed < 0.11 ? vec3(0.30, 0.88, 1.00)         /* cyan électrique */
                       : vec3(0.92, 0.95, 1.00));       /* blanc pur       */

      float depth = 0.35 + 0.65 * (fi / 4.0);           /* couches proches plus vives */
      col += tint * (head + trail) * gate * beam * 0.16 * depth;
    }
  }

  /* Vignettage doux : l'immensité se referme sur les bords */
  float vign = smoothstep(1.25, 0.45, length(uv - 0.5));
  col *= vign;

  gl_FragColor = vec4(col, 1.0);
}
`;

class HoloBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.start = performance.now();
  }

  init() {
    const gl = this.canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) {
      return false;
    }
    this.gl = gl;
    this.program = buildProgram(gl, BG_VERTEX, BG_FRAGMENT);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.uTime = gl.getUniformLocation(this.program, "u_time");
    this.uRes = gl.getUniformLocation(this.program, "u_res");

    this.resize();
    window.addEventListener("resize", () => this.resize());

    const render = () => {
      const t = (performance.now() - this.start) / 1000;
      gl.useProgram(this.program);
      gl.uniform1f(this.uTime, t);
      gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return true;
  }

  resize() {
    /* Demi-résolution : profondeur de champ naturelle + performance */
    this.canvas.width = Math.floor(window.innerWidth / 2);
    this.canvas.height = Math.floor(window.innerHeight / 2);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
}

/* ------------------------------------------------------------
   HoloOrb — hologramme tactique : sphère de ~1400 particules en
   rotation, réactive au volume de la voix (échelle + luminosité).
   ------------------------------------------------------------ */

const ORB_VERTEX = `
attribute vec3 a_pos;
uniform float u_time;
uniform float u_level;   /* volume vocal 0..1 */
uniform float u_pulse;   /* vitesse de respiration selon l'état */
uniform float u_dpr;
varying float v_glow;

void main() {
  float breathe = 0.030 * sin(u_time * u_pulse);
  float r = 1.0 + breathe + 0.22 * u_level;

  float ay = u_time * 0.30;
  float ax = 0.42 * sin(u_time * 0.07);
  mat3 rotY = mat3(cos(ay), 0.0, sin(ay),  0.0, 1.0, 0.0,  -sin(ay), 0.0, cos(ay));
  mat3 rotX = mat3(1.0, 0.0, 0.0,  0.0, cos(ax), -sin(ax),  0.0, sin(ax), cos(ax));

  vec3 p = rotY * rotX * (a_pos * r);
  float persp = 1.55 / (1.55 - p.z * 0.72);

  gl_Position = vec4(p.xy * persp * 0.72, 0.0, 1.0);
  gl_PointSize = (0.9 + 1.5 * persp) * u_dpr;
  v_glow = 0.25 + 0.75 * clamp((persp - 0.9) * 1.4, 0.0, 1.0);
}
`;

const ORB_FRAGMENT = `
precision mediump float;
uniform vec3  u_tint;
uniform float u_bright;
varying float v_glow;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(u_tint * v_glow * u_bright, a * v_glow * u_bright);
}
`;

/* Apparence de l'orbe selon l'état du noyau — cristal "Liquid Glass" :
   blancs glacés et reflets d'eau pure plutôt que néon. */
const ORB_STATES = {
  connecting: { pulse: 2.4, bright: 0.40, tint: [0.80, 0.87, 0.95] },
  online:     { pulse: 0.9, bright: 1.00, tint: [0.93, 0.97, 1.00] },
  listening:  { pulse: 3.4, bright: 1.15, tint: [1.00, 1.00, 1.00] },
  thinking:   { pulse: 5.0, bright: 1.10, tint: [1.00, 0.86, 0.62] },
  warning:    { pulse: 1.6, bright: 0.70, tint: [1.00, 0.78, 0.52] },
  offline:    { pulse: 0.4, bright: 0.18, tint: [0.66, 0.70, 0.76] },
};

class HoloOrb {
  constructor(canvas, container, levelProvider) {
    this.canvas = canvas;
    this.container = container;
    this.levelProvider = levelProvider;
    this.start = performance.now();
    this.smoothLevel = 0;
    this.current = { ...ORB_STATES.connecting };
  }

  init() {
    const gl = this.canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) {
      return false;
    }
    this.gl = gl;
    this.program = buildProgram(gl, ORB_VERTEX, ORB_FRAGMENT);

    /* Sphère de Fibonacci : répartition uniforme des particules */
    const COUNT = 1400;
    const positions = new Float32Array(COUNT * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < COUNT; i++) {
      const y = 1 - (i / (COUNT - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = golden * i;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * radius;
    }
    this.count = COUNT;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      time: gl.getUniformLocation(this.program, "u_time"),
      level: gl.getUniformLocation(this.program, "u_level"),
      pulse: gl.getUniformLocation(this.program, "u_pulse"),
      dpr: gl.getUniformLocation(this.program, "u_dpr"),
      tint: gl.getUniformLocation(this.program, "u_tint"),
      bright: gl.getUniformLocation(this.program, "u_bright"),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener("resize", () => this.resize());

    const render = () => {
      this.frame();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return true;
  }

  resize() {
    const size = this.container.clientHeight || 120;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  frame() {
    const gl = this.gl;
    const t = (performance.now() - this.start) / 1000;

    /* Niveau vocal lissé : attaque rapide, retombée douce */
    const raw = this.levelProvider ? this.levelProvider() : 0;
    this.smoothLevel += (raw - this.smoothLevel) * (raw > this.smoothLevel ? 0.4 : 0.06);

    /* Transition continue vers l'apparence de l'état courant */
    const target = ORB_STATES[this.container.dataset.state] || ORB_STATES.online;
    const c = this.current;
    const BLEND = 0.04;
    c.pulse += (target.pulse - c.pulse) * BLEND;
    c.bright += (target.bright - c.bright) * BLEND;
    for (let i = 0; i < 3; i++) {
      c.tint[i] += (target.tint[i] - c.tint[i]) * BLEND;
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.time, t);
    gl.uniform1f(this.uniforms.level, this.smoothLevel);
    gl.uniform1f(this.uniforms.pulse, c.pulse);
    gl.uniform1f(this.uniforms.dpr, this.dpr);
    gl.uniform3fv(this.uniforms.tint, c.tint);
    gl.uniform1f(this.uniforms.bright, c.bright + 0.5 * this.smoothLevel);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }
}

/* ------------------------------------------------------------
   DustField — poussière holographique de premier plan : quelques
   particules dérivant très lentement, scintillement imperceptible.
   ------------------------------------------------------------ */

class DustField {
  constructor(canvas, count = 36) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.count = count;
    this.motes = [];
  }

  init() {
    if (!this.ctx) {
      return false;
    }
    this.resize();
    window.addEventListener("resize", () => this.resize());

    for (let i = 0; i < this.count; i++) {
      this.motes.push(this.spawn(true));
    }

    const render = () => {
      this.frame();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return true;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  spawn(anywhere) {
    return {
      x: Math.random() * this.canvas.width,
      y: anywhere ? Math.random() * this.canvas.height : this.canvas.height + 4,
      vx: (Math.random() - 0.5) * 0.06,
      vy: -(0.02 + Math.random() * 0.07),
      size: 0.5 + Math.random() * 1.3,
      alpha: 0.03 + Math.random() * 0.09,
      phase: Math.random() * Math.PI * 2,
      cyan: Math.random() < 0.25,
    };
  }

  frame() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const t = performance.now() / 1000;

    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      m.x += m.vx + Math.sin(t * 0.3 + m.phase) * 0.04;
      m.y += m.vy;

      if (m.y < -4 || m.x < -4 || m.x > canvas.width + 4) {
        this.motes[i] = this.spawn(false);
        continue;
      }

      const twinkle = 0.7 + 0.3 * Math.sin(t * 0.8 + m.phase);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.size, 0, Math.PI * 2);
      ctx.fillStyle = m.cyan
        ? `rgba(110, 220, 255, ${m.alpha * twinkle})`
        : `rgba(255, 255, 255, ${m.alpha * twinkle})`;
      ctx.fill();
    }
  }
}

window.ABDVisuals = { HoloBackground, HoloOrb, DustField };
