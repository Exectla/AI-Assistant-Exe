/* ============================================================
   A.B.D. — Advanced Brain Understanding
   Frontend modulaire : AudioEngine, UISystem, SpeechController
   ============================================================ */

"use strict";

const API_BASE = "http://127.0.0.1:8756";
const BOOT_DURATION_S = 10;

/* ============================================================
   AudioEngine — son 100 % procédural (Web Audio API)
   ============================================================ */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.roomToneGain = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Room tone : sinusoïde sous-basse ~45 Hz dont le gain monte
   * linéairement jusqu'à 0.15 pendant les 10 s du démarrage.
   */
  startRoomTone() {
    const ctx = this.ensureContext();

    const oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = 45;

    this.roomToneGain = ctx.createGain();
    this.roomToneGain.gain.setValueAtTime(0, ctx.currentTime);
    this.roomToneGain.gain.linearRampToValueAtTime(
      0.15,
      ctx.currentTime + BOOT_DURATION_S
    );

    oscillator.connect(this.roomToneGain);
    this.roomToneGain.connect(ctx.destination);
    oscillator.start();
  }

  /**
   * Clic mécanique : buffer de bruit blanc passé dans un filtre
   * bandpass, décroissance exponentielle du gain sur 0.05 s —
   * simulation d'un interrupteur lourd.
   */
  playClick() {
    const ctx = this.ensureContext();
    const duration = 0.05;

    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2200;
    filter.Q.value = 6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }
}

/* ============================================================
   UISystem — rendu des messages et communication backend
   ============================================================ */

class UISystem {
  constructor(audioEngine) {
    this.audio = audioEngine;
    this.conversation = document.getElementById("conversation");
    this.form = document.getElementById("chat-form");
    this.input = document.getElementById("chat-input");
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

    // Clic mécanique sur toute interaction
    document.addEventListener("pointerdown", () => this.audio.playClick());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.audio.playClick();
      }
    });
  }

  addMessage(role, text) {
    const element = document.createElement("article");
    element.className = `message message--${role === "user" ? "user" : "abd"}`;
    element.textContent = text;
    this.conversation.appendChild(element);
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  async submitMessage(text) {
    this.addMessage("user", text);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: this.history }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.history.push({ role: "user", content: text });
      this.history.push({ role: "assistant", content: data.reply });

      this.addMessage("assistant", data.reply);
      if (this.onReply) {
        this.onReply(data.reply);
      }
    } catch (error) {
      this.addMessage("assistant", "Connexion au noyau A.B.D. impossible.");
    }
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
      this.recognition.addEventListener("error", () => this.setListening(false));
    } else {
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
  const audioEngine = new AudioEngine();
  const uiSystem = new UISystem(audioEngine);
  const speechController = new SpeechController(uiSystem);

  uiSystem.init();
  speechController.init();

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
