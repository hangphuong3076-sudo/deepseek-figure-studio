/*
 * tiff.js — FigTiff
 *
 * Dependency-free baseline TIFF encoder (Little-Endian, uncompressed, 8-bit RGB,
 * single strip or multi-strip) plus a minimal decoder that can parse the files
 * produced by this encoder (used for self-testing and round-trip validation).
 *
 * Loaded after render.js in all three version bundles. No DOM required.
 */
(function () {
  'use strict';

  var globalScope = typeof globalThis !== 'undefined' ? globalThis : this;

  // --- TIFF constants ------------------------------------------------------

  var TIFF_MAGIC = 42;          // classic TIFF version
  var HEADER_SIZE = 8;          // "II" + magic + IFD offset
  var IFD_ENTRY_SIZE = 12;      // tag + type + count + value/offset

  var TYPE_BYTE = 1;
  var TYPE_SHORT = 3;
  var TYPE_LONG = 4;
  var TYPE_RATIONAL = 5;

  var TYPE_SIZES = {};
  TYPE_SIZES[TYPE_BYTE] = 1;
  TYPE_SIZES[TYPE_SHORT] = 2;
  TYPE_SIZES[TYPE_LONG] = 4;
  TYPE_SIZES[TYPE_RATIONAL] = 8;

  // Tags written by encodeRGBA (all mandatory, in ascending tag order).
  var TAG_IMAGE_WIDTH = 256;
  var TAG_IMAGE_LENGTH = 257;
  var TAG_BITS_PER_SAMPLE = 258;
  var TAG_COMPRESSION = 259;
  var TAG_PHOTOMETRIC = 262;
  var TAG_STRIP_OFFSETS = 273;
  var TAG_ORIENTATION = 274;
  var TAG_SAMPLES_PER_PIXEL = 277;
  var TAG_ROWS_PER_STRIP = 278;
  var TAG_STRIP_BYTE_COUNTS = 279;
  var TAG_X_RESOLUTION = 282;
  var TAG_Y_RESOLUTION = 283;
  var TAG_PLANAR_CONFIGURATION = 284;
  var TAG_RESOLUTION_UNIT = 296;

  var COMPRESSION_NONE = 1;
  var PHOTOMETRIC_RGB = 2;
  var ORIENTATION_TOP_LEFT = 1;
  var PLANAR_CHUNKY = 1;
  var RESOLUTION_UNIT_INCH = 2;

  // --- input validation helpers -------------------------------------------

  function isTypedBytes(value) {
    return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
  }

  function assertPositiveInteger(value, name) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value <= 0) {
      throw new Error(name + ' 必须为正整数');
    }
  }

  function assertPositiveNumber(value, name) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      throw new Error(name + ' 必须为正数');
    }
  }

  // --- encoding ------------------------------------------------------------

  /**
   * Encode RGBA pixel data as an uncompressed baseline TIFF (Little-Endian,
   * RGB8). The alpha channel is dropped without compositing (the caller is
   * expected to flatten transparency onto a white background first).
   */
  function encodeRGBA(rgba, width, height, opts) {
    if (!isTypedBytes(rgba)) {
      throw new Error('rgba 必须是 Uint8Array 或 Uint8ClampedArray');
    }
    assertPositiveInteger(width, 'width');
    assertPositiveInteger(height, 'height');
    if (rgba.length !== width * height * 4) {
      throw new Error('rgba 长度必须等于 width*height*4，实际为 ' + rgba.length +
        '，期望 ' + (width * height * 4));
    }

    var options = opts || {};
    var dpi = options.dpi === undefined || options.dpi === null ? 300 : options.dpi;
    assertPositiveNumber(dpi, 'dpi');
    var resNumerator = Math.round(dpi * 100);           // RATIONAL numerator
    if (resNumerator <= 0 || resNumerator > 0xFFFFFFFF) {
      throw new Error('dpi 超出可表示范围');
    }

    var multiStrip = options.multiStrip === undefined ? true : !!options.multiStrip;
    var stripHeight = options.stripHeight === undefined || options.stripHeight === null
      ? 64 : options.stripHeight;
    assertPositiveInteger(stripHeight, 'stripHeight');
    var rowsPerStrip = multiStrip ? stripHeight : height; // single strip when multiStrip=false

    var stripCount = Math.ceil(height / rowsPerStrip);
    var stripRows = new Array(stripCount);
    var stripByteCounts = new Array(stripCount);
    for (var s = 0; s < stripCount; s++) {
      var rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
      stripRows[s] = rows;
      stripByteCounts[s] = rows * width * 3;
    }

    // --- layout ------------------------------------------------------------
    // header | IFD | external values (ascending tag order) | pixel data
    var ifdOffset = HEADER_SIZE;
    var ifdSize = 2 + 14 * IFD_ENTRY_SIZE + 4;          // 14 entries, next-IFD 0
    var cursor = ifdOffset + ifdSize;

    // BitsPerSample: 3 SHORTs -> always external
    var bitsPerSampleOffset = cursor;
    cursor += 3 * TYPE_SIZES[TYPE_SHORT];

    // StripOffsets / StripByteCounts: external only when the array does not
    // fit in the 4-byte value field (count > 1); a single LONG stays inline.
    var stripOffsetsOffset = null;
    var stripCountsOffset = null;
    if (stripCount > 1) {
      stripOffsetsOffset = cursor;
      cursor += stripCount * TYPE_SIZES[TYPE_LONG];
      stripCountsOffset = cursor;
      cursor += stripCount * TYPE_SIZES[TYPE_LONG];
    }

    var xResolutionOffset = cursor;
    cursor += TYPE_SIZES[TYPE_RATIONAL];
    var yResolutionOffset = cursor;
    cursor += TYPE_SIZES[TYPE_RATIONAL];

    var dataOffset = cursor;
    var totalSize = dataOffset + width * height * 3;

    var out = new Uint8Array(totalSize);
    var view = new DataView(out.buffer);

    // --- header ---
    out[0] = 0x49; out[1] = 0x49;                        // "II" (Little-Endian)
    view.setUint16(2, TIFF_MAGIC, true);
    view.setUint32(4, ifdOffset, true);

    // --- IFD entries (ascending tag order) ---
    // Each entry: [tag, type, count, valueOrOffset]
    var entries = [
      [TAG_IMAGE_WIDTH, TYPE_LONG, 1, width],
      [TAG_IMAGE_LENGTH, TYPE_LONG, 1, height],
      [TAG_BITS_PER_SAMPLE, TYPE_SHORT, 3, bitsPerSampleOffset],
      [TAG_COMPRESSION, TYPE_SHORT, 1, COMPRESSION_NONE],
      [TAG_PHOTOMETRIC, TYPE_SHORT, 1, PHOTOMETRIC_RGB],
      [TAG_STRIP_OFFSETS, TYPE_LONG, stripCount,
        stripCount === 1 ? dataOffset : stripOffsetsOffset],
      [TAG_ORIENTATION, TYPE_SHORT, 1, ORIENTATION_TOP_LEFT],
      [TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, 3],
      [TAG_ROWS_PER_STRIP, TYPE_LONG, 1, rowsPerStrip],
      [TAG_STRIP_BYTE_COUNTS, TYPE_LONG, stripCount,
        stripCount === 1 ? stripByteCounts[0] : stripCountsOffset],
      [TAG_X_RESOLUTION, TYPE_RATIONAL, 1, xResolutionOffset],
      [TAG_Y_RESOLUTION, TYPE_RATIONAL, 1, yResolutionOffset],
      [TAG_PLANAR_CONFIGURATION, TYPE_SHORT, 1, PLANAR_CHUNKY],
      [TAG_RESOLUTION_UNIT, TYPE_SHORT, 1, RESOLUTION_UNIT_INCH]
    ];

    view.setUint16(ifdOffset, entries.length, true);
    for (var e = 0; e < entries.length; e++) {
      var tag = entries[e][0];
      var type = entries[e][1];
      var count = entries[e][2];
      var value = entries[e][3];
      var entryOffset = ifdOffset + 2 + e * IFD_ENTRY_SIZE;
      view.setUint16(entryOffset, tag, true);
      view.setUint16(entryOffset + 2, type, true);
      view.setUint32(entryOffset + 4, count, true);
      // Values that fit in 4 bytes are stored inline in the value field
      // (left-justified); larger values are stored at their external offset.
      if (count === 1 && type === TYPE_SHORT) {
        view.setUint16(entryOffset + 8, value, true);
      } else if (count === 1 && type === TYPE_LONG) {
        view.setUint32(entryOffset + 8, value, true);
      } else {
        view.setUint32(entryOffset + 8, value, true);
      }
    }
    view.setUint32(ifdOffset + 2 + entries.length * IFD_ENTRY_SIZE, 0, true); // next IFD

    // --- external values ---
    view.setUint16(bitsPerSampleOffset, 8, true);
    view.setUint16(bitsPerSampleOffset + 2, 8, true);
    view.setUint16(bitsPerSampleOffset + 4, 8, true);

    if (stripCount > 1) {
      var acc = dataOffset;
      for (var i = 0; i < stripCount; i++) {
        view.setUint32(stripOffsetsOffset + i * 4, acc, true);
        view.setUint32(stripCountsOffset + i * 4, stripByteCounts[i], true);
        acc += stripByteCounts[i];
      }
    }

    view.setUint32(xResolutionOffset, resNumerator, true);
    view.setUint32(xResolutionOffset + 4, 100, true);
    view.setUint32(yResolutionOffset, resNumerator, true);
    view.setUint32(yResolutionOffset + 4, 100, true);

    // --- pixel data: RGBA -> RGB (alpha dropped, no compositing) ---
    var pixelCount = width * height;
    var src = 0;
    var dst = dataOffset;
    for (var p = 0; p < pixelCount; p++) {
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      dst += 3;
      src += 4;
    }

    return out;
  }

  // --- decoding ------------------------------------------------------------

  function readTagValue(view, littleEndian, type, count, fieldOffset) {
    var unitSize = TYPE_SIZES[type];
    if (unitSize === undefined) {
      throw new Error('TIFF 包含不支持的数据类型：' + type);
    }
    var valueSize = unitSize * count;
    var base;
    if (valueSize <= 4) {
      base = fieldOffset;                                // stored inline
    } else {
      base = view.getUint32(fieldOffset, littleEndian);  // stored at offset
    }
    var values = [];
    for (var i = 0; i < count; i++) {
      var o = base + i * unitSize;
      if (type === TYPE_BYTE) {
        values.push(view.getUint8(o));
      } else if (type === TYPE_SHORT) {
        values.push(view.getUint16(o, littleEndian));
      } else if (type === TYPE_LONG) {
        values.push(view.getUint32(o, littleEndian));
      } else if (type === TYPE_RATIONAL) {
        var denominator = view.getUint32(o + 4, littleEndian);
        values.push(denominator === 0
          ? 0
          : view.getUint32(o, littleEndian) / denominator);
      }
    }
    return values;
  }

  /**
   * Minimal TIFF reader. Supports uncompressed 8-bit chunky RGB baseline
   * files (exactly what encodeRGBA produces), in both byte orders.
   */
  function decode(bytes) {
    if (!isTypedBytes(bytes)) {
      throw new Error('bytes 必须是 Uint8Array 或 Uint8ClampedArray');
    }
    if (bytes.length < HEADER_SIZE) {
      throw new Error('数据太短，不是 TIFF 文件');
    }

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var byteOrderMark = view.getUint16(0, false);
    var littleEndian;
    if (byteOrderMark === 0x4949) {                      // "II"
      littleEndian = true;
    } else if (byteOrderMark === 0x4D4D) {               // "MM"
      littleEndian = false;
    } else {
      throw new Error('不是 TIFF 文件：缺少 II/MM 字节序标记');
    }
    if (view.getUint16(2, littleEndian) !== TIFF_MAGIC) {
      throw new Error('不是 TIFF 文件：魔数必须为 42');
    }

    var ifdOffset = view.getUint32(4, littleEndian);
    if (ifdOffset + 2 > bytes.length) {
      throw new Error('TIFF 目录偏移越界');
    }
    var entryCount = view.getUint16(ifdOffset, littleEndian);

    var tags = {};                                       // tag -> value (array or scalar)
    for (var e = 0; e < entryCount; e++) {
      var entryOffset = ifdOffset + 2 + e * IFD_ENTRY_SIZE;
      if (entryOffset + IFD_ENTRY_SIZE > bytes.length) {
        throw new Error('TIFF 目录条目越界');
      }
      var tag = view.getUint16(entryOffset, littleEndian);
      var type = view.getUint16(entryOffset + 2, littleEndian);
      var count = view.getUint32(entryOffset + 4, littleEndian);
      var values = readTagValue(view, littleEndian, type, count, entryOffset + 8);
      tags[tag] = count === 1 ? values[0] : values;
    }

    function requiredTag(tag, name) {
      if (tags[tag] === undefined) {
        throw new Error('TIFF 缺少必要标签 ' + tag + '（' + name + '）');
      }
      return tags[tag];
    }

    var width = requiredTag(TAG_IMAGE_WIDTH, 'ImageWidth');
    var height = requiredTag(TAG_IMAGE_LENGTH, 'ImageLength');
    var samples = tags[TAG_SAMPLES_PER_PIXEL] === undefined ? 3 : tags[TAG_SAMPLES_PER_PIXEL];
    if (width <= 0 || height <= 0) {
      throw new Error('TIFF 图像尺寸非法');
    }

    if (tags[TAG_COMPRESSION] !== undefined && tags[TAG_COMPRESSION] !== COMPRESSION_NONE) {
      throw new Error('decode 仅支持未压缩（Compression=1）图像');
    }
    if (tags[TAG_PHOTOMETRIC] !== undefined && tags[TAG_PHOTOMETRIC] !== PHOTOMETRIC_RGB) {
      throw new Error('decode 仅支持 RGB（PhotometricInterpretation=2）图像');
    }
    if (samples !== 3) {
      throw new Error('decode 仅支持 3 通道 RGB 图像');
    }
    var bits = tags[TAG_BITS_PER_SAMPLE];
    if (bits !== undefined) {
      var bitsList = bits instanceof Array ? bits : [bits];
      for (var b = 0; b < bitsList.length; b++) {
        if (bitsList[b] !== 8) {
          throw new Error('decode 仅支持 8 位采样');
        }
      }
    }
    if (tags[TAG_PLANAR_CONFIGURATION] !== undefined &&
        tags[TAG_PLANAR_CONFIGURATION] !== PLANAR_CHUNKY) {
      throw new Error('decode 仅支持 Chunky（PlanarConfiguration=1）排列');
    }

    var dpi = null;
    if (tags[TAG_X_RESOLUTION] !== undefined) {
      dpi = tags[TAG_X_RESOLUTION];                      // RATIONAL already reduced
    }

    // --- reassemble strips ---
    var stripOffsetsRaw = requiredTag(TAG_STRIP_OFFSETS, 'StripOffsets');
    var stripCountsRaw = requiredTag(TAG_STRIP_BYTE_COUNTS, 'StripByteCounts');
    var stripOffsets = stripOffsetsRaw instanceof Array ? stripOffsetsRaw : [stripOffsetsRaw];
    var stripCounts = stripCountsRaw instanceof Array ? stripCountsRaw : [stripCountsRaw];
    var rowsPerStrip = tags[TAG_ROWS_PER_STRIP] === undefined
      ? height : tags[TAG_ROWS_PER_STRIP];
    if (rowsPerStrip <= 0) {
      throw new Error('TIFF RowsPerStrip 非法');
    }
    var stripTotal = Math.ceil(height / rowsPerStrip);
    if (stripOffsets.length !== stripTotal || stripCounts.length !== stripTotal) {
      throw new Error('TIFF Strip 数量与图像高度不符');
    }

    var rgba = new Uint8ClampedArray(width * height * 4);
    for (var s = 0; s < stripTotal; s++) {
      var rowStart = s * rowsPerStrip;
      var rows = Math.min(rowsPerStrip, height - rowStart);
      var expectedBytes = rows * width * samples;
      if (stripCounts[s] !== expectedBytes) {
        throw new Error('TIFF Strip 字节数与图像尺寸不符');
      }
      var srcBase = stripOffsets[s];
      if (srcBase + expectedBytes > bytes.length) {
        throw new Error('TIFF 像素数据越界');
      }
      var pixelsInStrip = rows * width;
      var dstBase = rowStart * width * 4;
      for (var p = 0; p < pixelsInStrip; p++) {
        var srcIdx = srcBase + p * samples;
        var dstIdx = dstBase + p * 4;
        rgba[dstIdx] = bytes[srcIdx];
        rgba[dstIdx + 1] = bytes[srcIdx + 1];
        rgba[dstIdx + 2] = bytes[srcIdx + 2];
        rgba[dstIdx + 3] = 255;                          // decoded files carry no alpha
      }
    }

    return { width: width, height: height, dpi: dpi, samples: samples, rgba: rgba };
  }

  // --- availability --------------------------------------------------------

  /**
   * The encoder is pure JS and needs no DOM; it is available wherever
   * typed arrays and DataView exist.
   */
  function isAvailable() {
    return typeof Uint8Array !== 'undefined' &&
      typeof Uint8ClampedArray !== 'undefined' &&
      typeof DataView !== 'undefined';
  }

  var FigTiff = {
    encodeRGBA: encodeRGBA,
    decode: decode,
    isAvailable: isAvailable
  };

  globalScope.FigTiff = FigTiff;
})();
