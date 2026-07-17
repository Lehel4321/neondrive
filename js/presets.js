/* NEON DRIVE — musical data: scales, chord progressions, drum & bass patterns */
window.ND = window.ND || {};

(function (ND) {
  'use strict';

  // Natural minor — the synthwave scale. Everything is locked to it so no note can sound wrong.
  ND.MINOR = [0, 2, 3, 5, 7, 8, 10];
  ND.KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Chord quality per minor-scale degree: i ii° III iv v VI VII
  ND.QUALITY = ['m', 'dim', '', 'm', 'm', '', ''];

  // 4 chords, one per bar (degrees of the minor scale)
  ND.PROGRESSIONS = [
    { name: 'Midnight Run',   degs: [0, 5, 2, 6] }, // i  VI III VII
    { name: 'Outrun Classic', degs: [0, 6, 5, 6] }, // i  VII VI VII
    { name: 'Sunset Chase',   degs: [0, 3, 5, 4] }, // i  iv  VI v
    { name: 'Neon Skyline',   degs: [5, 6, 0, 0] }, // VI VII i  i
    { name: 'Night Drive',    degs: [0, 2, 6, 5] }, // i  III VII VI
    { name: 'Laser Grid',     degs: [0, 5, 6, 4] }, // i  VI  VII v
    { name: 'Chrome Heart',   degs: [3, 5, 0, 6] }, // iv VI  i  VII
    { name: 'Final Lap',      degs: [0, 4, 5, 2] }, // i  v   VI III
  ];

  function row(steps) {
    var r = new Array(16).fill(0);
    steps.forEach(function (s) { r[s] = 1; });
    return r;
  }

  ND.DRUM_ROWS = ['kick', 'snare', 'clap', 'hat', 'openhat'];
  ND.DRUM_LABELS = { kick: 'KICK', snare: 'SNARE', clap: 'CLAP', hat: 'HAT', openhat: 'OPEN' };

  ND.DRUM_PATTERNS = [
    {
      name: 'Classic Drive',
      kick: row([0, 4, 8, 12]),
      snare: row([4, 12]),
      clap: row([]),
      hat: row([0, 2, 4, 6, 8, 10, 12, 14]),
      openhat: row([14]),
    },
    {
      name: 'Boulevard 16ths',
      kick: row([0, 4, 8, 12]),
      snare: row([4, 12]),
      clap: row([4, 12]),
      hat: row([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      openhat: row([]),
    },
    {
      name: 'Electro Cruise',
      kick: row([0, 7, 8, 10]),
      snare: row([4, 12]),
      clap: row([12]),
      hat: row([2, 6, 10, 14]),
      openhat: row([]),
    },
    {
      name: 'Halftime Haze',
      kick: row([0, 10]),
      snare: row([8]),
      clap: row([8]),
      hat: row([0, 2, 4, 6, 8, 10, 12, 14]),
      openhat: row([6]),
    },
    {
      name: 'Turbo Break',
      kick: row([0, 3, 6, 10]),
      snare: row([4, 12, 15]),
      clap: row([4, 12]),
      hat: row([0, 2, 4, 5, 8, 10, 12, 13]),
      openhat: row([]),
    },
    {
      name: 'Tom Cruise Control',
      kick: row([0, 8]),
      snare: row([4, 12]),
      clap: row([]),
      hat: row([0, 3, 4, 7, 8, 11, 12, 15]),
      openhat: row([2, 10]),
    },
  ];

  // Bass styles: for a step 0..15 within the bar, return {semi, len(steps), vel} or null.
  ND.BASS_STYLES = [
    {
      name: 'Octave Bounce',
      note: function (s) {
        if (s % 2 !== 0) return null;
        return { semi: (s % 4 === 2) ? 12 : 0, len: 1.7, vel: (s % 4 === 0) ? 1 : 0.8 };
      },
    },
    {
      name: 'Straight 8ths',
      note: function (s) {
        if (s % 2 !== 0) return null;
        return { semi: 0, len: 1.7, vel: (s % 4 === 0) ? 1 : 0.75 };
      },
    },
    {
      name: 'Driving 16ths',
      note: function (s) {
        return { semi: 0, len: 0.85, vel: (s % 4 === 0) ? 1 : 0.62 };
      },
    },
    {
      name: 'Syncopated',
      note: function (s) {
        var hits = { 0: 0, 3: 0, 6: 12, 8: 0, 11: 0, 14: 12 };
        if (!(s in hits)) return null;
        return { semi: hits[s], len: 1.4, vel: s === 0 ? 1 : 0.8 };
      },
    },
    {
      name: 'Slow Pulse',
      note: function (s) {
        if (s !== 0 && s !== 8) return null;
        return { semi: 0, len: 7.5, vel: 1 };
      },
    },
  ];

  ND.ARP_MODES = ['up', 'down', 'updown', 'random'];

  // Random song-name generator, for flavor + filenames
  ND.NAME_A = ['Neon', 'Midnight', 'Chrome', 'Turbo', 'Laser', 'Electric', 'Crimson', 'Digital',
    'Phantom', 'Retro', 'Vapor', 'Starlight', 'Magenta', 'Infinite', 'Analog', 'Twilight'];
  ND.NAME_B = ['Drive', 'Runner', 'Horizon', 'Pursuit', 'Nights', 'Heartbeat', 'Skyline', 'Mirage',
    'Velocity', 'Boulevard', 'Sunset', 'Circuit', 'Dreams', 'Interceptor', 'Grid', 'Escape'];

  // Deterministic pseudo-random (so live playback and WAV export sound identical)
  ND.rand = function (seed) {
    var x = (seed | 0) + 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    x = x ^ (x >>> 15);
    return (x >>> 0) / 4294967296;
  };

  ND.noteName = function (midi) {
    return ND.KEYS[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  };

  ND.mtof = function (midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  };
})(window.ND);
