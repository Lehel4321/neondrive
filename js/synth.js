/* NEON DRIVE — synth voices & audio graph. Every function takes a ctx so the
   same code renders both live (AudioContext) and for WAV export (OfflineAudioContext). */
window.ND = window.ND || {};

(function (ND) {
  'use strict';

  // ---------- shared per-context resources ----------

  function noiseBuffer(ctx) {
    if (ctx.__ndNoise) return ctx.__ndNoise;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    ctx.__ndNoise = buf;
    return buf;
  }

  function reverbImpulse(ctx, seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  function softClipCurve() {
    var n = 1024, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
    }
    return curve;
  }

  function track(g, src) {
    // keep a handle on every source so stop() can silence long tails
    if (g.sources) {
      g.sources.add(src);
      src.onended = function () { g.sources.delete(src); };
    }
    return src;
  }

  // ---------- master graph ----------
  // Returns the bus object used by the sequencer. `live` adds an analyser for the scope.
  ND.buildGraph = function (ctx, live) {
    var g = { ctx: ctx, sources: new Set() };

    g.master = ctx.createGain();
    g.master.gain.value = 0.9;

    var shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve();
    shaper.oversample = '2x';

    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;

    g.masterVol = ctx.createGain();
    g.cut = ctx.createGain(); // fast fade used on stop to avoid clicks

    g.master.connect(shaper);
    shaper.connect(comp);
    comp.connect(g.masterVol);
    g.masterVol.connect(g.cut);
    g.cut.connect(ctx.destination);

    if (live) {
      g.analyser = ctx.createAnalyser();
      g.analyser.fftSize = 2048;
      g.masterVol.connect(g.analyser);
    }

    // sidechain pump bus — everything melodic ducks when the kick hits
    g.pump = ctx.createGain();
    g.pump.connect(g.master);

    // per-track gains
    g.drums = ctx.createGain(); g.drums.connect(g.master);
    g.bass = ctx.createGain();  g.bass.connect(g.pump);
    g.arp = ctx.createGain();   g.arp.connect(g.pump);
    g.lead = ctx.createGain();  g.lead.connect(g.pump);
    g.pads = ctx.createGain();  g.pads.connect(g.pump);

    // ping-pong delay (dotted 8th), time set by engine from the BPM
    g.delayIn = ctx.createGain();
    g.delayL = ctx.createDelay(2);
    g.delayR = ctx.createDelay(2);
    var fbL = ctx.createGain(), fbR = ctx.createGain();
    fbL.gain.value = 0.38; fbR.gain.value = 0.38;
    var panL = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    var panR = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (panL.pan) { panL.pan.value = -0.7; panR.pan.value = 0.7; }
    var dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = 4200;
    g.delayReturn = ctx.createGain();
    g.delayIn.connect(g.delayL);
    g.delayL.connect(fbL); fbL.connect(g.delayR);
    g.delayR.connect(fbR); fbR.connect(g.delayL);
    g.delayL.connect(panL); g.delayR.connect(panR);
    panL.connect(dlp); panR.connect(dlp);
    dlp.connect(g.delayReturn);
    g.delayReturn.connect(g.master);

    // reverb
    g.verbIn = ctx.createGain();
    var conv = ctx.createConvolver();
    conv.buffer = reverbImpulse(ctx, 2.4);
    g.verbReturn = ctx.createGain();
    g.verbIn.connect(conv);
    conv.connect(g.verbReturn);
    g.verbReturn.connect(g.master);

    // gentle drive for the bass, shared
    g.bassDrive = ctx.createWaveShaper();
    g.bassDrive.curve = softClipCurve();
    g.bassDrive.connect(g.bass);

    return g;
  };

  // sidechain duck at time t
  ND.pumpAt = function (g, t, depth, beatDur) {
    if (depth <= 0.01) return;
    var p = g.pump.gain;
    p.setValueAtTime(1 - 0.8 * depth, t);
    p.linearRampToValueAtTime(1, t + beatDur * 0.62);
  };

  // ---------- drums ----------

  ND.kick = function (g, t, vel) {
    var ctx = g.ctx;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.095);
    gain.gain.setValueAtTime(1.05 * vel, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    osc.connect(gain); gain.connect(g.drums);
    track(g, osc).start(t); osc.stop(t + 0.45);

    // click transient
    var click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx);
    var chp = ctx.createBiquadFilter();
    chp.type = 'highpass'; chp.frequency.value = 1400;
    var cg = ctx.createGain();
    cg.gain.setValueAtTime(0.5 * vel, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    click.connect(chp); chp.connect(cg); cg.connect(g.drums);
    track(g, click).start(t); click.stop(t + 0.03);
  };

  ND.snare = function (g, t, vel) {
    var ctx = g.ctx;
    // body
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(196, t);
    var og = ctx.createGain();
    og.gain.setValueAtTime(0.5 * vel, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og); og.connect(g.drums);
    track(g, osc).start(t); osc.stop(t + 0.1);

    // snap
    var n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1700;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.8 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(hp); hp.connect(ng); ng.connect(g.drums);
    track(g, n).start(t); n.stop(t + 0.2);

    // 80s gated-reverb tail: flat noisy sustain chopped off hard
    var gate = ctx.createBufferSource();
    gate.buffer = noiseBuffer(ctx);
    gate.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 0.6;
    var gg = ctx.createGain();
    gg.gain.setValueAtTime(0.0001, t);
    gg.gain.linearRampToValueAtTime(0.32 * vel, t + 0.012);
    gg.gain.setValueAtTime(0.26 * vel, t + 0.17);
    gg.gain.linearRampToValueAtTime(0.0001, t + 0.185);
    gate.connect(bp); bp.connect(gg); gg.connect(g.drums);
    track(g, gate).start(t); gate.stop(t + 0.2);

    var send = ctx.createGain();
    send.gain.value = 0.25 * vel;
    ng.connect(send); send.connect(g.verbIn);
  };

  ND.clap = function (g, t, vel) {
    var ctx = g.ctx;
    for (var i = 0; i < 3; i++) {
      var n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.4;
      var gn = ctx.createGain();
      var tt = t + i * 0.011;
      gn.gain.setValueAtTime(0.55 * vel, tt);
      gn.gain.exponentialRampToValueAtTime(0.001, tt + (i === 2 ? 0.24 : 0.03));
      n.connect(bp); bp.connect(gn); gn.connect(g.drums);
      track(g, n).start(tt); n.stop(tt + 0.3);
      if (i === 2) {
        var send = ctx.createGain();
        send.gain.value = 0.3 * vel;
        gn.connect(send); send.connect(g.verbIn);
      }
    }
  };

  ND.hat = function (g, t, vel, open) {
    var ctx = g.ctx;
    var n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7600;
    var gn = ctx.createGain();
    var dur = open ? 0.3 : 0.045;
    gn.gain.setValueAtTime((open ? 0.45 : 0.4) * vel, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(gn); gn.connect(g.drums);
    track(g, n).start(t); n.stop(t + dur + 0.05);
  };

  // ---------- melodic voices ----------

  ND.bassNote = function (g, t, freq, dur, cutoff, vel) {
    var ctx = g.ctx;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    var base = 180 + cutoff * 1400;
    f.frequency.setValueAtTime(base * 3.2, t);
    f.frequency.exponentialRampToValueAtTime(base, t + 0.12);

    var amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.5 * vel, t + 0.004);
    amp.gain.setValueAtTime(0.5 * vel, t + Math.max(0.01, dur - 0.03));
    amp.gain.linearRampToValueAtTime(0.0001, t + dur);

    [-7, 7].forEach(function (cents) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = cents;
      o.connect(f);
      track(g, o).start(t); o.stop(t + dur + 0.02);
    });
    f.connect(amp);
    amp.connect(g.bassDrive);
  };

  ND.arpNote = function (g, t, freq, dur, vel) {
    var ctx = g.ctx;
    var o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(4600, t);
    f.frequency.exponentialRampToValueAtTime(900, t + dur);
    var amp = ctx.createGain();
    amp.gain.setValueAtTime(0.16 * vel, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(amp); amp.connect(g.arp);
    track(g, o).start(t); o.stop(t + dur + 0.02);

    var send = ctx.createGain();
    send.gain.value = 0.45;
    amp.connect(send); send.connect(g.delayIn);
  };

  ND.leadNote = function (g, t, freq, dur, vel) {
    var ctx = g.ctx;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(5200, t);

    var amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.3 * vel, t + 0.012);
    amp.gain.setValueAtTime(0.3 * vel, t + Math.max(0.02, dur - 0.05));
    amp.gain.linearRampToValueAtTime(0.0001, t + dur + 0.03);

    // delayed vibrato
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 5.6;
    var lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(7, t + 0.35);

    [-9, 9].forEach(function (cents) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = cents;
      lfoG.connect(o.detune);
      o.connect(f);
      track(g, o).start(t); o.stop(t + dur + 0.08);
    });
    track(g, lfo).start(t); lfo.stop(t + dur + 0.08);

    f.connect(amp);
    amp.connect(g.lead);

    var dsend = ctx.createGain();
    dsend.gain.value = 0.4;
    amp.connect(dsend); dsend.connect(g.delayIn);
    var vsend = ctx.createGain();
    vsend.gain.value = 0.3;
    amp.connect(vsend); vsend.connect(g.verbIn);
  };

  ND.padChord = function (g, t, freqs, dur) {
    var ctx = g.ctx;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1900, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(800, t + dur + 0.5);

    var amp = ctx.createGain();
    var lvl = 0.085;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(lvl, t + Math.min(0.45, dur * 0.3));
    amp.gain.setValueAtTime(lvl, t + dur - 0.05);
    amp.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);

    // slow chorus motion on one side of the detune
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.6;
    var lfoG = ctx.createGain();
    lfoG.gain.value = 5;

    freqs.forEach(function (fr, i) {
      [-11, 11].forEach(function (cents, j) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = fr;
        o.detune.value = cents + (i % 2 ? 3 : -3);
        if (j === 1) lfoG.connect(o.detune);
        o.connect(f);
        track(g, o).start(t); o.stop(t + dur + 0.7);
      });
    });
    track(g, lfo).start(t); lfo.stop(t + dur + 0.7);

    f.connect(amp);
    amp.connect(g.pads);

    var send = ctx.createGain();
    send.gain.value = 0.6;
    amp.connect(send); send.connect(g.verbIn);
  };
})(window.ND);
