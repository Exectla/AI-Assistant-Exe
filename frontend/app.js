/* ============================================================
   A.B.D. — Advanced Brain Understanding
   Frontend modulaire : AudioEngine, KernelLink, UISystem,
   SpeechController. Aucune dépendance externe.
   ============================================================ */

"use strict";

const API_BASE = "http://127.0.0.1:8756";
const BOOT_DURATION_S = 10;

function log(...args) {
  console.info("%c[A.B.D.]", "color:#888", ...args);
}

function logError(...args) {
  console.error("%c[A.B.D.]", "color:#f44", ...args);
}

/* ============================================================
   AudioEngine — design sonore "Deep Tech", 100 % procédural.
   Toute la chaîne passe par un filtre passe-bas maître à 2000 Hz :
   aucune fréquence aiguë ne peut atteindre la sortie.
   ============================================================ */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.roomToneStarted = false;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();

      // Chaîne maître : tout le son traverse ce passe-bas (coupure 2 kHz).
      this.master = this.ctx.createGain();
      this.master.gain.value = 1.0;

      const lowpass = this.ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 2000;
      lowpass.Q.value = 0.7071;

      this.master.connect(lowpass);
      lowpass.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Room tone : deux sinusoïdes sous-basses légèrement désaccordées
   * (45 Hz / 45.3 Hz) — le battement lent crée un bourdonnement sourd
   * et organique. Montée linéaire sur les 10 s du démarrage.
   */
  startRoomTone() {
    if (this.roomToneStarted) {
      return;
    }
    this.roomToneStarted = true;

    const ctx = this.ensureContext();
    const toneGain = ctx.createGain();
    toneGain.gain.setValueAtTime(0, ctx.currentTime);
    toneGain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + BOOT_DURATION_S);
    toneGain.connect(this.master);

    for (const frequency of [45, 45.3]) {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(toneGain);
      oscillator.start();
    }

    // Respiration très lente du bourdonnement (LFO 0.08 Hz, ±0.025).
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.08;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.025;
    lfo.connect(lfoDepth);
    lfoDepth.connect(toneGain.gain);
    lfo.start();
  }

  /**
   * Clic mécanique étouffé : bruit blanc dans un bandpass grave
   * (320 Hz) doublé d'un "thud" sinusoïdal à 70 Hz. Décroissance
   * exponentielle rapide — interrupteur lourd, feutré, luxueux.
   */
  playClick() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const noiseDuration = 0.06;

    const buffer = ctx.createBuffer(1, ctx.sampleRate * noiseDuration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 320;
    bandpass.Q.value = 1.2;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(this.master);
    noise.start(now);

    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(70, now);
    thud.frequency.exponentialRampToValueAtTime(50, now + 0.08);

    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.3, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    thud.connect(thudGain);
    thudGain.connect(this.master);
    thud.start(now);
    thud.stop(now + 0.1);
  }
}

/* ============================================================
   KernelLink — surveillance du noyau et reconnexion automatique.
   Sonde /api/health avec backoff exponentiel (1 s → 8 s max) et
   notifie l'interface à chaque transition d'état.
   ============================================================ */

class KernelLink {
  constructor() {
    this.online = false;
    this.keyConfigured = false;
    this.retryDelayMs = 1000;
    this.onStateChange = null;
  }

  start() {
    log("KernelLink : démarrage de la surveillance du noyau", API_BASE);
    this.probe();
  }

  async probe() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(`${API_BASE}/api/health`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();

      this.retryDelayMs = 1000;
      this.setState(true, Boolean(data.key_configured));

      // Noyau en ligne : on re-vérifie tranquillement toutes les 10 s.
      setTimeout(() => this.probe(), 10000);
    } catch (error) {
      logError(
        `KernelLink : noyau injoignable (${error.message}) — ` +
        `nouvelle tentative dans ${this.retryDelayMs / 1000} s`
      );
      this.setState(false, this.keyConfigured);

      setTimeout(() => this.probe(), this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 8000);
    } finally {
      clearTimeout(timer);
    }
  }

  setState(online, keyConfigured) {
    const changed = online !== this.online || keyConfigured !== this.keyConfigured;
    this.online = online;
    this.keyConfigured = keyConfigured;

    if (changed) {
      if (online) {
        log(`KernelLink : noyau EN LIGNE (clé API ${keyConfigured ? "configurée" : "ABSENTE"})`);
      } else {
        log("KernelLink : noyau HORS LIGNE — reconnexion automatique en cours");
      }
      if (this.onStateChange) {
        this.onStateChange(online, keyConfigured);
      }
    }
  }
}

/* ============================================================
   UISystem — orbe d'état, rendu des messages, communication noyau
   ============================================================ */

class UISystem {
  constructor(audioEngine, kernelLink) {
    this.audio = audioEngine;
    this.kernel = kernelLink;
    this.conversation = document.getElementById("conversation");
    this.form = document.getElementById("chat-form");
    this.input = document.getElementById("chat-input");
    this.orb = document.getElementById("orb");
    this.status = document.getElementById("status");
    this.history = [];
    this.onReply = null;
  }

  init() {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (text) {
        this.input.value = "";
        this.submitMessage(text);
      }
    });

    // Clic mécanique étouffé sur toute interaction
    document.addEventListener("pointerdown", () => this.audio.playClick());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.audio.playClick();
      }
    });

    this.kernel.onStateChange = (online, keyConfigured) => {
      if (!online) {
        this.setOrbState("offline", "noyau hors ligne — reconnexion…");
      } else if (!keyConfigured) {
        this.setOrbState(
          "warning",
          "clé API absente — créez le fichier .env (voir README)"
        );
      } else {
        this.setOrbState("online", "");
      }
    };
  }

  setOrbState(state, statusText) {
    this.orb.dataset.state = state;
    this.status.textContent = statusText;
  }

  addMessage(role, text) {
    const element = document.createElement("article");
    element.className = `message message--${role === "user" ? "user" : "abd"}`;
    element.textContent = text;
    this.conversation.appendChild(element);
    this.conversation.scrollTop = this.conversation.scrollHeight;
    return element;
  }

  /**
   * Envoie le message au noyau. Les pannes réseau transitoires sont
   * retentées automatiquement (2 reprises, backoff 1 s puis 2 s) ;
   * les erreurs HTTP affichent la cause exacte renvoyée par le noyau.
   */
  async submitMessage(text) {
    this.addMessage("user", text);
    this.setOrbState("thinking", "");
    log(`Envoi au noyau (${text.length} caractères)`);

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: this.history }),
        });

        if (!response.ok) {
          // Erreur applicative : on lit la cause exacte, sans reprise.
          let detail = `Le noyau a répondu HTTP ${response.status}.`;
          try {
            const payload = await response.json();
            if (payload.detail) {
              detail = payload.detail;
            }
          } catch (_) { /* corps non-JSON : on garde le message générique */ }
          logError(`Réponse en erreur du noyau (HTTP ${response.status}) :`, detail);
          this.addMessage("assistant", detail);
          this.setOrbState("online", "");
          return;
        }

        const reply = await this.streamIntoMessage(response.body);
        log(`Réponse reçue (${reply.length} caractères)`);

        this.history.push({ role: "user", content: text });
        this.history.push({ role: "assistant", content: reply });

        this.setOrbState("online", "");
        if (this.onReply) {
          this.onReply(reply);
        }
        return;
      } catch (error) {
        logError(
          `Tentative ${attempt}/${maxAttempts} échouée (${error.message}) — ` +
          (attempt < maxAttempts ? "nouvelle tentative…" : "abandon")
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }

    this.addMessage(
      "assistant",
      "Le noyau A.B.D. est injoignable (vérifiez que l'application a bien " +
      "été lancée via launcher/main.py). Reconnexion automatique en cours…"
    );
    this.setOrbState("offline", "noyau hors ligne — reconnexion…");
  }

  /**
   * Consomme le flux de la réponse et affiche le texte progressivement
   * (effet "typing") : les fragments réseau alimentent une file que l'on
   * vide caractère par caractère.
   */
  async streamIntoMessage(body) {
    const element = this.addMessage("assistant", "");
    const decoder = new TextDecoder("utf-8");
    const reader = body.getReader();

    let pending = "";
    let displayed = "";
    let done = false;
    const CHARS_PER_TICK = 2;
    const TICK_MS = 12;

    const typer = new Promise((resolve) => {
      const tick = () => {
        if (pending.length > 0) {
          displayed += pending.slice(0, CHARS_PER_TICK);
          pending = pending.slice(CHARS_PER_TICK);
          element.textContent = displayed;
          this.conversation.scrollTop = this.conversation.scrollHeight;
        }
        if (done && pending.length === 0) {
          resolve();
        } else {
          setTimeout(tick, TICK_MS);
        }
      };
      tick();
    });

    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        pending += decoder.decode();
        break;
      }
      pending += decoder.decode(value, { stream: true });
    }
    done = true;

    await typer;
    return displayed;
  }
}

/* ============================================================
   SpeechController — reconnaissance et synthèse vocales (fr-FR)
   ============================================================ */

class SpeechController {
  constructor(uiSystem) {
    this.ui = uiSystem;
    this.micButton = document.getElementById("mic-button");
    this.recognition = null;
    this.listening = false;
  }

  init() {
    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognitionClass) {
      this.recognition = new SpeechRecognitionClass();
      this.recognition.lang = "fr-FR";
      this.recognition.continuous = false;
      this.recognition.interimResults = false;

      this.recognition.addEventListener("result", (event) => {
        const transcript = event.results[0][0].transcript.trim();
        if (transcript) {
          this.ui.submitMessage(transcript);
        }
      });

      this.recognition.addEventListener("end", () => this.setListening(false));
      this.recognition.addEventListener("error", (event) => {
        logError("SpeechController : erreur de reconnaissance —", event.error);
        this.setListening(false);
      });
    } else {
      log("SpeechController : reconnaissance vocale non disponible dans ce moteur");
      this.micButton.disabled = true;
      this.micButton.title = "Reconnaissance vocale non disponible";
    }

    this.micButton.addEventListener("click", () => this.toggle());
    this.ui.onReply = (text) => this.speak(text);
  }

  toggle() {
    if (!this.recognition) {
      return;
    }
    if (this.listening) {
      this.recognition.stop();
      this.setListening(false);
    } else {
      window.speechSynthesis.cancel();
      this.recognition.start();
      this.setListening(true);
    }
  }

  setListening(active) {
    this.listening = active;
    this.micButton.classList.toggle("is-listening", active);
    if (active) {
      this.ui.setOrbState("listening", "");
    } else if (this.ui.orb.dataset.state === "listening") {
      this.ui.setOrbState("online", "");
    }
  }

  speak(text) {
    if (!window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "fr-FR";
    utterance.rate = 1.0;
    utterance.pitch = 0.9;
    window.speechSynthesis.speak(utterance);
  }
}

/* ============================================================
   Démarrage
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  log("Interface initialisée — séquence d'allumage en cours");

  const audioEngine = new AudioEngine();
  const kernelLink = new KernelLink();
  const uiSystem = new UISystem(audioEngine, kernelLink);
  const speechController = new SpeechController(uiSystem);

  uiSystem.init();
  speechController.init();
  kernelLink.start();

  // Les navigateurs exigent un geste utilisateur avant de démarrer
  // l'AudioContext : le room tone se lance à la première interaction.
  const startAudio = () => {
    audioEngine.startRoomTone();
    document.removeEventListener("pointerdown", startAudio);
    document.removeEventListener("keydown", startAudio);
  };
  document.addEventListener("pointerdown", startAudio);
  document.addEventListener("keydown", startAudio);
});
