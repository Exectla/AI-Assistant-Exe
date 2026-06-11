/* ============================================================
   A.B.D. — Protocole de Scan Biométrique
   Geste "OK" maintenu 0,8 s : nappe sub-bass 30 Hz, flux caméra
   monochrome, maillage Face Mesh (468 points) et squelette des
   mains ajustés en temps réel, défilement de données système.
   ============================================================ */

"use strict";

/* Chaînes de contours du Face Mesh (indices MediaPipe canoniques) */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
  379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
  234, 127, 162, 21, 54, 103, 67, 109, 10,
];
const LIPS_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318,
  402, 317, 14, 87, 178, 88, 95, 61,
];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263];
const LEFT_BROW = [70, 63, 105, 66, 107];
const RIGHT_BROW = [336, 296, 334, 293, 300];
const NOSE_BRIDGE = [168, 6, 197, 195, 5, 4];
const FACE_CONTOURS = [
  FACE_OVAL, LIPS_OUTER, LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, NOSE_BRIDGE,
];

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const FEED_WORDS = [
  "AUTH_VECTOR", "RETINAL_MAP", "SHA3-512", "BIOKEY", "LATTICE",
  "MESH_LOCK", "T-CELL_SIG", "QUANT_SEED", "IRIS_CORE", "DERMAL_IDX",
  "SYNC_PULSE", "NEURAL_HASH", "ECDH-P521", "FACIAL_NODE", "VEC_NORM",
];

class BiometricScan {
  constructor(deps) {
    this.root = deps.root;
    this.video = deps.video;
    this.mesh = deps.mesh;
    this.feedLeft = deps.feedLeft;
    this.feedRight = deps.feedRight;
    this.audio = deps.audio;
    this.visionLink = deps.visionLink;
    this.apiBase = deps.apiBase;

    this.active = false;
    this.frameTimer = null;
    this.feedTimer = null;
    this.lastObjectUrl = null;
    this.data = { face: [], hands: [] };

    this.ctx = this.mesh.getContext("2d");
  }

  toggle() {
    if (this.active) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.root.hidden = false;
    this.root.classList.add("scan--open");

    /* 1. Nappe sub-bass 30 Hz, vibrante, sans le moindre aigu */
    this.audio.startScanHum();

    /* 2-3. Demande le flux caméra + Face Mesh au moteur de vision */
    this.visionLink.sendScan(true);
    this.frameTimer = setInterval(() => this.pollFrame(), 66);

    /* 4. Défilement de données cryptographiques */
    this.feedTimer = setInterval(() => this.pushFeedLines(), 130);

    const render = () => {
      if (!this.active) {
        return;
      }
      this.drawMesh();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  close() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.audio.stopScanHum();
    this.visionLink.sendScan(false);
    clearInterval(this.frameTimer);
    clearInterval(this.feedTimer);
    this.root.classList.remove("scan--open");
    setTimeout(() => {
      this.root.hidden = true;
      this.feedLeft.innerHTML = "";
      this.feedRight.innerHTML = "";
      this.video.removeAttribute("src");
    }, 450);
  }

  onScanData(data) {
    this.data = data;
  }

  async pollFrame() {
    try {
      const response = await fetch(`${this.apiBase}/api/vision/frame`, {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      this.video.src = url;
      if (this.lastObjectUrl) {
        URL.revokeObjectURL(this.lastObjectUrl);
      }
      this.lastObjectUrl = url;
    } catch (_) { /* flux indisponible : le maillage seul reste affiché */ }
  }

  drawMesh() {
    const w = this.mesh.clientWidth;
    const h = this.mesh.clientHeight;
    if (this.mesh.width !== w || this.mesh.height !== h) {
      this.mesh.width = w;
      this.mesh.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const { face, hands } = this.data;

    /* Maillage du visage : lignes ultra-fines + nuage des 468 points */
    if (face && face.length) {
      ctx.strokeStyle = "rgba(150, 230, 255, 0.55)";
      ctx.lineWidth = 0.7;
      for (const chain of FACE_CONTOURS) {
        ctx.beginPath();
        for (let i = 0; i < chain.length; i++) {
          const p = face[chain[i]];
          if (!p) {
            continue;
          }
          if (i === 0) {
            ctx.moveTo(p[0] * w, p[1] * h);
          } else {
            ctx.lineTo(p[0] * w, p[1] * h);
          }
        }
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(170, 235, 255, 0.35)";
      for (const p of face) {
        ctx.fillRect(p[0] * w, p[1] * h, 1, 1);
      }
    }

    /* Squelette complet des mains */
    if (hands && hands.length) {
      ctx.strokeStyle = "rgba(190, 245, 255, 0.6)";
      ctx.lineWidth = 0.8;
      for (const hand of hands) {
        for (const [a, b] of HAND_CONNECTIONS) {
          const pa = hand[a];
          const pb = hand[b];
          if (!pa || !pb) {
            continue;
          }
          ctx.beginPath();
          ctx.moveTo(pa[0] * w, pa[1] * h);
          ctx.lineTo(pb[0] * w, pb[1] * h);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(220, 250, 255, 0.8)";
        for (const p of hand) {
          ctx.beginPath();
          ctx.arc(p[0] * w, p[1] * h, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  pushFeedLines() {
    for (const column of [this.feedLeft, this.feedRight]) {
      const line = document.createElement("span");
      const word = FEED_WORDS[Math.floor(Math.random() * FEED_WORDS.length)];
      const hex = Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")
      ).join(":");
      const pct = (Math.random() * 100).toFixed(2);
      line.textContent = `${word} ${hex} · ${pct}%`;
      column.appendChild(line);
      while (column.childElementCount > 36) {
        column.removeChild(column.firstChild);
      }
      column.scrollTop = column.scrollHeight;
    }
  }
}

window.ABDScan = { BiometricScan };
