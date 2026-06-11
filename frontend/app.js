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

  /**
   * Déploiement du HUD : sub-bass drop massif (60 → 25 Hz) couplé à
   * une aspiration pneumatique sourde (bruit en lowpass descendant).
   * Aucun aigu possible : tout traverse le passe-bas maître.
   */
  playHudDeploy() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    const drop = ctx.createOscillator();
    drop.type = "sine";
    drop.frequency.setValueAtTime(60, now);
    drop.frequency.exponentialRampToValueAtTime(25, now + 1.5);

    const dropGain = ctx.createGain();
    dropGain.gain.setValueAtTime(0.0001, now);
    dropGain.gain.exponentialRampToValueAtTime(0.5, now + 0.35);
    dropGain.gain.setValueAtTime(0.5, now + 1.1);
    dropGain.gain.exponentialRampToValueAtTime(0.001, now + 1.9);

    drop.connect(dropGain);
    dropGain.connect(this.master);
    drop.start(now);
    drop.stop(now + 2.0);

    const suctionDuration = 1.5;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * suctionDuration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const suction = ctx.createBufferSource();
    suction.buffer = buffer;

    const sweep = ctx.createBiquadFilter();
    sweep.type = "lowpass";
    sweep.frequency.setValueAtTime(800, now);
    sweep.frequency.exponentialRampToValueAtTime(110, now + suctionDuration);
    sweep.Q.value = 0.9;

    const suctionGain = ctx.createGain();
    suctionGain.gain.setValueAtTime(0.0001, now);
    suctionGain.gain.exponentialRampToValueAtTime(0.16, now + 0.5);
    suctionGain.gain.exponentialRampToValueAtTime(0.001, now + suctionDuration);

    suction.connect(sweep);
    sweep.connect(suctionGain);
    suctionGain.connect(this.master);
    suction.start(now);
  }

  /** Calage du cadre : thud électronique lourd, court et feutré. */
  playHudLock() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(55, now);
    thud.frequency.exponentialRampToValueAtTime(32, now + 0.2);

    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.55, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    thud.connect(thudGain);
    thudGain.connect(this.master);
    thud.start(now);
    thud.stop(now + 0.26);
  }

  /** Repli du HUD : remontée sub-bass douce (25 → 50 Hz). */
  playHudCollapse() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    const rise = ctx.createOscillator();
    rise.type = "sine";
    rise.frequency.setValueAtTime(25, now);
    rise.frequency.exponentialRampToValueAtTime(50, now + 0.8);

    const riseGain = ctx.createGain();
    riseGain.gain.setValueAtTime(0.0001, now);
    riseGain.gain.exponentialRampToValueAtTime(0.25, now + 0.2);
    riseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);

    rise.connect(riseGain);
    riseGain.connect(this.master);
    rise.start(now);
    rise.stop(now + 1.0);
  }
}

/* ============================================================
   VoiceEngine — voix neuronale Edge-TTS traitée par la Web Audio API.
   Chaîne : source → EQ low-shelf (+5 dB @ 160 Hz, présence et
   majesté) → convolver (réverbération métallique infime, IR
   procédurale) → analyseur (pilote l'orbe) → sortie.
   Bascule sur speechSynthesis locale si le service est injoignable.
   ============================================================ */

class VoiceEngine {
  constructor(audioEngine) {
    this.audio = audioEngine;
    this.chain = null;
    this.currentSource = null;
    this.analyserData = null;
  }

  ensureChain() {
    const ctx = this.audio.ensureContext();
    if (this.chain) {
      return this.chain;
    }

    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 160;
    bass.gain.value = 5;

    const convolver = ctx.createConvolver();
    convolver.buffer = this.buildImpulse(ctx);

    const dry = ctx.createGain();
    dry.gain.value = 0.88;
    const wet = ctx.createGain();
    wet.gain.value = 0.14;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    this.analyserData = new Uint8Array(analyser.fftSize);

    /* La voix sort en pleine bande : elle ne passe PAS par le
       passe-bas maître (réservé aux sons d'interface). */
    bass.connect(dry);
    dry.connect(analyser);
    bass.connect(convolver);
    convolver.connect(wet);
    wet.connect(analyser);
    analyser.connect(ctx.destination);

    this.chain = { input: bass, analyser };
    return this.chain;
  }

  /**
   * Réponse impulsionnelle procédurale (0,35 s) : bruit en décroissance
   * exponentielle modulé d'un très léger ring ~3,2 kHz — la teinte
   * métallique d'une passerelle de croiseur stellaire.
   */
  buildImpulse(ctx) {
    const length = Math.floor(ctx.sampleRate * 0.35);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        const ring = 0.7 + 0.3 * Math.sin(2 * Math.PI * (3200 + channel * 170) * t);
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 11) * ring;
      }
    }
    return impulse;
  }

  /** Volume vocal instantané (0..1) — consommé par l'orbe holographique. */
  getLevel() {
    if (!this.chain) {
      return 0;
    }
    this.chain.analyser.getByteTimeDomainData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const v = (this.analyserData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.analyserData.length) * 3.5);
  }

  stop() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (_) { /* déjà arrêtée */ }
      this.currentSource = null;
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  async speak(text) {
    this.stop();
    try {
      const response = await fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const encoded = await response.arrayBuffer();
      if (encoded.byteLength < 1024) {
        throw new Error("flux audio vide (service TTS hors ligne ?)");
      }

      const ctx = this.audio.ensureContext();
      const buffer = await ctx.decodeAudioData(encoded);
      const chain = this.ensureChain();

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(chain.input);
      source.addEventListener("ended", () => {
        if (this.currentSource === source) {
          this.currentSource = null;
        }
      });
      source.start();
      this.currentSource = source;
      log(`VoiceEngine : lecture Edge-TTS (${buffer.duration.toFixed(1)} s)`);
    } catch (error) {
      logError(
        `VoiceEngine : Edge-TTS indisponible (${error.message}) — ` +
        "bascule sur la synthèse locale"
      );
      this.fallbackSpeak(text);
    }
  }

  fallbackSpeak(text) {
    if (!window.speechSynthesis) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "fr-FR";
    utterance.rate = 1.0;
    utterance.pitch = 0.9;
    window.speechSynthesis.speak(utterance);
  }
}

/* ============================================================
   VisionLink — pont WebSocket vers le moteur de vision gestuelle
   (MediaPipe côté serveur). Reconnexion automatique ; si la vision
   est indisponible, la touche V reste le déclencheur du HUD.
   ============================================================ */

class VisionLink {
  constructor() {
    this.ws = null;
    this.retryMs = 1000;
    this.onGesture = null;
    this.onHand = null;
    this.onStatus = null;
  }

  start() {
    this.connect();
  }

  connect() {
    const url = API_BASE.replace(/^http/, "ws") + "/ws/vision";
    try {
      this.ws = new WebSocket(url);
    } catch (error) {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.retryMs = 1000;
      log("VisionLink : canal gestuel connecté");
    });

    this.ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (data.type === "gesture" && this.onGesture) {
        log(`VisionLink : geste détecté — ${data.name}`);
        this.onGesture(data.name);
      } else if (data.type === "hand" && this.onHand) {
        this.onHand(data);
      } else if (data.type === "status" && this.onStatus) {
        log(`VisionLink : vision ${data.vision}` +
            (data.reason ? ` (${data.reason})` : ""));
        this.onStatus(data);
      }
    });

    this.ws.addEventListener("close", () => this.scheduleReconnect());
    this.ws.addEventListener("error", () => {
      try {
        this.ws.close();
      } catch (_) { /* déjà fermé */ }
    });
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10000);
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
  constructor(uiSystem, voiceEngine) {
    this.ui = uiSystem;
    this.voice = voiceEngine;
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
      this.voice.stop();
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
    this.voice.speak(text);
  }
}

/* ============================================================
   Démarrage
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  log("Interface initialisée — séquence d'allumage en cours");

  const audioEngine = new AudioEngine();
  const voiceEngine = new VoiceEngine(audioEngine);
  const kernelLink = new KernelLink();
  const uiSystem = new UISystem(audioEngine, kernelLink);
  const speechController = new SpeechController(uiSystem, voiceEngine);

  uiSystem.init();
  speechController.init();
  kernelLink.start();

  /* Couche visuelle Coruscant : chaque module se désactive proprement
     si WebGL n'est pas disponible (l'interface CSS reste fonctionnelle). */
  try {
    const { HoloBackground, HoloOrb, DustField } = window.ABDVisuals;

    new HoloBackground(document.getElementById("bg-canvas")).init();
    new DustField(document.getElementById("dust-canvas")).init();

    const orbContainer = document.getElementById("orb");
    const orbActive = new HoloOrb(
      document.getElementById("orb-canvas"),
      orbContainer,
      () => voiceEngine.getLevel()
    ).init();
    if (orbActive) {
      orbContainer.classList.add("orb--gl");
    }
    log("Couche visuelle holographique active");
  } catch (error) {
    logError("Couche visuelle indisponible (WebGL ?) — repli CSS :", error.message);
  }

  /* Ordinateur spatial : morphing orbe → HUD, déclenché par le signe V
     (vision MediaPipe côté serveur) ou par la touche V au clavier. */
  const hud = new window.ABDHud.SpatialHUD({
    orb: document.getElementById("orb"),
    root: document.getElementById("hud"),
    frame: document.querySelector(".hud__frame"),
    canvas: document.getElementById("graph-canvas"),
    cursor: document.getElementById("spatial-cursor"),
    audio: audioEngine,
    historyProvider: () => uiSystem.history,
    kernelProvider: () => document.getElementById("orb").dataset.state,
  });

  const visionLink = new VisionLink();
  visionLink.onGesture = (name) => {
    if (name === "v_sign") {
      hud.toggle();
    }
  };
  visionLink.onHand = (hand) => hud.setHandTarget(hand);
  visionLink.onStatus = (status) => {
    hud.setVisionStatus(
      status.vision === "active" ? "MediaPipe · main suivie" : "clavier (touche V)"
    );
  };
  visionLink.start();

  document.addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() === "v" &&
      document.activeElement !== document.getElementById("chat-input")
    ) {
      hud.toggle();
    }
  });

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
