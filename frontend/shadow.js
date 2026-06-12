/* ============================================================
   A.B.D. — Shadow Workspace
   Brouillon holographique strictement confidentiel et éphémère :
   chaque phrase prononcée s'inscrit en lignes flottantes dans un
   panneau Liquid Glass. Les données vivent UNIQUEMENT en mémoire
   vive — le kill switch (Échap) n'en laisse aucune trace. Seul le
   bouton d'export écrit un .md horodaté dans ABD_Database/Shadow_Logs.
   Invocation : ☝ index seul levé (0,5 s) ou touche W.
   ============================================================ */

"use strict";

/* Segments d'enregistrement de la voie de secours Whisper (WebView2
   n'implémente pas l'API Web Speech) : 4 s par tranche, les tranches
   silencieuses sont écartées sans appel réseau. */
const SHADOW_SEGMENT_MS = 4000;
const SHADOW_SILENCE_RMS = 0.015;

class ShadowWorkspace {
  /**
   * @param {object} deps
   *   root         — panneau racine (#shadow)
   *   lines        — conteneur des lignes (#shadow-lines)
   *   status       — indicateur d'état micro (#shadow-status)
   *   exportButton — bouton d'export manuel (#shadow-export)
   *   audio        — AudioEngine (sons de déploiement/repli)
   *   apiBase      — URL du noyau
   */
  constructor(deps) {
    this.root = deps.root;
    this.linesEl = deps.lines;
    this.statusEl = deps.status;
    this.exportButton = deps.exportButton;
    this.audio = deps.audio;
    this.apiBase = deps.apiBase;

    this.visible = false;
    /* Protocole éphémère : l'unique lieu de vie du brouillon. */
    this.lines = [];

    this.recognition = null;
    this.useRecorder = false;
    this.recorderStream = null;
    this.recorder = null;
    this.segmentTimer = null;
    this.rmsContext = null;
    this.rmsPeak = 0;
    this.rmsTimer = null;
    this.liveLine = null;
    /* Voie principale : micro capturé côté noyau (sounddevice). */
    this.kernelMic = "unknown";
    this.kernelPoll = null;

    this.exportButton.addEventListener("click", () => this.export());
  }

  /* ----- bascule (geste Shadow ou touche W) ------------------------- */

  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    if (this.visible) {
      return;
    }
    this.visible = true;
    this.root.hidden = false;
    this.root.classList.remove("shadow--closing");
    /* Reflow avant l'animation : garantit le départ du ressort. */
    void this.root.offsetWidth;
    this.root.classList.add("shadow--open");
    this.audio.playHudDeploy();
    this.startListening();
    this.scrollToEnd();
  }

  hide() {
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.stopListening();
    this.audio.playHudCollapse();
    this.root.classList.remove("shadow--open");
    this.root.classList.add("shadow--closing");
    setTimeout(() => {
      if (!this.visible) {
        this.root.hidden = true;
        this.root.classList.remove("shadow--closing");
      }
    }, 450);
  }

  /* ----- écoute continue du microphone ------------------------------ */

  async startListening() {
    /* Voie principale : micro noyau (sounddevice — comme la caméra,
       aucun accès navigateur requis). */
    if (this.kernelMic !== "no" && await this.startKernel()) {
      return;
    }

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognitionClass && !this.useRecorder) {
      this.startNative(SpeechRecognitionClass);
    } else {
      this.startRecorderLoop();
    }
  }

  stopListening() {
    this.stopKernel();
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (_) { /* déjà arrêté */ }
      this.recognition = null;
    }
    this.stopRecorderLoop();
    this.clearLiveLine();
    this.setStatus("micro en veille");
  }

  /* ----- micro noyau : segments transcrits côté Python -------------- */

  async startKernel() {
    try {
      const response = await fetch(`${this.apiBase}/api/mic/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuous: true }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const detail = String(payload.detail || "");
        if (!detail.includes("déjà en cours")) {
          this.kernelMic = "no";
        }
        logError("ShadowWorkspace : micro noyau indisponible —", detail);
        return false;
      }
    } catch (error) {
      logError("ShadowWorkspace : noyau injoignable —", error);
      return false;
    }

    this.kernelMic = "yes";
    this.setStatus("écoute active — noyau · Whisper");
    this.kernelPoll = setInterval(async () => {
      try {
        const response = await fetch(`${this.apiBase}/api/mic/transcripts`);
        if (!response.ok) {
          return;
        }
        const { lines } = await response.json();
        for (const line of lines) {
          this.addLine(line);
        }
      } catch (_) { /* noyau momentanément injoignable */ }
    }, 1200);
    return true;
  }

  stopKernel() {
    if (this.kernelPoll) {
      clearInterval(this.kernelPoll);
      this.kernelPoll = null;
      fetch(`${this.apiBase}/api/mic/stop`, { method: "POST" }).catch(() => {});
    }
  }

  startNative(SpeechRecognitionClass) {
    this.recognition = new SpeechRecognitionClass();
    this.recognition.lang = "fr-FR";
    this.recognition.continuous = true;
    this.recognition.interimResults = true;

    this.recognition.addEventListener("result", (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (result.isFinal && text) {
          this.addLine(text);
        } else {
          interim += ` ${text}`;
        }
      }
      this.setLiveLine(interim.trim());
    });

    /* Les moteurs coupent l'écoute après un silence : on relance tant
       que le panneau est visible. */
    this.recognition.addEventListener("end", () => {
      if (this.visible && this.recognition) {
        try {
          this.recognition.start();
        } catch (_) { /* relance au prochain cycle */ }
      }
    });

    this.recognition.addEventListener("error", (event) => {
      const fatal = ["not-allowed", "service-not-allowed", "network", "audio-capture"];
      if (fatal.includes(event.error)) {
        logError("ShadowWorkspace : Web Speech indisponible —", event.error);
        this.recognition = null;
        this.useRecorder = true;
        if (this.visible) {
          this.startRecorderLoop();
        }
      }
    });

    try {
      this.recognition.start();
      this.setStatus("écoute active — parlez");
    } catch (error) {
      logError("ShadowWorkspace : démarrage Web Speech impossible —", error);
      this.recognition = null;
      this.useRecorder = true;
      this.startRecorderLoop();
    }
  }

  /* ----- voie de secours : segments → /api/stt (Whisper) ------------ */

  async startRecorderLoop() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      this.setStatus("micro non disponible dans ce moteur");
      return;
    }
    try {
      this.recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      logError("ShadowWorkspace : micro inaccessible —", error);
      this.setStatus("micro inaccessible");
      return;
    }
    this.setStatus("écoute active — transcription noyau");
    this.startRmsMeter();
    this.recordSegment();
  }

  stopRecorderLoop() {
    clearTimeout(this.segmentTimer);
    this.segmentTimer = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
    this.recorder = null;
    if (this.recorderStream) {
      this.recorderStream.getTracks().forEach((track) => track.stop());
      this.recorderStream = null;
    }
    this.stopRmsMeter();
  }

  recordSegment() {
    if (!this.visible || !this.recorderStream) {
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const chunks = [];
    this.rmsPeak = 0;
    this.recorder = new MediaRecorder(this.recorderStream, { mimeType });
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    this.recorder.addEventListener("stop", () => {
      const voiced = this.rmsPeak >= SHADOW_SILENCE_RMS;
      /* Enchaîne immédiatement le segment suivant : l'écoute reste
         continue pendant que la transcription part en parallèle. */
      this.recordSegment();
      if (voiced && chunks.length > 0) {
        this.transcribe(new Blob(chunks, { type: mimeType }));
      }
    });
    this.recorder.start();
    this.segmentTimer = setTimeout(() => {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
    }, SHADOW_SEGMENT_MS);
  }

  async transcribe(blob) {
    try {
      const response = await fetch(`${this.apiBase}/api/stt`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const { text } = await response.json();
      if (text) {
        this.addLine(text);
      }
    } catch (error) {
      logError("ShadowWorkspace : échec de la transcription —", error);
    }
  }

  /* Jauge RMS : écarte les segments silencieux sans appel réseau. */
  startRmsMeter() {
    try {
      this.rmsContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.rmsContext.createMediaStreamSource(this.recorderStream);
      const analyser = this.rmsContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      this.rmsTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          sum += samples[i] * samples[i];
        }
        this.rmsPeak = Math.max(this.rmsPeak, Math.sqrt(sum / samples.length));
      }, 100);
    } catch (error) {
      /* Sans jauge, tous les segments partent en transcription. */
      this.rmsPeak = 1;
    }
  }

  stopRmsMeter() {
    clearInterval(this.rmsTimer);
    this.rmsTimer = null;
    if (this.rmsContext) {
      this.rmsContext.close().catch(() => {});
      this.rmsContext = null;
    }
    this.rmsPeak = 0;
  }

  /* ----- lignes flottantes ------------------------------------------ */

  addLine(text) {
    this.lines.push(text);
    const line = document.createElement("div");
    line.className = "shadow__line";
    const stamp = document.createElement("span");
    stamp.className = "shadow__stamp";
    stamp.textContent = new Date().toLocaleTimeString("fr-FR", {
      hour: "2-digit", minute: "2-digit",
    });
    const body = document.createElement("span");
    body.className = "shadow__text";
    body.textContent = text;
    line.append(stamp, body);

    this.clearLiveLine();
    this.linesEl.appendChild(line);
    this.scrollToEnd();
  }

  /* Ligne fantôme : la phrase en cours, affichée au fil de la parole. */
  setLiveLine(text) {
    if (!text) {
      this.clearLiveLine();
      return;
    }
    if (!this.liveLine) {
      this.liveLine = document.createElement("div");
      this.liveLine.className = "shadow__line shadow__line--live";
      this.linesEl.appendChild(this.liveLine);
    }
    this.liveLine.textContent = text;
    this.scrollToEnd();
  }

  clearLiveLine() {
    if (this.liveLine) {
      this.liveLine.remove();
      this.liveLine = null;
    }
  }

  scrollToEnd() {
    this.linesEl.scrollTop = this.linesEl.scrollHeight;
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  /* ----- export manuel (.md horodaté) ------------------------------- */

  async export() {
    if (this.lines.length === 0) {
      this.setStatus("rien à exporter — le brouillon est vide");
      return;
    }
    this.audio.playClick();
    try {
      const response = await fetch(`${this.apiBase}/api/shadow/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: this.lines }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`HTTP ${response.status} — ${detail}`);
      }
      const data = await response.json();
      this.audio.playHudLock();
      this.setStatus(`exporté : Shadow_Logs/${data.name}`);
      log(`ShadowWorkspace : export — ${data.name} (${data.lines} lignes)`);
    } catch (error) {
      logError("ShadowWorkspace : échec de l'export —", error);
      this.setStatus("échec de l'export — noyau injoignable ?");
    }
  }
}

window.ABDShadow = { ShadowWorkspace };
