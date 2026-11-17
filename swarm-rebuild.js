/* ============================================================================
   swarm-rebuild.js
   ----------------------------------------------------------------------------
   Gallery-only, scroll-driven cursor swarm for Alif's Photography.

   One dedicated cursor per .gallery-card.
   Cards live in a mid-screen band:
     enter band  → build
     leave top   (scroll down)  → erase (visible at top edge)
     leave bottom (scroll up)   → erase (visible at bottom edge)

   Public API:
     window.__swarmRebuild.start()
     window.__swarmRebuild.stop()
     window.__swarmRebuild.refresh(root)   re-sync after gallery re-render
     window.__swarmRebuild.app
     window.__swarmRebuild.setMuted(bool)
     window.__swarmRebuild.unlockAudio()
   ========================================================================= */
(() => {
  "use strict";

  if (window.__swarmRebuild && window.__swarmRebuild.built) return;

  const COLORS = [
    "#00f2fe", "#7d2ae8", "#ff007f", "#10b981", "#f59e0b",
    "#3b82f6", "#a855f7", "#f43f5e", "#84cc16", "#fb923c",
    "#22d3ee", "#c084fc",
  ];

  /* Build / erase pacing — lower = slower, smoother */
  const APPROACH_LERP = 0.09;
  const DRONE_FOLLOW = 0.11;
  const TRACE_DUR_MIN = 320;
  const TRACE_DUR_MAX = 980;
  const FILL_DUR_MIN = 1700;
  const FILL_DUR_MAX = 2900;
  const ERASE_DUR_MIN = 1200;
  const ERASE_DUR_MAX = 2100;

  let muted = false;

  const GESTURES = [
    "pointerdown", "pointerup", "mousedown", "mouseup", "click",
    "keydown", "keyup", "touchstart", "touchend", "wheel", "scroll",
    "focusin", "focus",
  ];

  /* ─────────────────────────────── sound ─────────────────────────── */
  const Sfx = {
    ctx: null,
    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
      } catch (err) {
        this.ctx = null;
      }
      return this.ctx;
    },
    resume() {
      const c = this.ensure();
      if (c && c.state === "suspended") c.resume().catch(() => {});
    },
    tone(freq, dur, type, gain, slideTo, delay) {
      const c = this.ensure();
      if (!c || muted || c.state !== "running") return;
      const t0 = c.currentTime + (delay || 0);
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain || 0.03), t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp);
      amp.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    },
    boot() {
      [330, 494, 660].forEach((f, i) => this.tone(f, 0.13, "triangle", 0.018, f * 1.5, i * 0.075));
    },
    lock() {
      this.tone(210, 0.06, "square", 0.014, 280);
    },
    sweep() {
      this.tone(520, 0.16, "sine", 0.009, 760);
    },
    tick(level) {
      this.tone(540 + level * 620, 0.035, "square", 0.006);
    },
    done() {
      this.tone(880, 0.09, "triangle", 0.026, 440);
      this.tone(1760, 0.05, "sine", 0.01, 880, 0.01);
    },
  };

  function warmMedia() {
    try {
      const rate = 8000;
      const samples = 1200;
      const buf = new ArrayBuffer(44 + samples * 2);
      const view = new DataView(buf);
      const write = (off, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
      };
      write(0, "RIFF");
      view.setUint32(4, 36 + samples * 2, true);
      write(8, "WAVEfmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, "data");
      view.setUint32(40, samples * 2, true);
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      const audio = document.createElement("audio");
      audio.src = url;
      audio.loop = true;
      audio.muted = true;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
      audio.style.display = "none";
      document.body.appendChild(audio);
      const playing = audio.play();
      if (playing && playing.catch) playing.catch(() => {});
      audio.dataset.swarmWarm = "1";
      return audio;
    } catch (err) {
      return null;
    }
  }

  /* ─────────────────────────────── styles ────────────────────────── */
  const STYLE_ID = "swarm-rebuild-styles";
  const STYLE = `
  .sw-hide, .sw-ghost, .sw-build { transition: none !important; }
  .sw-hide { opacity: 0 !important; pointer-events: none !important; }
  .sw-ghost { opacity: 0 !important; pointer-events: none !important; }
  .sw-build {
    pointer-events: none !important;
    filter: brightness(1.45) saturate(1.15);
    outline: 1px solid rgba(0, 242, 254, .55) !important; outline-offset: 3px;
    will-change: clip-path;
  }
  .sw-snap { animation: sw-snap .42s cubic-bezier(.175, .885, .32, 1.275); }
  @keyframes sw-snap {
    0% { filter: brightness(1.8); }
    55% { filter: brightness(1.1); }
    100% { filter: none; }
  }
  .sw-drone {
    position: fixed; top: 0; left: 0; z-index: 90;
    pointer-events: none; will-change: transform; transform-origin: 0 0;
    filter: drop-shadow(0 6px 14px rgba(0, 0, 0, .75));
    transition: opacity .16s ease;
  }
  .sw-drone svg { display: block; }
  .sw-label {
    position: absolute; top: 25px; left: 13px; white-space: nowrap;
    font-family: "Fira Code", ui-monospace, monospace; font-size: 10px;
    font-weight: 700; letter-spacing: .06em; line-height: 1;
    padding: 4px 7px; border-radius: 5px;
    background: rgba(6, 6, 14, .93); border: 1px solid currentColor;
    box-shadow: 0 4px 14px rgba(0, 0, 0, .65);
  }
  .sw-tether { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function galleryCards(root) {
    const scope = root || document.getElementById("galleryGrid") || document;
    return [...scope.querySelectorAll(".gallery-card")];
  }

  function labelFor(el, index) {
    const hint = el.getAttribute("aria-label") || el.querySelector(".card-title")?.textContent || "";
    const name = hint
      ? hint.replace(/^View\s+/i, "").replace(/\s+in full resolution$/i, "").slice(0, 14).toUpperCase().replace(/\s+/g, "_")
      : `PHOTO_${index}`;
    return name || `PHOTO_${index}`;
  }

  /* ─────────────────────────── drone vessel ──────────────────────── */
  class Drone {
    constructor(swarm, index) {
      this.swarm = swarm;
      this.index = index;
      this.color = COLORS[index % COLORS.length];
      this.x = window.innerWidth * 0.5;
      this.y = window.innerHeight * 0.45;
      this.tx = this.x;
      this.ty = this.y;
      this.busy = false;
      this.rec = null;
      this.homeRec = null;

      const el = document.createElement("div");
      el.className = "sw-drone";
      el.style.opacity = "0";
      el.innerHTML = `
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z"
                fill="${this.color}" stroke="#ffffff" stroke-width="1.4"
                stroke-linejoin="round"/>
        </svg>
        <div class="sw-label" style="color:${this.color}">STANDBY</div>`;
      this.el = el;
      this.labelEl = el.querySelector(".sw-label");
      document.body.appendChild(el);
    }

    setLabel(text) {
      this.labelEl.textContent = text;
    }

    setVisible(on) {
      this.el.style.opacity = on ? "1" : "0";
    }

    release() {
      this.busy = false;
      this.rec = null;
      this.setLabel("STANDBY");
      this.setVisible(false);
    }

    remove() {
      this.el.remove();
    }
  }

  /* ─────────────────────────── the swarm ─────────────────────────── */
  class Swarm {
    constructor() {
      this.items = new Map();
      this.order = [];
      this.drones = [];
      this.particles = [];
      this.raf = 0;
      this.running = false;
      this.lastQueue = 0;
      this.snapCount = 0;
      this.scrollY = window.scrollY || 0;
      this.scrollDir = 1; // 1 = down, -1 = up
      this.onEsc = this.onEsc.bind(this);
      this.frame = this.frame.bind(this);
      this.onResize = this.onResize.bind(this);
      this.onGesture = this.onGesture.bind(this);
      this.onScroll = this.onScroll.bind(this);
    }

    begin() {
      injectStyle();
      this.buildCanvas();
      this.syncGallery();

      document.addEventListener("keydown", this.onEsc, true);
      window.addEventListener("resize", this.onResize, { passive: true });
      window.addEventListener("scroll", this.onScroll, { passive: true });
      GESTURES.forEach((evt) => {
        document.addEventListener(evt, this.onGesture, { passive: true, capture: true });
      });
      window.addEventListener("pageshow", this.onGesture, { passive: true });
      document.addEventListener("visibilitychange", this.onGesture, { passive: true });

      this.running = true;
      this.soundTries = 0;
      this.booted = false;
      this.warmAudio = warmMedia();
      Sfx.ensure();
      this.trySound();
      clearInterval(this.soundTimer);
      this.soundTimer = setInterval(() => {
        if (!this.running || this.booted) return;
        this.trySound();
      }, 400);
      this.raf = requestAnimationFrame(this.frame);
      this.evaluate();
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      cancelAnimationFrame(this.raf);
      clearTimeout(this.soundT);
      document.removeEventListener("keydown", this.onEsc, true);
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("scroll", this.onScroll);
      GESTURES.forEach((evt) => {
        document.removeEventListener(evt, this.onGesture, true);
      });
      window.removeEventListener("pageshow", this.onGesture);
      document.removeEventListener("visibilitychange", this.onGesture);
      clearInterval(this.soundTimer);
      this.soundTimer = null;
      if (this.warmAudio) {
        try {
          this.warmAudio.pause();
          this.warmAudio.remove();
        } catch (err) { /* ignore */ }
        this.warmAudio = null;
      }
      for (const rec of this.items.values()) this.restore(rec);
      this.items.clear();
      this.order.length = 0;
      for (const d of this.drones) d.remove();
      this.drones.length = 0;
      if (this.canvas) this.canvas.remove();
      this.canvas = null;
      this.ctx = null;
      if (window.__swarmRebuild) window.__swarmRebuild.app = null;
    }

    onEsc(event) {
      if (event.key !== "Escape") return;
      if (document.getElementById("lightbox")?.classList.contains("is-open")) return;
      this.stop();
    }

    onGesture() {
      Sfx.resume();
      this.trySound();
    }

    trySound() {
      if (!this.running) return;
      if (this.warmAudio && this.warmAudio.paused) {
        const started = this.warmAudio.play();
        if (started && started.catch) started.catch(() => {});
      }
      const c = Sfx.ensure();
      if (!c) return;
      if (c.state === "running") {
        clearTimeout(this.soundT);
        clearInterval(this.soundTimer);
        this.soundTimer = null;
        if (!this.booted) {
          this.booted = true;
          Sfx.boot();
        }
        return;
      }
      c.resume().then(() => {
        if (c.state === "running" && !this.booted) {
          this.booted = true;
          clearInterval(this.soundTimer);
          this.soundTimer = null;
          Sfx.boot();
        }
      }).catch(() => {});
      if (this.soundTries < 30) {
        this.soundTries = (this.soundTries || 0) + 1;
        clearTimeout(this.soundT);
        this.soundT = setTimeout(() => this.trySound(), 320);
      }
    }

    onResize() {
      this.syncCanvas();
    }

    /** Bottom edge of the sticky header — cursors must stay below this. */
    headerBottom() {
      const header = document.querySelector(".site-header");
      if (!header) return 76;
      return header.getBoundingClientRect().bottom + 8;
    }

    /**
     * Place a drone; hide it entirely if its target sits in the header band
     * so build/erase cursors never appear over the nav.
     */
    placeDrone(d, x, y, visible) {
      const minY = this.headerBottom();
      const maxY = (this.ch || window.innerHeight) - 12;
      const inHeader = y < minY;
      d.x = x;
      d.y = Math.max(minY, Math.min(maxY, y));
      d.el.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`;
      d.setVisible(Boolean(visible) && !inHeader);
    }

    onScroll() {
      const y = window.scrollY || 0;
      if (Math.abs(y - this.scrollY) > 1) {
        this.scrollDir = y > this.scrollY ? 1 : -1;
        this.scrollY = y;
      }
      // Evaluate promptly so erase starts while the card is still on-screen
      this.evaluate();
    }

    /**
     * Keep cards only while they sit in a mid-viewport band.
     * Leaving through the top (scroll down) or bottom (scroll up) triggers erase
     * while a strip of the card is still visible — so the wipe can be seen.
     */
    wantsVisible(r) {
      const vh = window.innerHeight || 1;
      // Generous band so erase begins before the card fully leaves (esp. mobile)
      const topKeep = vh * 0.22;
      const botKeep = vh * 0.78;
      return r.bottom > topKeep && r.top < botKeep;
    }

    /** Which edge the card is exiting through. */
    exitSide(r) {
      const vh = window.innerHeight || 1;
      const topKeep = vh * 0.22;
      const botKeep = vh * 0.78;
      if (r.bottom <= topKeep) return "top";
      if (r.top >= botKeep) return "bottom";
      // Ambiguous / mid-flip: use scroll direction
      return this.scrollDir >= 0 ? "top" : "bottom";
    }

    buildCanvas() {
      const canvas = document.createElement("canvas");
      canvas.className = "sw-tether";
      document.body.appendChild(canvas);
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.syncCanvas();
    }

    syncCanvas() {
      if (!this.canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.dpr = dpr;
      this.canvas.width = Math.floor(window.innerWidth * dpr);
      this.canvas.height = Math.floor(window.innerHeight * dpr);
      this.canvas.style.width = `${window.innerWidth}px`;
      this.canvas.style.height = `${window.innerHeight}px`;
      const ctx = this.ctx;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cw = window.innerWidth;
      this.ch = window.innerHeight;
    }

    register(el) {
      const existing = this.items.get(el);
      if (existing) return existing;
      const rec = {
        el,
        parent: null,
        status: "unbuilt",
        armed: false,
        phase: "",
        phaseAt: 0,
        q: 0,
        speed: APPROACH_LERP,
        drone: null,
        id: this.order.length + 1,
      };
      this.items.set(el, rec);
      this.order.push(rec);
      return rec;
    }

    /** Keep exactly one dedicated drone per gallery card (persists for rebuild/demolish). */
    syncGallery(root) {
      const cards = galleryCards(root);
      const live = new Set(cards);

      for (const [el, rec] of [...this.items.entries()]) {
        if (live.has(el)) continue;
        if (rec.drone) {
          rec.drone.remove();
          this.drones = this.drones.filter((d) => d !== rec.drone);
        }
        this.hideInstant(rec);
        this.items.delete(el);
      }
      this.order = this.order.filter((rec) => this.items.get(rec.el) === rec);

      cards.forEach((card, index) => {
        const rec = this.register(card);
        if (!rec.drone || !this.drones.includes(rec.drone)) {
          const drone = new Drone(this, index);
          drone.homeRec = rec;
          rec.drone = drone;
          this.drones.push(drone);
        } else {
          rec.drone.index = index;
          rec.drone.homeRec = rec;
        }

        if (rec.status === "building" || rec.status === "demolishing") return;

        // Keep built cards that still belong in view; everything else waits for scroll.
        const r = card.getBoundingClientRect();
        if (rec.status === "built" && this.wantsVisible(r)) {
          return;
        }
        if (rec.status === "built" && !this.wantsVisible(r)) {
          this.hideInstant(rec);
          return;
        }
        rec.status = "unbuilt";
        rec.armed = false;
        rec.phase = "";
        rec.q = 0;
        card.classList.add("sw-hide");
      });
    }

    showInstant(rec) {
      rec.el.classList.remove("sw-hide", "sw-ghost", "sw-build", "sw-snap");
      rec.el.style.clipPath = "";
      rec.el.style.opacity = "";
      rec.el.style.willChange = "";
      rec.status = "built";
      rec.armed = false;
      rec.phase = "";
      rec.q = 1;
      if (rec.drone) rec.drone.release();
    }

    hideInstant(rec) {
      rec.el.classList.remove("sw-ghost", "sw-build", "sw-snap");
      rec.el.classList.add("sw-hide");
      rec.el.style.clipPath = "";
      rec.el.style.opacity = "";
      rec.el.style.willChange = "";
      rec.status = "unbuilt";
      rec.armed = false;
      rec.phase = "";
      rec.q = 0;
      if (rec.drone) rec.drone.release();
    }

    restore(rec) {
      this.showInstant(rec);
    }

    evaluate() {
      const vh = window.innerHeight;
      const ready = [];

      for (const rec of this.order) {
        const el = rec.el;
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 && r.height < 4) continue;

        const want = this.wantsVisible(r);
        const drone = rec.drone;
        if (!drone) continue;

        if (want) {
          if (rec.status === "unbuilt" && !drone.busy) {
            this.dispatchBuild(drone, rec);
          } else if (rec.status === "demolishing") {
            // scroll flipped down mid-erase → resume build from current q
            this.flipToBuild(drone, rec);
          }
          if (rec.status === "unbuilt" || rec.status === "building") {
            if (r.top < vh && r.bottom > 0) ready.push({ rec, r });
          }
        } else {
          const side = this.exitSide(r);
          if (rec.status === "built" && !drone.busy) {
            this.dispatchDemolish(drone, rec, side);
          } else if (rec.status === "building") {
            this.flipToDemolish(drone, rec, side);
          } else if (rec.status === "demolishing" && rec.eraseDir && rec.eraseDir !== side) {
            rec.eraseDir = side;
          }
        }
      }
      this.ready = ready;
    }

    dispatchBuild(drone, rec) {
      const el = rec.el;
      rec.status = "building";
      rec.armed = false;
      rec.phase = "";
      rec.q = 0;
      rec.speed = APPROACH_LERP;
      rec.drone = drone;

      const r = el.getBoundingClientRect();
      drone.busy = true;
      drone.rec = rec;
      drone.tx = r.left + r.width * (drone.index % 2 ? 0.9 : 0.1);
      drone.ty = Math.max(r.top, 0) + 4;
      drone.setLabel(`SCAN ${labelFor(el, rec.id)}`);
      this.placeDrone(drone, drone.tx, drone.ty, true);
      Sfx.lock();
    }

    applyEraseClip(el, q, dir) {
      const cut = ((1 - q) * 100).toFixed(3);
      // top exit: wipe downward from the top edge (card leaving upward)
      // bottom exit: wipe upward from the bottom edge (card leaving downward)
      if (dir === "top") {
        el.style.clipPath = `inset(${cut}% 0 0 0)`;
      } else {
        el.style.clipPath = `inset(0 0 ${cut}% 0)`;
      }
      el.style.opacity = String(Math.max(0.35, Math.min(1, 0.4 + q * 0.6)));
    }

    dispatchDemolish(drone, rec, side) {
      const el = rec.el;
      const r = el.getBoundingClientRect();
      const dir = side || this.exitSide(r);
      rec.status = "demolishing";
      rec.armed = true;
      rec.phase = "erase";
      rec.eraseDir = dir;
      rec.q = typeof rec.q === "number" && rec.q > 0 ? rec.q : 1;
      rec.qStart = rec.q;
      rec.eraseAt = performance.now();
      rec.eraseDur = Math.max(ERASE_DUR_MIN, Math.min(ERASE_DUR_MAX, r.height * 2.1 + 900));
      rec.lastTick = 0;
      rec.drone = drone;

      el.classList.remove("sw-hide", "sw-snap");
      el.classList.add("sw-build");
      el.style.willChange = "clip-path, opacity";
      this.applyEraseClip(el, rec.q, dir);

      const sideX = drone.index % 2 ? 0.9 : 0.1;
      const startY = dir === "top" ? r.top + 4 : r.top + r.height * rec.q;
      drone.busy = true;
      drone.rec = rec;
      drone.x = r.left + r.width * sideX;
      drone.y = startY;
      drone.tx = drone.x;
      drone.ty = startY;
      drone.setLabel(`ERASE ${dir === "top" ? "↑" : "↓"} ${labelFor(el, rec.id)}`);
      this.placeDrone(drone, drone.x, drone.y, true);
      Sfx.lock();
    }

    flipToBuild(drone, rec) {
      const r = rec.el.getBoundingClientRect();
      rec.status = "building";
      rec.armed = true;
      rec.phase = "fill";
      rec.speed = APPROACH_LERP;
      rec.eraseDir = "";
      rec.fillAt = performance.now();
      rec.fillStartQ = Math.max(0, Math.min(0.95, rec.q || 0));
      rec.fillDur = Math.max(
        FILL_DUR_MIN * 0.55,
        Math.min(FILL_DUR_MAX, r.height * 2.4 * (1 - rec.fillStartQ) + 1000)
      );
      rec.el.classList.remove("sw-hide");
      rec.el.classList.add("sw-build");
      drone.setLabel(`FILL ${labelFor(rec.el, rec.id)}`);
      Sfx.sweep();
    }

    flipToDemolish(drone, rec, side) {
      const r = rec.el.getBoundingClientRect();
      const dir = side || this.exitSide(r);
      rec.status = "demolishing";
      rec.armed = true;
      rec.phase = "erase";
      rec.eraseDir = dir;
      rec.qStart = Math.max(0.08, Math.min(1, rec.q || 1));
      rec.eraseAt = performance.now();
      rec.eraseDur = Math.max(
        ERASE_DUR_MIN * 0.7,
        Math.min(ERASE_DUR_MAX, r.height * 2.0 * rec.qStart + 800)
      );
      rec.lastTick = 0;
      rec.el.classList.remove("sw-hide");
      rec.el.classList.add("sw-build");
      rec.el.style.willChange = "clip-path, opacity";
      this.applyEraseClip(rec.el, rec.qStart, dir);
      drone.setLabel(`ERASE ${dir === "top" ? "↑" : "↓"} ${labelFor(rec.el, rec.id)}`);
      Sfx.lock();
    }

    /** Smooth ease-in-out curve for build / erase progress. */
    easeInOut(t) {
      const x = Math.max(0, Math.min(1, t));
      return x * x * (3 - 2 * x);
    }

    /** Softer ease-out — steady start, gentle settle at the end. */
    easeOutCubic(t) {
      const x = Math.max(0, Math.min(1, t));
      return 1 - Math.pow(1 - x, 3);
    }

    finishBuild(drone, instant) {
      const rec = drone.rec || drone.homeRec;
      if (!rec) {
        drone.release();
        return;
      }
      const el = rec.el;
      const r = el.getBoundingClientRect();

      el.classList.remove("sw-hide", "sw-ghost", "sw-build");
      el.style.clipPath = "";
      el.style.opacity = "";
      el.style.willChange = "";
      rec.status = "built";
      rec.phase = "";
      rec.q = 1;
      rec.armed = false;

      if (!instant) {
        el.classList.add("sw-snap");
        clearTimeout(rec.tSnap);
        rec.tSnap = setTimeout(() => el.classList.remove("sw-snap"), 480);
        this.burst(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40), drone.color);
        Sfx.done();
        this.snapCount++;
      }
      drone.release();
    }

    finishDemolish(drone, instant) {
      const rec = drone.rec || drone.homeRec;
      if (!rec) {
        drone.release();
        return;
      }
      const el = rec.el;
      const r = el.getBoundingClientRect();

      el.classList.remove("sw-ghost", "sw-build", "sw-snap");
      el.classList.add("sw-hide");
      el.style.clipPath = "";
      el.style.opacity = "";
      el.style.willChange = "";
      rec.status = "unbuilt";
      rec.phase = "";
      rec.q = 0;
      rec.qStart = 0;
      rec.armed = false;
      rec.eraseAt = 0;
      rec.lastTick = 0;
      rec.eraseDir = "";

      if (!instant) {
        this.burst(r.left + r.width / 2, r.top + 8, drone.color);
        Sfx.tick(0.15);
      }
      drone.release();
    }

    blueprint(ctx, r, alpha) {
      ctx.save();
      ctx.strokeStyle = "#00f2fe";
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
      ctx.setLineDash([]);
      const k = Math.min(16, r.width * 0.3, r.height * 0.3);
      if (k > 4) {
        ctx.globalAlpha = Math.min(0.5, alpha * 2.4);
        ctx.beginPath();
        ctx.moveTo(r.left, r.top + k); ctx.lineTo(r.left, r.top); ctx.lineTo(r.left + k, r.top);
        ctx.moveTo(r.right - k, r.top); ctx.lineTo(r.right, r.top); ctx.lineTo(r.right, r.top + k);
        ctx.moveTo(r.left, r.bottom - k); ctx.lineTo(r.left, r.bottom); ctx.lineTo(r.left + k, r.bottom);
        ctx.moveTo(r.right - k, r.bottom); ctx.lineTo(r.right, r.bottom); ctx.lineTo(r.right, r.bottom - k);
        ctx.stroke();
      }
      ctx.restore();
    }

    grid(ctx, r, progress, color, alpha) {
      const top = r.top + r.height * progress;
      const height = r.bottom - top;
      if (height < 4 || r.width < 6) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.left, top, r.width, height);
      ctx.clip();
      ctx.globalAlpha = alpha * 0.42;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      const step = 22;
      ctx.beginPath();
      for (let y = r.top; y < r.bottom; y += step) {
        ctx.moveTo(r.left, y + 0.5);
        ctx.lineTo(r.right, y + 0.5);
      }
      for (let x = r.left; x < r.right; x += step) {
        ctx.moveTo(x + 0.5, top);
        ctx.lineTo(x + 0.5, r.bottom);
      }
      ctx.stroke();
      ctx.restore();
    }

    tracePoint(b, t) {
      const w = b.width;
      const h = b.height;
      let d = t * 2 * (w + h);
      if (d <= w) return { x: b.left + d, y: b.top };
      d -= w;
      if (d <= h) return { x: b.right, y: b.top + d };
      d -= h;
      if (d <= w) return { x: b.right - d, y: b.bottom };
      d -= w;
      return { x: b.left, y: b.bottom - Math.min(d, h) };
    }

    tracePath(ctx, b, tp, color) {
      const segs = [
        [b.left, b.top, b.right, b.top],
        [b.right, b.top, b.right, b.bottom],
        [b.right, b.bottom, b.left, b.bottom],
        [b.left, b.bottom, b.left, b.top],
      ];
      const total = 2 * (b.width + b.height);
      let left = tp * total;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.95;
      ctx.shadowBlur = 13;
      ctx.shadowColor = color;
      ctx.beginPath();
      for (const seg of segs) {
        if (left <= 0) break;
        const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
        const f = Math.min(1, left / Math.max(1, len));
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[0] + (seg[2] - seg[0]) * f, seg[1] + (seg[3] - seg[1]) * f);
        left -= len;
      }
      ctx.stroke();
      const head = this.tracePoint(b, tp);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    burstAt(x, y, color, count) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.5 + Math.random() * 5;
        this.particles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 0.6,
          size: 1.2 + Math.random() * 2.6,
          life: 1,
          color,
        });
      }
    }

    burst(x, y, color) {
      for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        this.particles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 1.5 + Math.random() * 3.2,
          life: 1,
          color,
        });
      }
    }

    drawParticles() {
      const ctx = this.ctx;
      if (!ctx) return;
      const floor = this.headerBottom();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, floor, this.cw, Math.max(0, this.ch - floor));
      ctx.clip();
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.97;
        p.vy *= 0.97;
        p.life -= 0.035;
        p.size *= 0.965;
        if (p.life <= 0 || p.y < floor - 20) {
          this.particles.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, p.size), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    frame(now) {
      if (!this.running) return;
      if (now - this.lastQueue > 110) {
        this.lastQueue = now;
        this.evaluate();
      }
      this.step(now);
      this.drawParticles();
      this.raf = requestAnimationFrame(this.frame);
    }

    step(now) {
      if (!now) now = performance.now();
      const ctx = this.ctx;
      if (ctx) ctx.clearRect(0, 0, this.cw, this.ch);
      const vh = this.ch;
      const minY = this.headerBottom();

      if (ctx && this.ready) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, minY, this.cw, Math.max(0, vh - minY));
        ctx.clip();
        const pulse = now * 0.0026;
        for (let i = 0; i < this.ready.length; i++) {
          const item = this.ready[i];
          if (item.rec.status !== "unbuilt") continue;
          const r = item.r;
          if (r.width < 8 || r.height < 8 || r.bottom < minY || r.top > vh - 4) continue;
          this.blueprint(ctx, r, 0.1 + 0.05 * Math.sin(pulse + item.rec.id));
        }
        ctx.restore();
      }

      for (const d of this.drones) {
        const rec = d.rec || d.homeRec;

        if (!d.busy || !rec || (rec.status !== "building" && rec.status !== "demolishing")) {
          if (rec && rec.el.isConnected) {
            const r = rec.el.getBoundingClientRect();
            d.tx = r.left + r.width * 0.5;
            d.ty = Math.max(minY, r.top - 18);
          }
          d.x += (d.tx - d.x) * 0.08;
          d.y += (d.ty - d.y) * 0.08;
          this.placeDrone(d, d.x, d.y, false);
          continue;
        }

        const el = rec.el;
        if (!el.isConnected) {
          if (rec.status === "demolishing") this.finishDemolish(d, true);
          else this.finishBuild(d, true);
          continue;
        }

        const r = el.getBoundingClientRect();
        if (r.height <= 0) {
          if (rec.status === "demolishing") this.finishDemolish(d, true);
          else this.finishBuild(d, true);
          continue;
        }

        if (rec.status === "demolishing") {
          this.stepDemolish(d, rec, el, r, ctx, vh, now);
        } else {
          this.stepBuild(d, rec, el, r, ctx, vh, now);
        }
      }
    }

    stepBuild(d, rec, el, r, ctx, vh, now) {
      const startY = Math.max(r.top, 0);
      const endY = Math.min(r.bottom, vh - 24);
      const box = {
        left: r.left,
        right: r.right,
        top: startY,
        bottom: endY,
        width: r.width,
        height: Math.max(1, endY - startY),
      };

      if (!rec.armed) {
        d.tx = box.left;
        d.ty = box.top;
        if (Math.hypot(d.x - d.tx, d.y - d.ty) < 36) {
          rec.armed = true;
          rec.phase = "trace";
          rec.phaseAt = now;
          rec.q = 0;
          rec.traceDur = Math.max(
            TRACE_DUR_MIN,
            Math.min(TRACE_DUR_MAX, ((box.width + box.height) * 2) / 2.4)
          );
          d.setLabel(`TRACE ${labelFor(el, rec.id)}`);
          Sfx.lock();
        }
        d.x += (d.tx - d.x) * rec.speed;
        d.y += (d.ty - d.y) * rec.speed;
        this.placeDrone(d, d.x, d.y, true);
        return;
      }

      if (endY - startY < 8) {
        this.finishBuild(d, false);
        return;
      }

      if (rec.phase === "trace") {
        const rawT = Math.min(1, (now - rec.phaseAt) / rec.traceDur);
        const tp = this.easeInOut(rawT);
        const head = this.tracePoint(box, tp);
        this.placeDrone(d, head.x, head.y, true);
        if (ctx) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, this.headerBottom(), this.cw, Math.max(0, vh - this.headerBottom()));
          ctx.clip();
          this.tracePath(ctx, box, tp, d.color);
          ctx.restore();
        }
        if (rawT >= 1) {
          rec.phase = "fill";
          rec.fillAt = now;
          rec.fillStartQ = 0;
          rec.fillDur = Math.max(
            FILL_DUR_MIN,
            Math.min(FILL_DUR_MAX, box.height * 2.6 + 1100)
          );
          rec.lastTick = 0;
          el.classList.remove("sw-hide", "sw-ghost");
          el.classList.add("sw-build");
          el.style.opacity = "0";
          d.setLabel(`FILL ${labelFor(el, rec.id)}`);
          Sfx.sweep();
        }
        return;
      }

      // Timed fill scan — smooth ease, drone rides the wipe line
      const fillStart = typeof rec.fillStartQ === "number" ? rec.fillStartQ : 0;
      const fillDur = rec.fillDur || FILL_DUR_MIN;
      const fillAt = rec.fillAt || now;
      const raw = Math.min(1, (now - fillAt) / fillDur);
      const eased = this.easeOutCubic(raw);
      const q = Math.min(1, fillStart + (1 - fillStart) * eased);

      if (q - (rec.lastTick || 0) >= 0.08) {
        rec.lastTick = q;
        const y = r.top + r.height * q;
        this.burstAt(r.left + r.width / 2, y, d.color, 3);
        Sfx.tick(q);
        d.setLabel(`BUILD ${Math.round(q * 100)}% // ${labelFor(el, rec.id)}`);
      }
      rec.q = q;

      d.tx = r.left + r.width * (d.index % 2 ? 0.94 : 0.06);
      d.ty = r.top + r.height * q;
      d.x += (d.tx - d.x) * DRONE_FOLLOW;
      d.y += (d.ty - d.y) * DRONE_FOLLOW;
      this.placeDrone(d, d.x, d.y, true);

      el.style.clipPath = `inset(0 0 ${((1 - q) * 100).toFixed(3)}% 0)`;
      el.style.opacity = String(Math.min(1, 0.15 + q * 0.9));

      if (ctx) {
        const scanY = r.top + r.height * q;
        const floor = this.headerBottom();
        if (scanY >= floor) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, floor, this.cw, Math.max(0, vh - floor));
          ctx.clip();
          this.grid(ctx, r, q, d.color, 0.4);
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = d.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([7, 5]);
          ctx.shadowBlur = 14;
          ctx.shadowColor = d.color;
          ctx.beginPath();
          ctx.moveTo(r.left, scanY);
          ctx.lineTo(r.right, scanY);
          ctx.stroke();
          ctx.restore();
        }
      }

      if (raw >= 1 || q >= 0.999) this.finishBuild(d, false);
    }

    stepDemolish(d, rec, el, r, ctx, vh, now) {
      const dir = rec.eraseDir || "bottom";
      const t0 = rec.eraseAt || now;
      const dur = rec.eraseDur || 800;
      const startQ = typeof rec.qStart === "number" ? rec.qStart : 1;
      const raw = Math.min(1, (now - t0) / dur);
      const eased = this.easeInOut(raw);
      const q = Math.max(0, startQ * (1 - eased));
      rec.q = q;

      // Wipe edge position: top-exit grows downward; bottom-exit shrinks upward
      const scanY = dir === "top"
        ? r.top + r.height * (1 - q)
        : r.top + r.height * q;

      const side = d.index % 2 ? 0.88 : 0.12;
      d.tx = r.left + r.width * side;
      d.ty = scanY;
      d.x += (d.tx - d.x) * DRONE_FOLLOW;
      d.y += (d.ty - d.y) * DRONE_FOLLOW;
      this.placeDrone(d, d.x, d.y, true);

      this.applyEraseClip(el, q, dir);

      const erased = 1 - q / Math.max(0.001, startQ);
      if (erased - (rec.lastTick || 0) >= 0.1) {
        rec.lastTick = erased;
        if (scanY >= this.headerBottom()) {
          this.burstAt(r.left + r.width / 2, scanY, d.color, 5);
          this.burstAt(r.left + 3, scanY, d.color, 2);
          this.burstAt(r.right - 3, scanY, d.color, 2);
        }
        Sfx.tick(erased);
        d.setLabel(`ERASE ${dir === "top" ? "↑" : "↓"} ${Math.round(erased * 100)}%`);
      }

      const floor = this.headerBottom();
      if (ctx && r.width > 4 && r.height > 4 && scanY >= floor - 2) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, floor, this.cw, Math.max(0, vh - floor));
        ctx.clip();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = d.color;
        if (dir === "top") {
          ctx.fillRect(r.left, Math.max(r.top, floor), r.width, Math.max(0, scanY - Math.max(r.top, floor)));
        } else {
          ctx.fillRect(r.left, Math.max(scanY, floor), r.width, Math.max(0, r.bottom - Math.max(scanY, floor)));
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 2.4;
        ctx.shadowBlur = 22;
        ctx.shadowColor = d.color;
        ctx.beginPath();
        ctx.moveTo(r.left, scanY);
        ctx.lineTo(r.right, scanY);
        ctx.stroke();
        const glow = ctx.createLinearGradient(r.left, scanY - 14, r.left, scanY + 14);
        glow.addColorStop(0, "rgba(0,0,0,0)");
        glow.addColorStop(0.5, d.color);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = glow;
        ctx.fillRect(r.left, scanY - 14, r.width, 28);
        ctx.restore();
      }

      if (q <= 0.001 || raw >= 1) this.finishDemolish(d, false);
    }

    refresh(root) {
      if (!this.running) return;
      const scope = typeof root === "string" ? document.querySelector(root) : root;
      this.syncGallery(scope || document.getElementById("galleryGrid"));
      this.evaluate();
    }
  }

  function start() {
    const api = window.__swarmRebuild;
    if (api.app) return api.app;
    const swarm = new Swarm();
    api.app = swarm;
    swarm.begin();
    return swarm;
  }

  function stop() {
    const api = window.__swarmRebuild;
    if (api.app) api.app.stop();
    api.app = null;
  }

  function refresh(root) {
    const api = window.__swarmRebuild;
    if (api.app && typeof api.app.refresh === "function") {
      api.app.refresh(root);
    }
  }

  window.__swarmRebuild = {
    built: true,
    app: null,
    start,
    stop,
    refresh,
    unlockAudio() {
      try { Sfx.resume(); } catch (err) { /* ignore */ }
    },
    setMuted(value) {
      muted = !!value;
    },
    get muted() {
      return muted;
    },
  };
})();
