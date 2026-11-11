/*
 * FigPalette - palette registry + color utilities (frozen API v1.0).
 * See shared/lib/API.md for the authoritative contract.
 * No dependencies, no module system. Attaches to globalThis so it works
 * both under Node and in the browser via <script src="lib/palette.js">.
 */
(function (global) {
  'use strict';

  var _palettes = []; // registry in load order
  var _byId = {};     // id -> palette entry

  function fail(message) {
    throw new Error('FigPalette: ' + message);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Parse "#rgb" / "#rrggbb" (case-insensitive, surrounding spaces allowed).
  // Returns {r,g,b} with integers 0-255, or null when the string is not a
  // supported hex color (callers decide whether to throw).
  function parseHex(hex) {
    if (typeof hex !== 'string') {
      return null;
    }
    var s = hex.trim();
    var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
    if (!m) {
      return null;
    }
    var body = m[1];
    if (body.length === 3) {
      return {
        r: parseInt(body.charAt(0) + body.charAt(0), 16),
        g: parseInt(body.charAt(1) + body.charAt(1), 16),
        b: parseInt(body.charAt(2) + body.charAt(2), 16)
      };
    }
    return {
      r: parseInt(body.substring(0, 2), 16),
      g: parseInt(body.substring(2, 4), 16),
      b: parseInt(body.substring(4, 6), 16)
    };
  }

  function hexToRgb(hex) {
    var rgb = parseHex(hex);
    if (!rgb) {
      fail('hexToRgb: 非法颜色值 ' + JSON.stringify(hex) + '，应为 #rgb 或 #rrggbb 格式');
    }
    return rgb;
  }

  function rgbToHex(rgb) {
    if (!isPlainObject(rgb)) {
      fail('rgbToHex: 参数必须是 {r,g,b} 对象');
    }
    var parts = ['r', 'g', 'b'];
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i];
      var v = rgb[key];
      if (typeof v !== 'number' || !isFinite(v)) {
        fail('rgbToHex: ' + key + ' 必须是有限数字，收到 ' + JSON.stringify(v));
      }
      var rounded = Math.round(v);
      if (rounded < 0 || rounded > 255) {
        fail('rgbToHex: ' + key + ' 超出 0-255 范围，收到 ' + v);
      }
      rgb[key] = rounded;
    }
    return ('#' + toHexByte(rgb.r) + toHexByte(rgb.g) + toHexByte(rgb.b)).toUpperCase();
  }

  function toHexByte(v) {
    var h = v.toString(16);
    return h.length === 1 ? '0' + h : h;
  }

  // HSV hue in degrees, 0-360 (exclusive of 360). Achromatic colors have no
  // hue; by convention they yield 0.
  function hue(hex) {
    var rgb = hexToRgb(hex);
    var r = rgb.r / 255;
    var g = rgb.g / 255;
    var b = rgb.b / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var delta = max - min;
    if (delta === 0) {
      return 0;
    }
    var h;
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
    h = ((h % 360) + 360) % 360;
    return h === 360 ? 0 : h;
  }

  // WCAG 2.x relative luminance (0-1) of a hex color.
  function luminance(hex) {
    var rgb = hexToRgb(hex);
    return channelLuminance(rgb.r) * 0.2126 +
      channelLuminance(rgb.g) * 0.7152 +
      channelLuminance(rgb.b) * 0.0722;
  }

  function channelLuminance(value8bit) {
    var c = value8bit / 255;
    if (c <= 0.03928) {
      return c / 12.92;
    }
    return Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // Pick black or white as the readable text color on the given background,
  // maximizing the WCAG contrast ratio.
  function contrastText(hex) {
    var l = luminance(hex);
    var ratioOnWhite = 1.05 / (l + 0.05);
    var ratioOnBlack = (l + 0.05) / 0.05;
    return ratioOnWhite >= ratioOnBlack ? '#FFFFFF' : '#000000';
  }

  // Stable sort by hue. Neutrals (hue 0) sort first; the input array is not
  // mutated. Order among equal hues follows the input order.
  function sortByHue(colors) {
    if (!Array.isArray(colors)) {
      fail('sortByHue: 参数必须是颜色数组');
    }
    var items = [];
    for (var i = 0; i < colors.length; i++) {
      items.push({ index: i, color: colors[i], h: hue(colors[i]) });
    }
    items.sort(function (a, b) {
      return (a.h - b.h) || (a.index - b.index);
    });
    var out = [];
    for (var j = 0; j < items.length; j++) {
      out.push(items[j].color);
    }
    return out;
  }

  // Nearest palette color by Euclidean distance in RGB space. Ties keep the
  // color that appears first in the palette.
  function nearest(paletteId, hex) {
    var colors = colorsOf(paletteId);
    var target = hexToRgb(hex);
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < colors.length; i++) {
      var c = hexToRgb(colors[i]);
      var dr = c.r - target.r;
      var dg = c.g - target.g;
      var db = c.b - target.b;
      var dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = colors[i];
      }
    }
    return best;
  }

  // Neutral = white / black / any pure gray (r === g === b) / "none" /
  // null / undefined. Used to skip colors during recolor.
  function isNeutral(hex) {
    if (hex === null || hex === undefined) {
      return true;
    }
    if (typeof hex !== 'string') {
      fail('isNeutral: 非法颜色值 ' + JSON.stringify(hex));
    }
    var s = hex.trim().toLowerCase();
    if (s === 'none') {
      return true;
    }
    var rgb = parseHex(s);
    if (!rgb) {
      fail('isNeutral: 非法颜色值 ' + JSON.stringify(hex) + '，应为 #rgb / #rrggbb / none / null');
    }
    return rgb.r === rgb.g && rgb.g === rgb.b;
  }

  function requireStringId(id, what) {
    if (typeof id !== 'string' || id === '') {
      fail(what + ': 调色板 id 必须是非空字符串，收到 ' + JSON.stringify(id));
    }
  }

  function paletteById(id) {
    requireStringId(id, 'get');
    if (!Object.prototype.hasOwnProperty.call(_byId, id)) {
      return null;
    }
    return exportPalette(_byId[id]);
  }

  function colorsOf(paletteId) {
    requireStringId(paletteId, 'colors');
    if (!Object.prototype.hasOwnProperty.call(_byId, paletteId)) {
      fail('colors: 调色板不存在: ' + paletteId);
    }
    return _byId[paletteId].colors.slice();
  }

  // Shallow clone with fresh arrays so callers cannot mutate the registry.
  function exportPalette(p) {
    var copy = {};
    for (var key in p) {
      if (Object.prototype.hasOwnProperty.call(p, key)) {
        copy[key] = p[key];
      }
    }
    copy.colors = p.colors.slice();
    if (p.roles) {
      var roles = {};
      for (var r in p.roles) {
        if (Object.prototype.hasOwnProperty.call(p.roles, r)) {
          roles[r] = p.roles[r];
        }
      }
      copy.roles = roles;
    }
    return copy;
  }

  function clonePaletteEntry(entry, position) {
    if (!isPlainObject(entry)) {
      fail('load: 第 ' + position + ' 个调色板必须是对象');
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      fail('load: 第 ' + position + ' 个调色板缺少非空 id');
    }
    if (!Array.isArray(entry.colors) || entry.colors.length === 0) {
      fail('load: 调色板 ' + entry.id + ' 的 colors 必须是非空数组');
    }
    for (var i = 0; i < entry.colors.length; i++) {
      if (!parseHex(entry.colors[i])) {
        fail('load: 调色板 ' + entry.id + ' 第 ' + i + ' 个颜色非法: ' + JSON.stringify(entry.colors[i]));
      }
    }
    var roles = null;
    if (entry.roles !== undefined && entry.roles !== null) {
      if (!isPlainObject(entry.roles)) {
        fail('load: 调色板 ' + entry.id + ' 的 roles 必须是对象');
      }
      roles = {};
      for (var role in entry.roles) {
        if (Object.prototype.hasOwnProperty.call(entry.roles, role)) {
          if (!parseHex(entry.roles[role])) {
            fail('load: 调色板 ' + entry.id + ' 的角色 ' + role + ' 颜色非法: ' + JSON.stringify(entry.roles[role]));
          }
          roles[role] = entry.roles[role];
        }
      }
    }
    var copy = {};
    for (var key in entry) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) {
        copy[key] = entry[key];
      }
    }
    copy.colors = entry.colors.slice();
    if (roles) {
      copy.roles = roles;
    } else {
      delete copy.roles;
    }
    return copy;
  }

  // Load (replace) the palette registry from a parsed palettes.json object
  // or from a bare palette array.
  function load(palettesJson) {
    var entries;
    if (Array.isArray(palettesJson)) {
      entries = palettesJson;
    } else if (isPlainObject(palettesJson) && Array.isArray(palettesJson.palettes)) {
      entries = palettesJson.palettes;
    } else {
      fail('load: 参数必须是含 palettes 数组的 palettes.json 对象，或调色板数组');
    }
    var list = [];
    var byId = {};
    for (var i = 0; i < entries.length; i++) {
      var entry = clonePaletteEntry(entries[i], i);
      if (Object.prototype.hasOwnProperty.call(byId, entry.id)) {
        fail('load: 调色板 id 重复: ' + entry.id);
      }
      byId[entry.id] = entry;
      list.push(entry);
    }
    _palettes = list;
    _byId = byId;
  }

  function list(opts) {
    if (opts === undefined || opts === null) {
      opts = {};
    }
    if (!isPlainObject(opts)) {
      fail('list: 参数必须是 {category?} 对象');
    }
    var category = opts.category;
    if (category !== undefined && category !== null && typeof category !== 'string') {
      fail('list: category 必须是字符串');
    }
    var out = [];
    for (var i = 0; i < _palettes.length; i++) {
      if (category === undefined || category === null || _palettes[i].category === category) {
        out.push(exportPalette(_palettes[i]));
      }
    }
    return out;
  }

  function roleColor(id, role) {
    requireStringId(id, 'roleColor');
    if (typeof role !== 'string' || role === '') {
      fail('roleColor: role 必须是非空字符串，收到 ' + JSON.stringify(role));
    }
    if (!Object.prototype.hasOwnProperty.call(_byId, id)) {
      fail('roleColor: 调色板不存在: ' + id);
    }
    var roles = _byId[id].roles;
    if (roles && Object.prototype.hasOwnProperty.call(roles, role)) {
      return roles[role];
    }
    return null;
  }

  var FigPalette = {
    load: load,
    list: list,
    get: paletteById,
    colors: colorsOf,
    roleColor: roleColor,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    hue: hue,
    sortByHue: sortByHue,
    contrastText: contrastText,
    nearest: nearest,
    isNeutral: isNeutral,
    luminance: luminance
  };

  global.FigPalette = FigPalette;
})(typeof globalThis !== 'undefined' ? globalThis : this);
