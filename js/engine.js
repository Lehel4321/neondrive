/* NEON DRIVE — song state, sequencer, generator, WAV export */
window.ND = window.ND || {};

(function (ND) {
  'use strict';

  var STEPS_PER_BAR = 16;
  var BARS = 4;
  var TOTAL = STEPS_PER_BAR * BARS;
  ND.TOTAL_STEPS = TOTAL;
  ND.LEAD_ROWS = 15; // two octaves of the minor scale + top root

  // ---------- default song (should sound good the moment the page opens) ----------

  function emptyLead() {
    return new Array(TOTAL).fill(-1);
  }

  ND.defaultState = function () {
    var p = ND.DRUM_PATTERNS[0];
    var lead = emptyLead();
    // hand-written opening melody in the minor scale (row index per 16th step, -1 = rest)
    var phrase = [
      4, 4, 7, 7, 6, 6, 4, 4, 4, 4, 2, 2, 3, 3, 4, 4,       // bar 1
      5, 5, 5, 5, 7, 7, 6, 6, 5, 5, 4, 4, 4, 4, -1, -1,     // bar 2
      9, 9, 9, 9, 8, 8, 7, 7, 6, 6, 4, 4, 4, 4, 6, 6,       // bar 3
      8, 8, 7, 7, 6, 6, 6, 6, 4, 4, 4, 4, 7, 7, 7, 7,       // bar 4
    ];
    for (var i = 0; i < TOTAL; i++) lead[i] = phrase[i];
    return {
      version: 1,
      name: 'Midnight Run',
      bpm: 96,
      key: 9, // A minor
      progression: 0,
      seed: 1987,
      drums: {
        preset: 0,
        kick: p.kick.slice(), snare: p.snare.slice(), clap: p.clap.slice(),
        hat: p.hat.slice(), openhat: p.openhat.slice(),
        fill: true,
      },
      bass: { style: 0, octave: 0, cutoff: 0.5 },
      arp: { on: true, mode: 'updown', rate: 16, octaves: 2 },
      lead: { notes: lead },
      pads: { on: true },
      levels: { drums: 0.9, bass: 0.8, arp: 0.7, lead: 0.85, pads: 0.75 },
      mutes: { drums: false, bass: false, arp: false, lead: false, pads: false },
      fx: { pump: 0.55, delay: 0.4, reverb: 0.45, master: 0.85 },
    };
  };

  ND.state = ND.defaultState();

  // ---------- music helpers ----------

  ND.chordAt = function (bar) {
    var st = ND.state;
    var degs = ND.PROGRESSIONS[st.progression].degs;
    var deg = degs[bar % 4];
    var rootPc = (st.key + ND.MINOR[deg]) % 12;
    var quality = ND.QUALITY[deg];
    var third = quality === 'm' || quality === 'dim' ? 3 : 4;
    var fifth = quality === 'dim' ? 6 : 7;
    return {
      deg: deg,
      rootPc: rootPc,
      name: ND.KEYS[rootPc] + quality,
      intervals: [0, third, fifth],
      rootSemi: ND.MINOR[deg], // offset from the song key
    };
  };

  ND.leadMidi = function (row) {
    var st = ND.state;
    return 48 + st.key + ND.MINOR[row % 7] + 12 * Math.floor(row / 7);
  };

  function chordToneMidis(chord, baseMidi, octaves) {
    var out = [];
    for (var o = 0; o < octaves; o++) {
      chord.intervals.forEach(function (iv) {
        out.push(baseMidi + chord.rootSemi + iv + 12 * o);
      });
    }
    return out;
  }

  // ---------- per-step scheduling (shared by live playback and export) ----------

  ND.scheduleStep = function (g, step, t, stepDur) {
    var st = ND.state;
    var bar = Math.floor(step / STEPS_PER_BAR) % BARS;
    var s = step % STEPS_PER_BAR;
    var chord = ND.chordAt(bar);
    var beatDur = stepDur * 4;
    var lvl = st.levels, mute = st.mutes;

    // --- drums ---
    var fillZone = st.drums.fill && bar === 3 && s >= 12;
    if (!mute.drums) {
      if (st.drums.kick[s]) {
        ND.kick(g, t, 1);
        ND.pumpAt(g, t, st.fx.pump, beatDur);
      }
      if (fillZone) {
        ND.snare(g, t, 0.45 + 0.18 * (s - 12));
      } else if (st.drums.snare[s]) {
        ND.snare(g, t, 1);
      }
      if (st.drums.clap[s] && !fillZone) ND.clap(g, t, 0.9);
      if (st.drums.hat[s]) ND.hat(g, t, s % 4 === 0 ? 0.9 : 0.55, false);
      if (st.drums.openhat[s]) ND.hat(g, t, 0.8, true);
    } else if (st.drums.kick[s]) {
      // keep the pump groove even when drums are muted
      ND.pumpAt(g, t, st.fx.pump, beatDur);
    }

    // --- bass ---
    if (!mute.bass) {
      var styl = ND.BASS_STYLES[st.bass.style];
      var bn = styl.note(s);
      if (bn) {
        var midi = 24 + st.key + chord.rootSemi + bn.semi + 12 * st.bass.octave;
        ND.bassNote(g, t, ND.mtof(midi), Math.max(stepDur * bn.len, 0.05),
          st.bass.cutoff, bn.vel);
      }
    }

    // --- arp ---
    if (st.arp.on && !mute.arp) {
      var div = 16 / st.arp.rate; // 1 for 16ths, 2 for 8ths
      if (step % div === 0) {
        var tick = step / div;
        var tones = chordToneMidis(chord, 48 + st.key, st.arp.octaves);
        var n = tones.length, idx;
        if (st.arp.mode === 'up') idx = tick % n;
        else if (st.arp.mode === 'down') idx = n - 1 - (tick % n);
        else if (st.arp.mode === 'random') idx = Math.floor(ND.rand(tick * 7919 + st.seed) * n);
        else { // updown
          var period = Math.max(1, 2 * n - 2);
          var ph = tick % period;
          idx = ph < n ? ph : period - ph;
        }
        ND.arpNote(g, t, ND.mtof(tones[idx]), stepDur * div * 1.6,
          tick % 4 === 0 ? 1 : 0.8);
      }
    }

    // --- lead (consecutive identical cells tie into one held note) ---
    if (!mute.lead) {
      var notes = st.lead.notes;
      var row = notes[step];
      if (row >= 0 && (step === 0 || notes[step - 1] !== row)) {
        var len = 1;
        while (step + len < TOTAL && notes[step + len] === row) len++;
        ND.leadNote(g, t, ND.mtof(ND.leadMidi(row)), stepDur * len * 0.95, 1);
      }
    }

    // --- pads ---
    if (st.pads.on && !mute.pads && s === 0) {
      var base = 36 + st.key + chord.rootSemi;
      var freqs = [base - 12, base, base + chord.intervals[1], base + chord.intervals[2],
        base + 12 + chord.intervals[1]].map(ND.mtof);
      ND.padChord(g, t, freqs, stepDur * STEPS_PER_BAR);
    }
  };

  ND.applyLevels = function (g) {
    var st = ND.state;
    ['drums', 'bass', 'arp', 'lead', 'pads'].forEach(function (k) {
      g[k].gain.value = st.mutes[k] ? 0 : st.levels[k];
    });
    g.masterVol.gain.value = st.fx.master;
    g.delayReturn.gain.value = st.fx.delay * 1.1;
    g.verbReturn.gain.value = st.fx.reverb * 1.2;
  };

  ND.applyDelayTime = function (g) {
    var stepDur = 60 / ND.state.bpm / 4;
    g.delayL.delayTime.value = stepDur * 3; // dotted 8th
    g.delayR.delayTime.value = stepDur * 3;
  };

  // ---------- live transport ----------

  var LOOKAHEAD = 0.18, TICK_MS = 30, MAX_LAG = 0.1;

  ND.engine = {
    ctx: null,
    graph: null,
    playing: false,
    step: 0,
    nextTime: 0,
    timer: null,
    displayQueue: [], // {step, time} pairs so the UI playhead is sample-accurate

    ensure: function () {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.graph = ND.buildGraph(this.ctx, true);
      }
      return this.ctx;
    },

    play: function () {
      var self = this;
      this.ensure();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.playing) return;
      this.playing = true;
      ND.applyLevels(this.graph);
      ND.applyDelayTime(this.graph);
      this.graph.cut.gain.cancelScheduledValues(this.ctx.currentTime);
      this.graph.cut.gain.setValueAtTime(1, this.ctx.currentTime);
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.08;
      this.displayQueue = [];
      this.timer = setInterval(function () { self.tick(); }, TICK_MS);
      this.tick();
    },

    tick: function () {
      var stepDur = 60 / ND.state.bpm / 4;
      // If the timer was starved (hidden tab, busy main thread) we may be far
      // behind the audio clock. Skip the missed steps, keeping the beat grid,
      // instead of firing them all at once as a noise burst.
      while (this.nextTime < this.ctx.currentTime - MAX_LAG) {
        this.step = (this.step + 1) % TOTAL;
        this.nextTime += stepDur;
      }
      while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
        ND.scheduleStep(this.graph, this.step, this.nextTime, stepDur);
        this.displayQueue.push({ step: this.step, time: this.nextTime });
        this.step = (this.step + 1) % TOTAL;
        this.nextTime += stepDur;
      }
    },

    stop: function () {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timer);
      var now = this.ctx.currentTime;
      this.graph.cut.gain.setTargetAtTime(0, now, 0.015);
      var g = this.graph;
      setTimeout(function () {
        g.sources.forEach(function (s) {
          try { s.stop(); } catch (e) { /* already stopped */ }
        });
        g.sources.clear();
      }, 120);
      this.displayQueue = [];
    },

    // current step for the UI playhead, or -1 when stopped
    currentStep: function () {
      if (!this.playing || !this.ctx) return -1;
      var now = this.ctx.currentTime;
      var q = this.displayQueue, cur = -1;
      while (q.length && q[0].time <= now) cur = q.shift().step;
      if (cur >= 0) this.lastShown = cur;
      return this.lastShown !== undefined ? this.lastShown : -1;
    },
  };

  // ---------- song generator ----------

  ND.generateMelody = function (rng) {
    var notes = emptyLead();
    var degs = ND.PROGRESSIONS[ND.state.progression].degs;

    // rhythm templates: [startStep, lengthInSteps] within a bar
    var rhythms = [
      [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 4]],
      [[0, 4], [4, 2], [6, 2], [8, 2], [10, 2], [12, 4]],
      [[0, 3], [3, 3], [6, 2], [8, 4], [12, 2]],
      [[0, 2], [4, 2], [6, 2], [8, 2], [12, 4]],
      [[0, 4], [6, 2], [8, 4], [14, 2]],
      [[2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
    ];

    function chordRows(bar) {
      // rows of the melody grid that are tones of this bar's chord
      var deg = degs[bar], rows = [];
      for (var r = 0; r < ND.LEAD_ROWS; r++) {
        var rel = (r % 7 - deg + 7) % 7;
        if (rel === 0 || rel === 2 || rel === 4) rows.push(r);
      }
      return rows;
    }

    var prev = 7;
    var barRhythms = [];
    var rIdx = Math.floor(rng() * rhythms.length);
    var rIdx2 = Math.floor(rng() * rhythms.length);
    barRhythms = [rhythms[rIdx], rhythms[rIdx2], rhythms[rIdx], rhythms[Math.floor(rng() * rhythms.length)]];

    var barNotes = [];
    for (var bar = 0; bar < 4; bar++) {
      var ctones = chordRows(bar);
      var picked = [];
      barRhythms[bar].forEach(function (rh, i) {
        var strong = rh[0] % 4 === 0;
        var target;
        if (strong && rng() < 0.7) {
          // nearest chord tone to the previous note
          target = ctones.reduce(function (best, r) {
            return Math.abs(r - prev) < Math.abs(best - prev) ? r : best;
          }, ctones[0]);
          if (rng() < 0.35) target = ctones[Math.floor(rng() * ctones.length)];
        } else {
          var stepMove = [-2, -1, -1, 1, 1, 2][Math.floor(rng() * 6)];
          target = prev + stepMove;
        }
        target = Math.max(2, Math.min(ND.LEAD_ROWS - 1, target));
        if (bar === 3 && i === barRhythms[bar].length - 1) {
          // resolve the phrase on a chord tone
          target = ctones.reduce(function (best, r) {
            return Math.abs(r - prev) < Math.abs(best - prev) ? r : best;
          }, ctones[0]);
        }
        prev = target;
        picked.push([rh[0], rh[1], target]);
      });
      barNotes.push(picked);
    }

    // bar 2 often echoes bar 1 transposed to its chord
    if (rng() < 0.5) {
      var shift = ((degs[1] - degs[0]) % 3) - 1;
      barNotes[1] = barNotes[0].map(function (n) {
        var r = Math.max(2, Math.min(ND.LEAD_ROWS - 1, n[2] + shift));
        return [n[0], n[1], r];
      });
    }

    barNotes.forEach(function (bn, bar) {
      bn.forEach(function (n) {
        for (var k = 0; k < n[1]; k++) {
          var idx = bar * 16 + n[0] + k;
          if (idx < TOTAL) notes[idx] = n[2];
        }
      });
    });
    return notes;
  };

  ND.generateSong = function () {
    var st = ND.state;
    var seed = (Math.random() * 1e9) | 0;
    st.seed = seed;
    var i = 0;
    var rng = function () { return ND.rand(seed + (i++) * 131); };

    st.name = ND.NAME_A[Math.floor(rng() * ND.NAME_A.length)] + ' ' +
      ND.NAME_B[Math.floor(rng() * ND.NAME_B.length)];
    st.bpm = 84 + Math.floor(rng() * 15) * 2;
    st.key = Math.floor(rng() * 12);
    st.progression = Math.floor(rng() * ND.PROGRESSIONS.length);

    var dp = ND.DRUM_PATTERNS[Math.floor(rng() * ND.DRUM_PATTERNS.length)];
    st.drums.preset = ND.DRUM_PATTERNS.indexOf(dp);
    ND.DRUM_ROWS.forEach(function (r) { st.drums[r] = dp[r].slice(); });
    // sprinkle a few extra hats for variation
    for (var s = 0; s < 16; s++) {
      if (!st.drums.hat[s] && rng() < 0.12) st.drums.hat[s] = 1;
    }
    st.drums.fill = rng() < 0.8;

    st.bass.style = Math.floor(rng() * ND.BASS_STYLES.length);
    st.bass.cutoff = 0.35 + rng() * 0.45;
    st.arp.on = rng() < 0.85;
    st.arp.mode = ND.ARP_MODES[Math.floor(rng() * ND.ARP_MODES.length)];
    st.arp.rate = rng() < 0.7 ? 16 : 8;
    st.arp.octaves = 1 + Math.floor(rng() * 2) + (rng() < 0.2 ? 1 : 0);
    st.pads.on = rng() < 0.9;
    st.lead.notes = ND.generateMelody(rng);
    st.fx.pump = 0.35 + rng() * 0.45;
  };

  // ---------- WAV export ----------

  ND.exportWav = function (loops, onDone, onError) {
    try {
      var st = ND.state;
      var stepDur = 60 / st.bpm / 4;
      var loopDur = stepDur * TOTAL;
      var tail = 2.5;
      var sr = 44100;
      var totalDur = loopDur * loops + tail;
      var ctx = new OfflineAudioContext(2, Math.ceil(sr * totalDur), sr);
      var g = ND.buildGraph(ctx, false);
      ND.applyLevels(g);
      ND.applyDelayTime(g);

      var t0 = 0.05;
      for (var i = 0; i < loops * TOTAL; i++) {
        ND.scheduleStep(g, i % TOTAL, t0 + i * stepDur, stepDur);
      }

      ctx.startRendering().then(function (buf) {
        var blob = encodeWav(buf);
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = st.name.replace(/[^\w\- ]+/g, '').replace(/ +/g, '_').toLowerCase() + '.wav';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
        if (onDone) onDone();
      }).catch(function (e) { if (onError) onError(e); });
    } catch (e) {
      if (onError) onError(e);
    }
  };

  function encodeWav(buffer) {
    var numCh = 2, sr = buffer.sampleRate, len = buffer.length;
    var bytes = 44 + len * numCh * 2;
    var ab = new ArrayBuffer(bytes);
    var v = new DataView(ab);
    var pos = 0;

    function wstr(s) { for (var i = 0; i < s.length; i++) v.setUint8(pos++, s.charCodeAt(i)); }
    function w32(x) { v.setUint32(pos, x, true); pos += 4; }
    function w16(x) { v.setUint16(pos, x, true); pos += 2; }

    wstr('RIFF'); w32(bytes - 8); wstr('WAVE');
    wstr('fmt '); w32(16); w16(1); w16(numCh); w32(sr);
    w32(sr * numCh * 2); w16(numCh * 2); w16(16);
    wstr('data'); w32(len * numCh * 2);

    var L = buffer.getChannelData(0);
    var R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    for (var i = 0; i < len; i++) {
      var l = Math.max(-1, Math.min(1, L[i]));
      var r = Math.max(-1, Math.min(1, R[i]));
      v.setInt16(pos, l < 0 ? l * 0x8000 : l * 0x7fff, true); pos += 2;
      v.setInt16(pos, r < 0 ? r * 0x8000 : r * 0x7fff, true); pos += 2;
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ---------- save / load ----------

  ND.serialize = function () { return JSON.stringify(ND.state); };

  ND.loadState = function (obj) {
    var d = ND.defaultState();
    // shallow-merge with defaults so older saves stay loadable
    ['name', 'bpm', 'key', 'progression', 'seed'].forEach(function (k) {
      if (obj[k] !== undefined) d[k] = obj[k];
    });
    ['drums', 'bass', 'arp', 'lead', 'pads', 'levels', 'mutes', 'fx'].forEach(function (k) {
      if (obj[k]) Object.keys(d[k]).forEach(function (kk) {
        if (obj[k][kk] !== undefined) d[k][kk] = obj[k][kk];
      });
    });
    ND.state = d;
  };
})(window.ND);
