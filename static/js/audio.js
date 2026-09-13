// Web Audio: 带非谐分音的双音合成
(function () {
  let ctx = null, master = null;
  let liveNodes = [];

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 1;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function amp(n) {
    const base = [1, 0.62, 0.42, 0.28, 0.18, 0.12, 0.08, 0.05];
    return (base[n - 1] ?? 0.03) / Math.sqrt(n);
  }

  function playNote(f1, B, when, dur, gainScale) {
    const c = ac();
    const out = c.createGain();
    out.connect(master);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(0.22 * gainScale, when + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    liveNodes.push(out);
    const nmax = f1 < 400 ? 8 : f1 < 1000 ? 6 : 4;
    for (let n = 1; n <= nmax; n++) {
      const fn = n * f1 * Math.sqrt(1 + B * n * n);
      if (fn > c.sampleRate / 2.2) break;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = n === 1 ? 'triangle' : 'sine';
      o.frequency.value = fn;
      g.gain.value = amp(n);
      o.connect(g); g.connect(out);
      o.start(when);
      o.stop(when + dur + 0.05);
      liveNodes.push(o);
    }
  }

  window.PianoAudio = {
    // 播两个音; b: 低音键参与拍频的分音, p: 高音键分音
    playPair(f1a, Ba, f1b, Bb, b = 2, p = 1, usePartials = true) {
      this.stop();
      const c = ac();
      const t = c.currentTime + 0.03;
      const dur = 4.5;
      playNote(f1a, usePartials ? Ba : 0, t, dur, 0.8);
      playNote(f1b, usePartials ? Bb : 0, t, dur, 0.8);
      const fa = b * f1a * Math.sqrt(1 + Ba * b * b);
      const fb = p * f1b * Math.sqrt(1 + Bb * p * p);
      return {
        stop: () => this.stop(),
        beatHz: fa - fb,
        beatPartialHz: (fa + fb) / 2,
        durationMs: dur * 1000,
      };
    },
    playOne(f1, B, usePartials = true) {
      this.stop();
      playNote(f1, usePartials ? B : 0, ac().currentTime + 0.02, 2.4, 1.0);
    },
    stop() {
      for (const n of liveNodes) {
        try {
          if (n.stop) n.stop();
          if (n.disconnect) n.disconnect();
        } catch (e) { /* 已停止 */ }
      }
      liveNodes = [];
    },
  };
})();
