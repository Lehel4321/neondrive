/* NEON DRIVE — UI: grids, controls, playhead, scope, persistence */
window.ND = window.ND || {};

(function (ND) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var els = {};
  var levelEls = {};    // track -> volume slider input
  var muteEls = {};     // track -> mute button
  var drumCells = {};   // rowName -> [cell...]
  var leadCells = [];   // [row][col]
  var chordChips = [];
  var painting = null;  // {kind, ...} while dragging across cells

  // ---------- small builders ----------

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function select(parent, options, value, onChange) {
    var s = el('select', 'nd-select', parent);
    options.forEach(function (o, i) {
      var op = el('option', null, s, o);
      op.value = i;
    });
    s.value = value;
    s.addEventListener('change', function () { onChange(parseInt(s.value, 10)); save(); });
    return s;
  }

  function slider(parent, label, min, max, step, value, onInput) {
    var wrap = el('label', 'nd-slider', parent);
    el('span', 'nd-slider-label', wrap, label);
    var r = el('input', null, wrap);
    r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
    r.addEventListener('input', function () { onInput(parseFloat(r.value)); save(); });
    return r;
  }

  function muteBtn(parent, key) {
    var b = el('button', 'nd-mute', parent, 'M');
    b.title = 'Mute';
    b.addEventListener('click', function () {
      ND.state.mutes[key] = !ND.state.mutes[key];
      b.classList.toggle('on', ND.state.mutes[key]);
      if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
      save();
    });
    b.classList.toggle('on', ND.state.mutes[key]);
    muteEls[key] = b;
    return b;
  }

  function levelSlider(parent, key) {
    var r = slider(parent, 'VOL', 0, 1, 0.01, ND.state.levels[key], function (v) {
      ND.state.levels[key] = v;
      if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
    });
    levelEls[key] = r;
    return r;
  }

  // ---------- persistence ----------

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem('neondrive-song', ND.serialize()); } catch (e) { /* private mode */ }
    }, 250);
  }

  function tryRestore() {
    try {
      if (location.hash.indexOf('#s=') === 0) {
        var json = decodeURIComponent(escape(atob(
          location.hash.slice(3).replace(/-/g, '+').replace(/_/g, '/'))));
        ND.loadState(JSON.parse(json));
        return;
      }
    } catch (e) { /* bad share link — fall through */ }
    try {
      var raw = localStorage.getItem('neondrive-song');
      if (raw) ND.loadState(JSON.parse(raw));
    } catch (e) { /* corrupt save — keep defaults */ }
  }

  function shareLink() {
    var b64 = btoa(unescape(encodeURIComponent(ND.serialize())))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    location.hash = 's=' + b64;
    var full = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(full).then(function () {
        flashStatus('Share link copied!');
      }, function () { window.prompt('Copy this link:', full); });
    } else {
      window.prompt('Copy this link:', full);
    }
  }

  function flashStatus(msg) {
    els.status.textContent = msg;
    els.status.classList.add('show');
    clearTimeout(flashStatus.t);
    flashStatus.t = setTimeout(function () { els.status.classList.remove('show'); }, 2200);
  }

  // ---------- header / transport ----------

  function buildTransport() {
    var bar = $('#transport');

    els.play = el('button', 'nd-btn nd-play', bar, '▶ PLAY');
    els.play.addEventListener('click', togglePlay);

    var gen = el('button', 'nd-btn nd-gen', bar, '🎲 GENERATE');
    gen.title = 'Generate a whole new song';
    gen.addEventListener('click', function () {
      var wasPlaying = ND.engine.playing;
      if (wasPlaying) ND.engine.stop();
      ND.generateSong();
      refreshAll();
      save();
      if (wasPlaying) ND.engine.play();
      updatePlayButton();
      flashStatus('New song: ' + ND.state.name);
    });

    els.export = el('button', 'nd-btn', bar, '⬇ WAV');
    els.export.title = 'Render and download as a .wav file';
    els.exportLoops = el('select', 'nd-select nd-loops', bar);
    [1, 2, 4, 8].forEach(function (n) {
      var op = el('option', null, els.exportLoops, n + ' loop' + (n > 1 ? 's' : ''));
      op.value = n;
    });
    els.exportLoops.value = 4;
    els.export.addEventListener('click', function () {
      els.export.disabled = true;
      els.export.textContent = '… RENDERING';
      ND.exportWav(parseInt(els.exportLoops.value, 10), function () {
        els.export.disabled = false;
        els.export.textContent = '⬇ WAV';
        flashStatus('WAV exported!');
      }, function (e) {
        els.export.disabled = false;
        els.export.textContent = '⬇ WAV';
        flashStatus('Export failed: ' + (e && e.message ? e.message : e));
      });
    });

    var saveBtn = el('button', 'nd-btn', bar, '💾 SAVE');
    saveBtn.title = 'Download song as JSON';
    saveBtn.addEventListener('click', function () {
      var blob = new Blob([ND.serialize()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ND.state.name.replace(/ +/g, '_').toLowerCase() + '.neondrive.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    var loadBtn = el('button', 'nd-btn', bar, '📂 LOAD');
    var fileInput = el('input', null, bar);
    fileInput.type = 'file'; fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    loadBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          ND.loadState(JSON.parse(r.result));
          refreshAll();
          save();
          flashStatus('Loaded: ' + ND.state.name);
        } catch (e) { flashStatus('Could not read that file'); }
      };
      r.readAsText(f);
      fileInput.value = '';
    });

    var share = el('button', 'nd-btn', bar, '🔗 SHARE');
    share.title = 'Copy a link that contains this song';
    share.addEventListener('click', shareLink);

    // tempo + key
    var right = el('div', 'nd-transport-right', bar);
    var bpmWrap = el('label', 'nd-bpm', right);
    el('span', 'nd-slider-label', bpmWrap, 'BPM');
    els.bpm = el('input', null, bpmWrap);
    els.bpm.type = 'range'; els.bpm.min = 70; els.bpm.max = 130; els.bpm.step = 1;
    els.bpmNum = el('span', 'nd-bpm-num', bpmWrap, '');
    els.bpm.addEventListener('input', function () {
      ND.state.bpm = parseInt(els.bpm.value, 10);
      els.bpmNum.textContent = ND.state.bpm;
      if (ND.engine.graph) ND.applyDelayTime(ND.engine.graph);
      save();
    });

    var keyWrap = el('label', 'nd-key', right);
    el('span', 'nd-slider-label', keyWrap, 'KEY');
    els.key = el('select', 'nd-select', keyWrap);
    ND.KEYS.forEach(function (k, i) {
      var op = el('option', null, els.key, k + ' minor');
      op.value = i;
    });
    els.key.addEventListener('change', function () {
      ND.state.key = parseInt(els.key.value, 10);
      refreshChords();
      refreshLeadLabels();
      save();
    });
  }

  function togglePlay() {
    if (ND.engine.playing) {
      ND.engine.stop();
    } else {
      ND.engine.play();
    }
    updatePlayButton();
  }

  function updatePlayButton() {
    els.play.textContent = ND.engine.playing ? '◼ STOP' : '▶ PLAY';
    els.play.classList.toggle('playing', ND.engine.playing);
    document.body.classList.toggle('is-playing', ND.engine.playing);
  }

  // ---------- chords ----------

  function buildChords() {
    var sec = $('#chords .nd-controls');
    els.prog = select(sec, ND.PROGRESSIONS.map(function (p) { return p.name; }),
      ND.state.progression, function (v) {
        ND.state.progression = v;
        refreshChords();
      });
    var chips = el('div', 'nd-chips', $('#chords'));
    for (var i = 0; i < 4; i++) chordChips.push(el('div', 'nd-chip', chips, ''));
  }

  function refreshChords() {
    for (var i = 0; i < 4; i++) {
      chordChips[i].textContent = ND.chordAt(i).name;
    }
  }

  // ---------- drum grid ----------

  document.addEventListener('pointerup', function () { painting = null; });

  function buildDrums() {
    var sec = $('#drums');
    var ctl = sec.querySelector('.nd-controls');

    els.drumPreset = select(ctl, ND.DRUM_PATTERNS.map(function (p) { return p.name; }),
      ND.state.drums.preset, function (v) {
        ND.state.drums.preset = v;
        var p = ND.DRUM_PATTERNS[v];
        ND.DRUM_ROWS.forEach(function (r) { ND.state.drums[r] = p[r].slice(); });
        refreshDrumGrid();
      });

    var fill = el('button', 'nd-toggle', ctl, 'FILL');
    fill.title = 'Automatic snare fill at the end of bar 4';
    fill.classList.toggle('on', ND.state.drums.fill);
    fill.addEventListener('click', function () {
      ND.state.drums.fill = !ND.state.drums.fill;
      fill.classList.toggle('on', ND.state.drums.fill);
      save();
    });
    els.drumFill = fill;

    levelSlider(ctl, 'drums');
    muteBtn(ctl, 'drums');

    var grid = el('div', 'nd-drumgrid', sec);
    ND.DRUM_ROWS.forEach(function (row) {
      el('div', 'nd-rowlabel nd-' + row, grid, ND.DRUM_LABELS[row]);
      drumCells[row] = [];
      for (var s = 0; s < 16; s++) {
        (function (row, s) {
          var c = el('button', 'nd-cell nd-' + row + (s % 4 === 0 ? ' beat' : ''), grid);
          c.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            var val = ND.state.drums[row][s] ? 0 : 1;
            painting = { kind: 'drum-' + row, value: val };
            ND.state.drums[row][s] = val;
            c.classList.toggle('on', !!val);
            save();
          });
          c.addEventListener('pointerenter', function () {
            if (painting && painting.kind === 'drum-' + row) {
              ND.state.drums[row][s] = painting.value;
              c.classList.toggle('on', !!painting.value);
              save();
            }
          });
          drumCells[row].push(c);
        })(row, s);
      }
    });
  }

  function refreshDrumGrid() {
    ND.DRUM_ROWS.forEach(function (row) {
      drumCells[row].forEach(function (c, s) {
        c.classList.toggle('on', !!ND.state.drums[row][s]);
      });
    });
  }

  // ---------- bass / arp / pads rows ----------

  function buildBass() {
    var ctl = $('#bass .nd-controls');
    els.bassStyle = select(ctl, ND.BASS_STYLES.map(function (b) { return b.name; }),
      ND.state.bass.style, function (v) { ND.state.bass.style = v; });
    var oct = el('label', 'nd-slider', ctl);
    el('span', 'nd-slider-label', oct, 'OCT');
    els.bassOct = el('select', 'nd-select', oct);
    [['-1', -1], ['0', 0], ['+1', 1]].forEach(function (o) {
      var op = el('option', null, els.bassOct, o[0]);
      op.value = o[1];
    });
    els.bassOct.value = ND.state.bass.octave;
    els.bassOct.addEventListener('change', function () {
      ND.state.bass.octave = parseInt(els.bassOct.value, 10);
      save();
    });
    els.bassCut = slider(ctl, 'CUTOFF', 0, 1, 0.01, ND.state.bass.cutoff, function (v) {
      ND.state.bass.cutoff = v;
    });
    levelSlider(ctl, 'bass');
    muteBtn(ctl, 'bass');
  }

  function buildArp() {
    var ctl = $('#arp .nd-controls');
    els.arpOn = el('button', 'nd-toggle', ctl, 'ON');
    els.arpOn.classList.toggle('on', ND.state.arp.on);
    els.arpOn.addEventListener('click', function () {
      ND.state.arp.on = !ND.state.arp.on;
      els.arpOn.classList.toggle('on', ND.state.arp.on);
      save();
    });
    els.arpMode = select(ctl, ND.ARP_MODES.map(function (m) { return m.toUpperCase(); }),
      ND.ARP_MODES.indexOf(ND.state.arp.mode), function (v) {
        ND.state.arp.mode = ND.ARP_MODES[v];
      });
    var rate = el('label', 'nd-slider', ctl);
    el('span', 'nd-slider-label', rate, 'RATE');
    els.arpRate = el('select', 'nd-select', rate);
    [['1/8', 8], ['1/16', 16]].forEach(function (o) {
      var op = el('option', null, els.arpRate, o[0]);
      op.value = o[1];
    });
    els.arpRate.value = ND.state.arp.rate;
    els.arpRate.addEventListener('change', function () {
      ND.state.arp.rate = parseInt(els.arpRate.value, 10);
      save();
    });
    var octs = el('label', 'nd-slider', ctl);
    el('span', 'nd-slider-label', octs, 'OCTAVES');
    els.arpOcts = el('select', 'nd-select', octs);
    [1, 2, 3].forEach(function (o) {
      var op = el('option', null, els.arpOcts, o);
      op.value = o;
    });
    els.arpOcts.value = ND.state.arp.octaves;
    els.arpOcts.addEventListener('change', function () {
      ND.state.arp.octaves = parseInt(els.arpOcts.value, 10);
      save();
    });
    levelSlider(ctl, 'arp');
    muteBtn(ctl, 'arp');
  }

  function buildPads() {
    var ctl = $('#pads .nd-controls');
    els.padsOn = el('button', 'nd-toggle', ctl, 'ON');
    els.padsOn.classList.toggle('on', ND.state.pads.on);
    els.padsOn.addEventListener('click', function () {
      ND.state.pads.on = !ND.state.pads.on;
      els.padsOn.classList.toggle('on', ND.state.pads.on);
      save();
    });
    levelSlider(ctl, 'pads');
    muteBtn(ctl, 'pads');
  }

  // ---------- lead grid ----------

  function buildLead() {
    var sec = $('#lead');
    var ctl = sec.querySelector('.nd-controls');

    var genMel = el('button', 'nd-btn nd-small', ctl, '🎲 MELODY');
    genMel.title = 'Generate a new melody (keeps everything else)';
    genMel.addEventListener('click', function () {
      var seed = (Math.random() * 1e9) | 0;
      var i = 0;
      var rng = function () { return ND.rand(seed + (i++) * 131); };
      ND.state.lead.notes = ND.generateMelody(rng);
      refreshLeadGrid();
      save();
    });

    var clear = el('button', 'nd-btn nd-small', ctl, '✕ CLEAR');
    clear.addEventListener('click', function () {
      ND.state.lead.notes = new Array(ND.TOTAL_STEPS).fill(-1);
      refreshLeadGrid();
      save();
    });

    levelSlider(ctl, 'lead');
    muteBtn(ctl, 'lead');

    var scroll = el('div', 'nd-leadscroll', sec);
    var grid = el('div', 'nd-leadgrid', scroll);
    els.leadLabels = [];
    for (var r = ND.LEAD_ROWS - 1; r >= 0; r--) {
      var lbl = el('div', 'nd-rowlabel nd-leadlabel', grid, '');
      lbl.dataset.row = r;
      els.leadLabels.push(lbl);
      leadCells[r] = [];
      for (var c = 0; c < ND.TOTAL_STEPS; c++) {
        (function (r, c) {
          var cell = el('button', 'nd-cell nd-leadcell' +
            (c % 16 === 0 ? ' barline' : c % 4 === 0 ? ' beat' : ''), grid);
          cell.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            var on = ND.state.lead.notes[c] === r;
            painting = { kind: 'lead', row: r, erase: on };
            ND.state.lead.notes[c] = on ? -1 : r;
            refreshLeadColumn(c);
            save();
          });
          cell.addEventListener('pointerenter', function () {
            if (painting && painting.kind === 'lead') {
              ND.state.lead.notes[c] = painting.erase ? -1 : painting.row;
              refreshLeadColumn(c);
              save();
            }
          });
          leadCells[r][c] = cell;
        })(r, c);
      }
    }
    refreshLeadLabels();
  }

  function refreshLeadLabels() {
    els.leadLabels.forEach(function (lbl) {
      lbl.textContent = ND.noteName(ND.leadMidi(parseInt(lbl.dataset.row, 10)));
    });
  }

  function refreshLeadColumn(c) {
    for (var r = 0; r < ND.LEAD_ROWS; r++) {
      leadCells[r][c].classList.toggle('on', ND.state.lead.notes[c] === r);
    }
  }

  function refreshLeadGrid() {
    for (var c = 0; c < ND.TOTAL_STEPS; c++) refreshLeadColumn(c);
  }

  // ---------- master fx ----------

  function buildMaster() {
    var ctl = $('#master .nd-controls');
    els.pump = slider(ctl, 'PUMP', 0, 1, 0.01, ND.state.fx.pump, function (v) {
      ND.state.fx.pump = v;
    });
    els.delay = slider(ctl, 'DELAY', 0, 1, 0.01, ND.state.fx.delay, function (v) {
      ND.state.fx.delay = v;
      if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
    });
    els.reverb = slider(ctl, 'REVERB', 0, 1, 0.01, ND.state.fx.reverb, function (v) {
      ND.state.fx.reverb = v;
      if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
    });
    els.masterVol = slider(ctl, 'MASTER', 0, 1, 0.01, ND.state.fx.master, function (v) {
      ND.state.fx.master = v;
      if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
    });
  }

  // ---------- playhead + scope ----------

  var lastStep = -1;

  function raf() {
    var step = ND.engine.currentStep();
    if (step !== lastStep) {
      var s16 = step >= 0 ? step % 16 : -1;
      var bar = step >= 0 ? Math.floor(step / 16) : -1;
      ND.DRUM_ROWS.forEach(function (row) {
        drumCells[row].forEach(function (c, i) {
          c.classList.toggle('ph', i === s16);
        });
      });
      for (var r = 0; r < ND.LEAD_ROWS; r++) {
        if (lastStep >= 0) leadCells[r][lastStep].classList.remove('ph');
        if (step >= 0) leadCells[r][step].classList.add('ph');
      }
      chordChips.forEach(function (chip, i) { chip.classList.toggle('active', i === bar); });
      lastStep = step;
    }
    drawScope();
    requestAnimationFrame(raf);
  }

  function drawScope() {
    var cv = els.scope, ctx2d = cv.getContext('2d');
    ctx2d.clearRect(0, 0, cv.width, cv.height);
    var an = ND.engine.graph && ND.engine.graph.analyser;
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = '#00f0ff';
    ctx2d.shadowColor = '#00f0ff';
    ctx2d.shadowBlur = 6;
    ctx2d.beginPath();
    if (an && ND.engine.playing) {
      var data = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(data);
      var stepX = cv.width / data.length;
      for (var i = 0; i < data.length; i++) {
        var y = (data[i] / 255) * cv.height;
        if (i === 0) ctx2d.moveTo(0, y); else ctx2d.lineTo(i * stepX, y);
      }
    } else {
      ctx2d.moveTo(0, cv.height / 2);
      ctx2d.lineTo(cv.width, cv.height / 2);
    }
    ctx2d.stroke();
  }

  // ---------- refresh everything from state ----------

  function refreshAll() {
    var st = ND.state;
    els.songName.textContent = st.name;
    els.bpm.value = st.bpm;
    els.bpmNum.textContent = st.bpm;
    els.key.value = st.key;
    els.prog.value = st.progression;
    refreshChords();
    els.drumPreset.value = st.drums.preset;
    refreshDrumGrid();
    els.drumFill.classList.toggle('on', st.drums.fill);
    els.bassStyle.value = st.bass.style;
    els.bassOct.value = st.bass.octave;
    els.bassCut.value = st.bass.cutoff;
    els.arpOn.classList.toggle('on', st.arp.on);
    els.arpMode.value = ND.ARP_MODES.indexOf(st.arp.mode);
    els.arpRate.value = st.arp.rate;
    els.arpOcts.value = st.arp.octaves;
    els.padsOn.classList.toggle('on', st.pads.on);
    refreshLeadGrid();
    refreshLeadLabels();
    els.pump.value = st.fx.pump;
    els.delay.value = st.fx.delay;
    els.reverb.value = st.fx.reverb;
    els.masterVol.value = st.fx.master;
    Object.keys(levelEls).forEach(function (k) { levelEls[k].value = st.levels[k]; });
    Object.keys(muteEls).forEach(function (k) {
      muteEls[k].classList.toggle('on', st.mutes[k]);
    });
    if (ND.engine.graph) ND.applyLevels(ND.engine.graph);
  }

  // ---------- boot ----------

  window.addEventListener('DOMContentLoaded', function () {
    tryRestore();

    els.songName = $('#songname');
    els.status = $('#status');
    els.scope = $('#scope');

    buildTransport();
    buildChords();
    buildDrums();
    buildBass();
    buildArp();
    buildLead();
    buildPads();
    buildMaster();
    refreshAll();

    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault();
        togglePlay();
      }
    });

    requestAnimationFrame(raf);
  });
})(window.ND);
