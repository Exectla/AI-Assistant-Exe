/* ============================================================
   A.B.D. — Ordinateur Spatial (HUD plein écran)
   Morphing cinématique de l'orbe → cadre HUD, graphe de
   connaissances 3D, curseur spatial et parallaxe caméra.
   Timeline JS pure à 60 FPS (transform/opacity GPU uniquement).
   ============================================================ */

"use strict";

/* Équivalent mathématique de power3.inOut */
function power3InOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function tween(durationMs, onUpdate) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      onUpdate(power3InOut(t), t);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_NODES = ["NOYAU", "MÉMOIRE", "VOIX", "VISION", "AUDIO", "INTERFACE"];

class SpatialHUD {
  /**
   * @param {object} deps
   *   orb             — conteneur de l'orbe (#orb)
   *   root            — overlay du HUD (#hud)
   *   frame           — cadre lumineux (.hud__frame)
   *   canvas          — canvas du graphe (#graph-canvas)
   *   cursor          — curseur spatial (#spatial-cursor)
   *   audio           — AudioEngine (sons de déploiement)
   *   historyProvider — () => historique de conversation
   *   kernelProvider  — () => état courant du noyau
   */
  constructor(deps) {
    this.orb = deps.orb;
    this.root = deps.root;
    this.frame = deps.frame;
    this.canvas = deps.canvas;
    this.cursor = deps.cursor;
    this.audio = deps.audio;
    this.apiBase = deps.apiBase;
    this.historyProvider = deps.historyProvider;
    this.kernelProvider = deps.kernelProvider;
    this.onDocumentOpen = null;
    this.onDocumentClose = null;

    this.state = "idle"; // idle | deploying | open | closing
    this.ctx = this.canvas.getContext("2d");

    this.nodes = [];
    this.edges = [];
    this.pulses = []; /* impulsions lumineuses vers les nœuds adjacents */
    this.lastProjected = [];
    this.rotation = 0;
    this.parallax = { x: 0, y: 0 };

    this.handTarget = { x: 0.5, y: 0.5, present: false };
    this.cursorPos = { x: 0.5, y: 0.5 };
    this.hovered = null;

    this.orbBaseSize = 0;

    /* Repli souris : pilote le curseur spatial quand aucune main
       n'est suivie par la vision. */
    this.root.addEventListener("pointermove", (event) => {
      if (!this.handTarget.present) {
        this.handTarget.x = event.clientX / window.innerWidth;
        this.handTarget.y = event.clientY / window.innerHeight;
      }
    });

    /* Repli souris : le clic vaut pince (hors panneau de lecture) */
    this.root.addEventListener("click", (event) => {
      if (!event.target.closest(".reader")) {
        this.pinch();
      }
    });

    const closeButton = document.getElementById("reader-close");
    if (closeButton) {
      closeButton.addEventListener("click", () => this.closeReader());
    }
  }

  toggle() {
    if (this.state === "idle") {
      this.open();
    } else if (this.state === "open") {
      this.close();
    }
  }

  setHandTarget(hand) {
    this.handTarget = hand;
  }

  setVisionStatus(text) {
    const el = document.getElementById("hud-vision");
    if (el) {
      el.textContent = text;
    }
  }

  /* ----------------------------------------------------------
     Séquence d'ouverture — l'orbe se métamorphose en cadre
     ---------------------------------------------------------- */

  async open() {
    if (this.state !== "idle") {
      return;
    }
    this.state = "deploying";

    const orb = this.orb;
    this.orbBaseSize = orb.offsetWidth;
    orb.style.animation = "none"; /* libère le fill-forwards CSS */
    orb.style.zIndex = "6";

    this.audio.playHudDeploy();

    /* Étape 1 — Expansion : ×4, très douce */
    await tween(1100, (e) => {
      const s = 1 + 3 * e;
      orb.style.transform = `scale(${s})`;
      orb.style.filter = `brightness(${1 + 0.6 * e})`;
    });

    /* Étape 2 — Écrasement sur Z + étirement horizontal :
       l'orbe devient une ligne d'énergie de la largeur de l'écran */
    const frameW = window.innerWidth * 0.94;
    const lineScaleX = frameW / this.orbBaseSize;
    await tween(550, (e) => {
      const sx = 4 + (lineScaleX - 4) * e;
      const sy = 4 + (0.035 - 4) * e;
      orb.style.transform = `scale(${sx}, ${sy})`;
      orb.style.filter = `brightness(${1.6 + 1.4 * e})`;
    });

    /* Étape 3 — La ligne se déploie verticalement : cadre du HUD */
    orb.style.opacity = "0";
    this.root.hidden = false;
    const frameH = window.innerHeight * 0.94;
    this.frame.style.width = `${frameW}px`;
    this.frame.style.height = "2px";
    await tween(750, (e) => {
      this.frame.style.height = `${2 + (frameH - 2) * e}px`;
    });

    /* Calage : impact de basse feutré, puis matérialisation en fondu net */
    this.audio.playHudLock();
    this.buildGraph();
    this.resizeCanvas();
    this.root.classList.add("hud--open");
    this.state = "open";
    this.startClock();
    this.loop();
  }

  /* ----------------------------------------------------------
     Séquence de fermeture — le cadre se replie en orbe
     ---------------------------------------------------------- */

  async close() {
    if (this.state !== "open") {
      return;
    }
    this.state = "closing";
    this.stopClock();
    this.closeReader();

    this.root.classList.remove("hud--open"); /* fondu sortie 0.3 s (CSS) */
    this.audio.playHudCollapse();
    await wait(320);

    const frameH = window.innerHeight * 0.94;
    await tween(500, (e) => {
      this.frame.style.height = `${frameH * (1 - e) + 2 * e}px`;
    });
    this.root.hidden = true;

    /* Ligne → orbe */
    const orb = this.orb;
    orb.style.opacity = "1";
    const lineScaleX = (window.innerWidth * 0.94) / this.orbBaseSize;
    await tween(420, (e) => {
      const sx = lineScaleX + (4 - lineScaleX) * e;
      const sy = 0.035 + (4 - 0.035) * e;
      orb.style.transform = `scale(${sx}, ${sy})`;
    });
    await tween(620, (e) => {
      const s = 4 - 3 * e;
      orb.style.transform = `scale(${s})`;
      orb.style.filter = `brightness(${1.6 - 0.6 * e})`;
    });
    orb.style.filter = "";
    orb.style.zIndex = "";
    this.state = "idle";
  }

  /* ----------------------------------------------------------
     Graphe de connaissances 3D
     ---------------------------------------------------------- */

  buildGraph() {
    this.nodes = [{ label: "A.B.D.", p: [0, 0, 0], size: 5.5, kind: "core" }];
    this.edges = [];

    /* Nœuds système : sphère de Fibonacci, rayon 1 */
    const golden = Math.PI * (3 - Math.sqrt(5));
    SYSTEM_NODES.forEach((label, i) => {
      const y = 1 - (i / (SYSTEM_NODES.length - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = golden * i;
      this.nodes.push({
        label,
        p: [Math.cos(theta) * radius, y * 0.8, Math.sin(theta) * radius],
        size: 3.2,
        kind: "system",
      });
      this.edges.push([0, this.nodes.length - 1, 0.35]);
    });

    /* Nœuds mémoire : derniers échanges, rattachés à MÉMOIRE */
    const memoryIndex = 1 + SYSTEM_NODES.indexOf("MÉMOIRE");
    const history = this.historyProvider ? this.historyProvider() : [];
    const userMessages = history.filter((m) => m.role === "user").slice(-8);
    for (const message of userMessages) {
      const dir = this.randomDirection();
      const r = 1.45 + Math.random() * 0.45;
      this.nodes.push({
        label: message.content.slice(0, 24) + (message.content.length > 24 ? "…" : ""),
        p: [dir[0] * r, dir[1] * r, dir[2] * r],
        size: 2.2,
        kind: "memory",
      });
      this.edges.push([memoryIndex, this.nodes.length - 1, 0.22]);
    }

    /* Constellation décorative lointaine */
    for (let i = 0; i < 14; i++) {
      const dir = this.randomDirection();
      const r = 1.9 + Math.random() * 0.5;
      this.nodes.push({
        label: "",
        p: [dir[0] * r, dir[1] * r, dir[2] * r],
        size: 1.1,
        kind: "dust",
      });
      this.edges.push([
        1 + Math.floor(Math.random() * SYSTEM_NODES.length),
        this.nodes.length - 1,
        0.08,
      ]);
    }

    /* Spatial RAG : ABD_Database — les nœuds se matérialisent dès
       que l'index arrive (chargement asynchrone, non bloquant). */
    this.loadDatabase();
  }

  async loadDatabase() {
    try {
      const response = await fetch(`${this.apiBase}/api/rag/index`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const index = await response.json();

      for (const folder of index.folders) {
        const dir = this.randomDirection();
        const folderR = 1.25;
        const folderPos = [dir[0] * folderR, dir[1] * folderR, dir[2] * folderR];
        this.nodes.push({
          label: folder.name.replace(/_/g, " "),
          p: folderPos,
          size: 3.6,
          kind: "folder",
        });
        const folderIndex = this.nodes.length - 1;
        this.edges.push([0, folderIndex, 0.3]);

        for (const file of folder.files) {
          const jitter = this.randomDirection();
          const fileR = folderR + 0.5 + Math.random() * 0.25;
          this.nodes.push({
            label: file.name,
            p: [
              dir[0] * fileR + jitter[0] * 0.28,
              dir[1] * fileR + jitter[1] * 0.28,
              dir[2] * fileR + jitter[2] * 0.28,
            ],
            size: 2.4,
            kind: "file",
            file,
          });
          this.edges.push([folderIndex, this.nodes.length - 1, 0.24]);
        }
      }
    } catch (error) {
      console.error("[A.B.D.] Spatial RAG : index inaccessible —", error.message);
    }
  }

  /* ----------------------------------------------------------
     Pince — ouvre le document survolé dans le panneau de verre
     ---------------------------------------------------------- */

  /**
   * Pince. Si le moteur de vision fournit le point médian exact entre
   * le pouce et l'index, le "rayon" de sélection part de ce point
   * précis (raycast chirurgical) ; sinon, le nœud survolé fait foi.
   */
  pinch(point) {
    if (this.state !== "open") {
      return;
    }

    let targetIndex = this.hovered;
    if (point && this.lastProjected.length === this.nodes.length) {
      const rect = this.canvas.getBoundingClientRect();
      const cx = point.x * window.innerWidth - rect.left;
      const cy = point.y * window.innerHeight - rect.top;
      targetIndex = null;
      let best = 55;
      for (let i = 0; i < this.nodes.length; i++) {
        if (this.nodes[i].kind === "dust") {
          continue;
        }
        const proj = this.lastProjected[i];
        const d = Math.hypot(proj.x - cx, proj.y - cy);
        if (d < best) {
          best = d;
          targetIndex = i;
        }
      }
    }

    if (targetIndex === null) {
      return;
    }
    const node = this.nodes[targetIndex];
    if (node.kind === "file") {
      this.openReader(node);
    }
  }

  async openReader(node) {
    const reader = document.getElementById("reader");
    const title = document.getElementById("reader-title");
    const body = document.getElementById("reader-body");
    const answers = document.getElementById("reader-answer");

    title.textContent = node.label;
    body.textContent = "Chargement…";
    answers.innerHTML = "";
    reader.hidden = false;
    reader.classList.add("reader--open");
    this.audio.playClick();

    try {
      const response = await fetch(
        `${this.apiBase}/api/rag/file?path=${encodeURIComponent(node.file.path)}`
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        body.textContent = payload.detail || `Erreur HTTP ${response.status}`;
        return;
      }
      const doc = await response.json();
      body.textContent =
        (doc.content || "(document vide)") +
        (doc.truncated ? "\n\n[… document tronqué …]" : "");

      if (this.onDocumentOpen) {
        this.onDocumentOpen(doc);
      }
    } catch (error) {
      body.textContent = `Lecture impossible : ${error.message}`;
    }
  }

  closeReader() {
    const reader = document.getElementById("reader");
    if (reader && !reader.hidden) {
      reader.hidden = true;
      reader.classList.remove("reader--open");
      if (this.onDocumentClose) {
        this.onDocumentClose();
      }
    }
  }

  randomDirection() {
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return [s * Math.cos(phi), u, s * Math.sin(phi)];
  }

  resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Projette un point 3D (rotation + parallaxe + perspective) */
  project(p, cw, ch) {
    const ry = this.rotation + this.parallax.x;
    const rx = this.parallax.y;

    let x = p[0] * Math.cos(ry) + p[2] * Math.sin(ry);
    let z = -p[0] * Math.sin(ry) + p[2] * Math.cos(ry);
    let y = p[1] * Math.cos(rx) - z * Math.sin(rx);
    z = p[1] * Math.sin(rx) + z * Math.cos(rx);

    const persp = 2.3 / (2.3 - z * 0.85);
    const scale = Math.min(cw, ch) * 0.32;
    return {
      x: cw / 2 + x * persp * scale,
      y: ch / 2 + y * persp * scale,
      depth: persp,
    };
  }

  loop() {
    if (this.state !== "open" && this.state !== "closing") {
      return;
    }

    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, cw, ch);

    /* Rotation lente + parallaxe caméra suivant la main (lissée) */
    this.rotation += 0.0016;
    const targetPX = (this.handTarget.x - 0.5) * 0.85;
    const targetPY = (this.handTarget.y - 0.5) * 0.5;
    this.parallax.x += (targetPX - this.parallax.x) * 0.05;
    this.parallax.y += (targetPY - this.parallax.y) * 0.05;

    /* Curseur spatial lissé (attaque rapide) */
    this.cursorPos.x += (this.handTarget.x - this.cursorPos.x) * 0.18;
    this.cursorPos.y += (this.handTarget.y - this.cursorPos.y) * 0.18;
    const cursorScreenX = this.cursorPos.x * window.innerWidth;
    const cursorScreenY = this.cursorPos.y * window.innerHeight;
    this.cursor.style.transform =
      `translate(${cursorScreenX - 14}px, ${cursorScreenY - 14}px)`;

    /* Idle breathing : chaque nœud flotte dans le fluide — somme de
       sinus désynchronisés (pseudo-Perlin), micro-oscillation de
       position et d'échelle. */
    const tNow = performance.now() / 1000;
    const projected = this.nodes.map((node) => {
      if (node.ph === undefined) {
        node.ph = Math.random() * Math.PI * 2;
        node.fr = 0.22 + Math.random() * 0.35;
        node.glow = 0;
      }
      const amp = node.kind === "core" ? 0.012 : 0.035;
      const wobbled = [
        node.p[0] + amp * Math.sin(tNow * node.fr + node.ph),
        node.p[1] + amp * Math.sin(tNow * node.fr * 0.83 + node.ph * 1.7),
        node.p[2] + amp * Math.sin(tNow * node.fr * 1.21 + node.ph * 0.6),
      ];
      return this.project(wobbled, cw, ch);
    });
    this.lastProjected = projected;

    /* Survol : nœud le plus proche du curseur (repère canvas) */
    const canvasRect = this.canvas.getBoundingClientRect();
    const cx = cursorScreenX - canvasRect.left;
    const cy = cursorScreenY - canvasRect.top;
    this.hovered = null;
    let best = 42;
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].kind === "dust") {
        continue;
      }
      const d = Math.hypot(projected[i].x - cx, projected[i].y - cy);
      if (d < best) {
        best = d;
        this.hovered = i;
      }
    }
    this.cursor.classList.toggle("hud__cursor--lock", this.hovered !== null);

    /* Arêtes — filaments de verre dépoli */
    for (const [a, b, alpha] of this.edges) {
      const pa = projected[a];
      const pb = projected[b];
      const depthAlpha = alpha * Math.min(pa.depth, pb.depth) * 0.7;
      ctx.strokeStyle = `rgba(205, 225, 255, ${depthAlpha.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    /* Impulsions lumineuses : le nœud survolé émet vers ses voisins */
    if (this.hovered !== null && Math.random() < 0.12 && this.pulses.length < 40) {
      const adjacent = this.edges.filter(
        ([a, b]) => a === this.hovered || b === this.hovered
      );
      if (adjacent.length) {
        const [a, b] = adjacent[Math.floor(Math.random() * adjacent.length)];
        this.pulses.push({
          from: a === this.hovered ? a : b,
          to: a === this.hovered ? b : a,
          t: 0,
        });
      }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pulse = this.pulses[i];
      pulse.t += 0.035;
      if (pulse.t >= 1) {
        this.pulses.splice(i, 1);
        continue;
      }
      const pa = projected[pulse.from];
      const pb = projected[pulse.to];
      if (!pa || !pb) {
        continue;
      }
      const px = pa.x + (pb.x - pa.x) * pulse.t;
      const py = pa.y + (pb.y - pa.y) * pulse.t;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(235, 248, 255, ${(0.85 * (1 - pulse.t)).toFixed(3)})`;
      ctx.fill();
    }

    /* Nœuds (les plus lointains d'abord) */
    const order = projected
      .map((p, i) => i)
      .sort((a, b) => projected[a].depth - projected[b].depth);
    for (const i of order) {
      const node = this.nodes[i];
      const proj = projected[i];

      /* Respiration d'échelle + lueur exponentielle au survol */
      const breathe = 1 + 0.06 * Math.sin(tNow * node.fr * 1.4 + node.ph);
      const glowTarget = i === this.hovered ? 1 : 0;
      node.glow += (glowTarget - node.glow) * 0.16;
      const glowExp = (Math.exp(2.5 * node.glow) - 1) / (Math.exp(2.5) - 1);

      const r = node.size * proj.depth * breathe * (1 + 0.18 * glowExp);
      const isHovered = glowExp > 0.04;

      /* Goutte de cristal : halo doux + cœur lumineux + reflet spéculaire */
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, r, 0, Math.PI * 2);
      if (isHovered) {
        ctx.fillStyle = `rgba(255, 235, 215, ${(0.55 + 0.4 * glowExp).toFixed(3)})`;
        ctx.shadowColor = "rgba(255, 220, 190, 0.8)";
        ctx.shadowBlur = 6 + 22 * glowExp;
      } else if (node.kind === "core") {
        ctx.fillStyle = "rgba(245, 250, 255, 0.95)";
        ctx.shadowColor = "rgba(220, 235, 255, 0.7)";
        ctx.shadowBlur = 16;
      } else if (node.kind === "folder") {
        ctx.fillStyle = `rgba(235, 244, 255, ${(0.85 * proj.depth * 0.6).toFixed(3)})`;
        ctx.shadowColor = "rgba(220, 235, 255, 0.4)";
        ctx.shadowBlur = 10;
      } else {
        const a = node.kind === "dust" ? 0.22 : 0.7;
        ctx.fillStyle = `rgba(228, 238, 252, ${(a * proj.depth * 0.6).toFixed(3)})`;
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      /* Reflet spéculaire : pointe de lumière décalée, comme sur du verre */
      if (node.kind !== "dust" && r > 1.6) {
        ctx.beginPath();
        ctx.arc(proj.x - r * 0.32, proj.y - r * 0.32, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.5 * proj.depth * 0.5).toFixed(3)})`;
        ctx.fill();
      }

      /* Étiquettes : cœur et dossiers toujours, le reste au survol */
      const showLabel =
        node.label && (isHovered || node.kind === "core" || node.kind === "folder");
      if (showLabel) {
        ctx.font = "300 11px Bahnschrift, 'Segoe UI', sans-serif";
        ctx.fillStyle = isHovered
          ? "rgba(255, 240, 225, 0.95)"
          : node.kind === "folder"
            ? "rgba(255, 255, 255, 0.45)"
            : "rgba(255, 255, 255, 0.65)";
        ctx.textAlign = "center";
        ctx.fillText(node.label.toUpperCase(), proj.x, proj.y - r - 8);
      }
    }

    /* État du noyau dans le module dédié */
    const kernelEl = document.getElementById("hud-kernel");
    if (kernelEl && this.kernelProvider) {
      kernelEl.textContent = this.kernelProvider().toUpperCase();
    }

    requestAnimationFrame(() => this.loop());
  }

  startClock() {
    const clock = document.getElementById("hud-clock");
    const update = () => {
      if (clock) {
        clock.textContent = new Date().toLocaleTimeString("fr-FR");
      }
    };
    update();
    this.clockTimer = setInterval(update, 1000);
  }

  stopClock() {
    clearInterval(this.clockTimer);
  }
}

window.ABDHud = { SpatialHUD };
