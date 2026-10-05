'use strict';
// xcolor-style color expressions -> [r,g,b] in 0..1

const BASE = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0],
  black: [0, 0, 0], white: [1, 1, 1], gray: [0.5, 0.5, 0.5], darkgray: [0.25, 0.25, 0.25], lightgray: [0.75, 0.75, 0.75],
  brown: [0.75, 0.5, 0.25], lime: [0.75, 1, 0], olive: [0.5, 0.5, 0], orange: [1, 0.5, 0], pink: [1, 0.75, 0.75],
  purple: [0.75, 0, 0.25], teal: [0, 0.5, 0.5], violet: [0.5, 0, 0.5],
  // metropolis
  mDarkBrown: hex('604c38'), mDarkTeal: hex('23373b'), mLightBrown: hex('EB811B'), mLightGreen: hex('14B03D'),
};

// dvipsnames (subset of the most used ones)
const DVIPS = {
  Apricot: 'FBB982', Aquamarine: '00B5BE', Bittersweet: 'C04F17', Black: '221E1F', Blue: '2D2F92', BlueGreen: '00B3B8',
  BlueViolet: '473992', BrickRed: 'B6321C', Brown: '792500', BurntOrange: 'F7921D', CadetBlue: '74729A', CarnationPink: 'F282B4',
  Cerulean: '00A2E3', CornflowerBlue: '41B0E4', Cyan: '00AEEF', Dandelion: 'FDBC42', DarkOrchid: 'A4538A', Emerald: '00A99D',
  ForestGreen: '009B55', Fuchsia: '8C368C', Goldenrod: 'FFDF42', Gray: '949698', Green: '00A64F', GreenYellow: 'DFE674',
  JungleGreen: '00A99A', Lavender: 'F49EC4', LimeGreen: '8DC73E', Magenta: 'EC008C', Mahogany: 'A9341F', Maroon: 'AF3235',
  Melon: 'F89E7B', MidnightBlue: '006795', Mulberry: 'A93C93', NavyBlue: '006EB8', OliveGreen: '3C8031', Orange: 'F58137',
  OrangeRed: 'ED135A', Orchid: 'AF72B0', Peach: 'F7965A', Periwinkle: '7977B8', PineGreen: '008B72', Plum: '92268F',
  ProcessBlue: '00B0F0', Purple: '99479B', RawSienna: '974006', Red: 'ED1B23', RedOrange: 'F26035', RedViolet: 'A1246B',
  Rhodamine: 'EF559F', RoyalBlue: '0071BC', RoyalPurple: '613F99', RubineRed: 'ED017D', Salmon: 'F69289', SeaGreen: '3FBC9D',
  Sepia: '671800', SkyBlue: '46C5DD', SpringGreen: 'C6DC67', Tan: 'DA9D76', TealBlue: '00AEB3', Thistle: 'D883B7',
  Turquoise: '00B4CE', Violet: '58429B', VioletRed: 'EF58A0', White: 'FFFFFF', WildStrawberry: 'EE2967', Yellow: 'FFF200',
  YellowGreen: '98CC70', YellowOrange: 'FAA21A',
};
for (const k in DVIPS) BASE[k] = hex(DVIPS[k]);

function hex(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function toCss(c) {
  if (!c) return null;
  const f = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}

function mix(a, b, p) { return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)); }

class ColorTable {
  constructor() { this.user = Object.create(null); }

  define(name, model, spec) {
    const c = fromModel(model, spec);
    if (c) this.user[name] = c;
  }

  lookupName(name) {
    name = name.trim();
    if (this.user[name]) return this.user[name];
    if (BASE[name]) return BASE[name];
    // svgnames / x11 names are CSS names; resolve the common ones lazily via a tiny table
    const css = SVG[name.toLowerCase()];
    if (css) return hex(css);
    return null;
  }

  /** Parse an xcolor expression like "fei", "red!30", "red!30!blue", "-red", "fei!50!black!30" */
  parse(expr, specials) {
    if (!expr) return null;
    expr = expr.trim();
    let neg = false;
    if (expr.startsWith('-')) { neg = true; expr = expr.slice(1); }
    const parts = expr.split('!').map((s) => s.trim());
    const look = (n) => (specials && specials[n]) || this.lookupName(n);
    let cur = look(parts[0]);
    if (!cur) return null;
    let k = 1;
    while (k < parts.length) {
      const p = parseFloat(parts[k]) / 100;
      if (isNaN(p)) break;
      const other = k + 1 < parts.length ? look(parts[k + 1]) : [1, 1, 1];
      cur = mix(cur, other || [1, 1, 1], p);
      k += 2;
    }
    if (neg) cur = cur.map((x) => 1 - x);
    return cur;
  }

  css(expr, specials) { return toCss(this.parse(expr, specials)); }
}

function fromModel(model, spec) {
  model = (model || '').trim();
  const nums = spec.split(/[,\s]+/).filter(Boolean).map(Number);
  switch (model) {
    case 'rgb': return nums.slice(0, 3);
    case 'RGB': return nums.slice(0, 3).map((x) => x / 255);
    case 'HTML': return hex(spec.trim());
    case 'gray': return [nums[0], nums[0], nums[0]];
    case 'cmyk': { const [c, m, y, kk] = nums; return [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)]; }
    case 'cmy': { const [c, m, y] = nums; return [1 - c, 1 - m, 1 - y]; }
    default: return null;
  }
}

// A compact subset of SVG/x11 color names (svgnames option). Lowercase keys.
const SVG = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
  bisque: 'ffe4c4', blanchedalmond: 'ffebcd', blueviolet: '8a2be2', burlywood: 'deb887', cadetblue: '5f9ea0',
  chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgreen: '006400', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
  darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkturquoise: '00ced1',
  darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dodgerblue: '1e90ff',
  firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', greenyellow: 'adff2f', honeydew: 'f0fff0', hotpink: 'ff69b4',
  indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
  lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff',
  lightgoldenrod: 'eedd82', lightgreen: '90ee90', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa',
  lightskyblue: '87cefa', lightslategray: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', limegreen: '32cd32',
  linen: 'faf0e6', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
  mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', navyblue: '000080', oldlace: 'fdf5e6', olivedrab: '6b8e23',
  orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', plum: 'dda0dd', powderblue: 'b0e0e6',
  rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
  seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
  slategray: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', thistle: 'd8bfd8',
  tomato: 'ff6347', turquoise: '40e0d0', wheat: 'f5deb3', whitesmoke: 'f5f5f5', yellowgreen: '9acd32',
};

module.exports = { ColorTable, toCss, mix, hex };
