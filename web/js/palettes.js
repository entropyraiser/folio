/* Color modes and palettes. Contrast is checked by tools/contrast.js. */
(function (G) {
'use strict';
const BASE = {
  light: {
    '--canvas':'#f5f5f6','--bg':'#ffffff','--surface':'#f4f4f5','--line':'#e7e7ea',
    '--text':'#111111','--muted':'#5c5c5c','--gain':'#157a45','--loss':'#c4362c','--warn':'#8a5200','--edge':'#8a8a8a'
  },
  dark: {
    '--canvas':'#08080a','--bg':'#111113','--surface':'#1a1a1d','--line':'#27272b',
    '--text':'#f5f5f5','--muted':'#9a9a9a','--gain':'#5dca8a','--loss':'#f07167','--warn':'#f0b45a','--edge':'#7a7a7a'
  }
};
const PALETTES = {
  light: {
    navy: {
      label: 'Navy',
      '--accent':'#1b3a4b','--accent-ink':'#ffffff','--focus':'#1b3a4b',
      '--c-us':'#1b3a4b','--c-in':'#a3884b','--c-bcash':'#3e6b8a','--c-bank':'#2f5d50','--c-pf':'#8c6b4a','--c-other':'#5c6b7a',
      '--s1':'#1b3a4b','--s2':'#a3884b','--s3':'#3e6b8a','--s4':'#2f5d50','--s5':'#8c6b4a','--s6':'#5c6b7a','--s7':'#244e66','--s8':'#7a5c8a'
    },
    harbor: {
      label: 'Harbor',
      '--accent':'#0f5c56','--accent-ink':'#ffffff','--focus':'#0f5c56',
      '--c-us':'#0f5c56','--c-in':'#c47b4a','--c-bcash':'#3d7a78','--c-bank':'#1a3c40','--c-pf':'#778f8b','--c-other':'#5e4a38',
      '--s1':'#0f5c56','--s2':'#c47b4a','--s3':'#3d7a78','--s4':'#1a3c40','--s5':'#778f8b','--s6':'#5e4a38','--s7':'#1f6f68','--s8':'#a36a3c'
    },
    indigo: {
      label: 'Indigo',
      '--accent':'#2f3f73','--accent-ink':'#ffffff','--focus':'#2f3f73',
      '--c-us':'#2f3f73','--c-in':'#7a6a4f','--c-bcash':'#5b6eae','--c-bank':'#1e2a4a','--c-pf':'#4e7c8a','--c-other':'#6b5b7a',
      '--s1':'#2f3f73','--s2':'#7a6a4f','--s3':'#5b6eae','--s4':'#1e2a4a','--s5':'#4e7c8a','--s6':'#6b5b7a','--s7':'#3d4f8a','--s8':'#8a7a5c'
    },
    plum: {
      label: 'Plum',
      '--accent':'#5b2a4e','--accent-ink':'#ffffff','--focus':'#5b2a4e',
      '--c-us':'#5b2a4e','--c-in':'#a7864b','--c-bcash':'#8a5a7e','--c-bank':'#3a2438','--c-pf':'#b07a8c','--c-other':'#6e6a7a',
      '--s1':'#5b2a4e','--s2':'#a7864b','--s3':'#8a5a7e','--s4':'#3a2438','--s5':'#b07a8c','--s6':'#6e6a7a','--s7':'#7a3d68','--s8':'#9c8866'
    },
    clay: {
      label: 'Clay',
      '--accent':'#9a4a2e','--accent-ink':'#ffffff','--focus':'#9a4a2e',
      '--c-us':'#9a4a2e','--c-in':'#ab845d','--c-bcash':'#5a6e7a','--c-bank':'#4a2e22','--c-pf':'#b28267','--c-other':'#7a7266',
      '--s1':'#9a4a2e','--s2':'#ab845d','--s3':'#5a6e7a','--s4':'#4a2e22','--s5':'#b28267','--s6':'#7a7266','--s7':'#b5623f','--s8':'#7e8d98'
    },
    forest: {
      label: 'Forest',
      '--accent':'#2d4a3a','--accent-ink':'#ffffff','--focus':'#2d4a3a',
      '--c-us':'#2d4a3a','--c-in':'#ab8648','--c-bcash':'#5a7d6a','--c-bank':'#1f3328','--c-pf':'#829164','--c-other':'#6b6558',
      '--s1':'#2d4a3a','--s2':'#ab8648','--s3':'#5a7d6a','--s4':'#1f3328','--s5':'#829164','--s6':'#6b6558','--s7':'#4a6b58','--s8':'#a28856'
    }
  },
  dark: {
    brass: {
      label: 'Brass',
      '--accent':'#e0a84a','--accent-ink':'#1a1408','--focus':'#e0a84a',
      '--c-us':'#e0a84a','--c-in':'#f0d59a','--c-bcash':'#7ba3d4','--c-bank':'#c48a3a','--c-pf':'#a8b8d0','--c-other':'#d4b483',
      '--s1':'#e0a84a','--s2':'#7ba3d4','--s3':'#f0d59a','--s4':'#c48a3a','--s5':'#a8b8d0','--s6':'#d4b483','--s7':'#4a6fa5','--s8':'#f2e2bc'
    },
    steel: {
      label: 'Steel',
      '--accent':'#8eb4e0','--accent-ink':'#0c1218','--focus':'#8eb4e0',
      '--c-us':'#8eb4e0','--c-in':'#d4c4a8','--c-bcash':'#5c8fb8','--c-bank':'#c5d4e4','--c-pf':'#6a8ca8','--c-other':'#a9c0d4',
      '--s1':'#8eb4e0','--s2':'#d4c4a8','--s3':'#5c8fb8','--s4':'#c5d4e4','--s5':'#6a8ca8','--s6':'#a9c0d4','--s7':'#3d6f99','--s8':'#e4d8c8'
    },
    sage: {
      label: 'Sage',
      '--accent':'#8fbf9a','--accent-ink':'#0e1612','--focus':'#8fbf9a',
      '--c-us':'#8fbf9a','--c-in':'#c4b48a','--c-bcash':'#6e9a88','--c-bank':'#d4cdb8','--c-pf':'#5e8f6e','--c-other':'#a8c4b0',
      '--s1':'#8fbf9a','--s2':'#c4b48a','--s3':'#6e9a88','--s4':'#d4cdb8','--s5':'#5e8f6e','--s6':'#a8c4b0','--s7':'#4a745c','--s8':'#e2d3b0'
    },
    rose: {
      label: 'Rose',
      '--accent':'#e8a0b4','--accent-ink':'#1a0e12','--focus':'#e8a0b4',
      '--c-us':'#e8a0b4','--c-in':'#f2d0a0','--c-bcash':'#b48ac8','--c-bank':'#d47a8e','--c-pf':'#c8b4d8','--c-other':'#e0c4c0',
      '--s1':'#e8a0b4','--s2':'#b48ac8','--s3':'#f2d0a0','--s4':'#d47a8e','--s5':'#c8b4d8','--s6':'#e0c4c0','--s7':'#8a5a9e','--s8':'#f4e0d0'
    },
    ember: {
      label: 'Ember',
      '--accent':'#e88a5a','--accent-ink':'#1a0e08','--focus':'#e88a5a',
      '--c-us':'#e88a5a','--c-in':'#f2c88a','--c-bcash':'#7ab4c4','--c-bank':'#c46a44','--c-pf':'#a8ccd4','--c-other':'#d8b49a',
      '--s1':'#e88a5a','--s2':'#7ab4c4','--s3':'#f2c88a','--s4':'#c46a44','--s5':'#a8ccd4','--s6':'#d8b49a','--s7':'#3f8a9a','--s8':'#f4dcc4'
    },
    iris: {
      label: 'Iris',
      '--accent':'#a8a4f0','--accent-ink':'#0e0e1a','--focus':'#a8a4f0',
      '--c-us':'#a8a4f0','--c-in':'#e4c48a','--c-bcash':'#7a9ae0','--c-bank':'#c8c4f4','--c-pf':'#8a7ac8','--c-other':'#b4c0d8',
      '--s1':'#a8a4f0','--s2':'#e4c48a','--s3':'#7a9ae0','--s4':'#c8c4f4','--s5':'#8a7ac8','--s6':'#b4c0d8','--s7':'#645eb4','--s8':'#f0e0c0'
    }
  }
};
G.Folio = Object.assign(G.Folio || {}, { BASE, PALETTES });
if (typeof module !== 'undefined') module.exports = G.Folio;
})(typeof window !== 'undefined' ? window : globalThis);
