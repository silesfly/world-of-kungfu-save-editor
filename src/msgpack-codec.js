(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WokMsgPack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COMPRESSED_PREFIX = 'COMPRESSED:';
  var MAX_COMPRESSED_DAT_BYTES = 32 * 1024 * 1024;
  var MAX_UNCOMPRESSED_MP_BYTES = 64 * 1024 * 1024;
  var MAX_MSGPACK_DEPTH = 64;
  var utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  var utf8Encoder = new TextEncoder();
  var scratch = new ArrayBuffer(8);
  var scratchView = new DataView(scratch);

  function ByteWriter(initial) {
    this.buf = new Uint8Array(initial || 1024);
    this.len = 0;
  }
  ByteWriter.prototype.ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length || 1;
    while (cap < this.len + n) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  };
  ByteWriter.prototype.u8 = function (b) {
    this.ensure(1);
    this.buf[this.len++] = b & 255;
  };
  ByteWriter.prototype.bytes = function (b) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  };
  ByteWriter.prototype.toBytes = function () {
    return this.buf.slice(0, this.len);
  };

  function need(bytes, pos, n) {
    if (n < 0 || pos + n > bytes.length) throw new Error('Truncated MessagePack buffer');
  }
  function makeNode(t, v, raw) {
    return { t: t, v: v, raw: raw === undefined ? null : raw };
  }
  function readU16(bytes, pos) {
    return (bytes[pos] << 8) | bytes[pos + 1];
  }
  function readU32(bytes, pos) {
    return ((bytes[pos] << 24) >>> 0) + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
  }

  function decodeMsgPack(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('decodeMsgPack expects Uint8Array');
    if (bytes.length > MAX_UNCOMPRESSED_MP_BYTES) throw new Error('Decompressed MessagePack exceeds maximum size');
    if (!bytes.length) throw new Error('Empty MessagePack buffer');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 0;

    function readLen(tag, smallMask, hasSmall) {
      if (hasSmall) return tag & smallMask;
      if (tag === 0xd9 || tag === 0xc4) {
        need(bytes, pos, 1); return bytes[pos++];
      }
      if (tag === 0xda || tag === 0xc5 || tag === 0xdc || tag === 0xde) {
        need(bytes, pos, 2); var n = readU16(bytes, pos); pos += 2; return n;
      }
      if (tag === 0xdb || tag === 0xc6 || tag === 0xdd || tag === 0xdf) {
        need(bytes, pos, 4); var m = readU32(bytes, pos); pos += 4; return m;
      }
      throw new Error('Unsupported MessagePack tag 0x' + tag.toString(16));
    }

    function parse(depth) {
      depth = depth || 0;
      if (depth > MAX_MSGPACK_DEPTH) throw new Error('MessagePack nesting depth exceeded');
      need(bytes, pos, 1);
      var tag = bytes[pos++];

      if (tag <= 0x7f) return makeNode('pfixint', tag, null);
      if (tag >= 0xe0) return makeNode('nfixint', tag - 256, null);

      switch (tag) {
        case 0xc0: return makeNode('nil', null, null);
        case 0xc2: return makeNode('bool', false, null);
        case 0xc3: return makeNode('bool', true, null);
        case 0xca:
          need(bytes, pos, 4);
          var f32 = view.getFloat32(pos, false);
          var r32 = bytes.slice(pos, pos + 4); pos += 4;
          return makeNode('f32', f32, r32);
        case 0xcb:
          need(bytes, pos, 8);
          var f64 = view.getFloat64(pos, false);
          var r64 = bytes.slice(pos, pos + 8); pos += 8;
          return makeNode('f64', f64, r64);
        case 0xcc: need(bytes, pos, 1); return makeNode('u8', bytes[pos++], null);
        case 0xcd: need(bytes, pos, 2); var u16 = readU16(bytes, pos); pos += 2; return makeNode('u16', u16, null);
        case 0xce: need(bytes, pos, 4); var u32 = readU32(bytes, pos); pos += 4; return makeNode('u32', u32, null);
        case 0xcf: need(bytes, pos, 8); var u64 = view.getBigUint64(pos, false); pos += 8; return makeNode('u64', u64, null);
        case 0xd0: need(bytes, pos, 1); var i8 = view.getInt8(pos); pos += 1; return makeNode('i8', i8, null);
        case 0xd1: need(bytes, pos, 2); var i16 = view.getInt16(pos, false); pos += 2; return makeNode('i16', i16, null);
        case 0xd2: need(bytes, pos, 4); var i32 = view.getInt32(pos, false); pos += 4; return makeNode('i32', i32, null);
        case 0xd3: need(bytes, pos, 8); var i64 = view.getBigInt64(pos, false); pos += 8; return makeNode('i64', i64, null);
        case 0xd9: case 0xda: case 0xdb:
          var slen = readLen(tag, 0, false);
          need(bytes, pos, slen);
          var s = utf8Decoder.decode(bytes.subarray(pos, pos + slen)); pos += slen;
          return makeNode(tag === 0xd9 ? 'str8' : tag === 0xda ? 'str16' : 'str32', s, null);
        case 0xc4: case 0xc5: case 0xc6:
          var blen = readLen(tag, 0, false);
          need(bytes, pos, blen);
          var bin = bytes.slice(pos, pos + blen); pos += blen;
          return makeNode(tag === 0xc4 ? 'bin8' : tag === 0xc5 ? 'bin16' : 'bin32', bin, null);
        case 0xdc: case 0xdd:
          var alen = readLen(tag, 0, false);
          if (alen > bytes.length - pos) throw new Error('Invalid array length');
          var arr = new Array(alen);
          for (var ai = 0; ai < alen; ai++) arr[ai] = parse(depth + 1);
          return makeNode(tag === 0xdc ? 'arr16' : 'arr32', arr, null);
        case 0xde: case 0xdf:
          var mlen = readLen(tag, 0, false);
          if (mlen > (bytes.length - pos) / 2) throw new Error('Invalid map length');
          var map = new Array(mlen);
          for (var mi = 0; mi < mlen; mi++) map[mi] = [parse(depth + 1), parse(depth + 1)];
          return makeNode(tag === 0xde ? 'map16' : 'map32', map, null);
        default:
          if (tag >= 0xa0 && tag <= 0xbf) {
            var plen = tag & 0x1f;
            need(bytes, pos, plen);
            var ps = utf8Decoder.decode(bytes.subarray(pos, pos + plen)); pos += plen;
            return makeNode('str', ps, null);
          }
          if (tag >= 0x90 && tag <= 0x9f) {
            var palen = tag & 0x0f;
            if (palen > bytes.length - pos) throw new Error('Invalid array length');
            var parr = new Array(palen);
            for (var pi = 0; pi < palen; pi++) parr[pi] = parse(depth + 1);
            return makeNode('arr', parr, null);
          }
          if (tag >= 0x80 && tag <= 0x8f) {
            var pmlen = tag & 0x0f;
            if (pmlen > (bytes.length - pos) / 2) throw new Error('Invalid map length');
            var pmap = new Array(pmlen);
            for (var pmi = 0; pmi < pmlen; pmi++) pmap[pmi] = [parse(depth + 1), parse(depth + 1)];
            return makeNode('map', pmap, null);
          }
          throw new Error('Unsupported MessagePack tag 0x' + tag.toString(16));
      }
    }

    var node = parse();
    if (pos !== bytes.length) throw new Error('Trailing bytes after MessagePack root');
    return node;
  }


  function encodeMsgPack(node) {
    var w = new ByteWriter(4096);
    function intValue(v) {
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number') {
        if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error('Invalid MessagePack integer');
        return BigInt(v);
      }
      if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return BigInt(v);
      throw new Error('Invalid MessagePack integer');
    }
    function intFits(t, value) {
      switch (t) {
        case 'pfixint': return value >= 0n && value <= 127n;
        case 'nfixint': return value >= -32n && value <= -1n;
        case 'u8': return value >= 0n && value <= 255n;
        case 'u16': return value >= 0n && value <= 65535n;
        case 'u32': return value >= 0n && value <= 4294967295n;
        case 'u64': return value >= 0n && value <= 18446744073709551615n;
        case 'i8': return value >= -128n && value <= 127n;
        case 'i16': return value >= -32768n && value <= 32767n;
        case 'i32': return value >= -2147483648n && value <= 2147483647n;
        case 'i64': return value >= -9223372036854775808n && value <= 9223372036854775807n;
        default: return false;
      }
    }
    function writeIntTag(tag, value) {
      switch (tag) {
        case 'pfixint': w.u8(Number(value)); return;
        case 'nfixint': w.u8(Number(value) & 255); return;
        case 'u8': w.u8(0xcc); w.u8(Number(value)); return;
        case 'u16': w.u8(0xcd); writeUintValue(w, value, 2); return;
        case 'u32': w.u8(0xce); writeUintValue(w, value, 4); return;
        case 'u64': w.u8(0xcf); writeUintValue(w, value, 8); return;
        case 'i8': w.u8(0xd0); writeUintValue(w, BigInt.asUintN(8, value), 1); return;
        case 'i16': w.u8(0xd1); writeUintValue(w, BigInt.asUintN(16, value), 2); return;
        case 'i32': w.u8(0xd2); writeUintValue(w, BigInt.asUintN(32, value), 4); return;
        case 'i64': w.u8(0xd3); writeUintValue(w, BigInt.asUintN(64, value), 8); return;
      }
    }
    function canonicalInt(value) {
      if (value >= 0n && value <= 127n) return 'pfixint';
      if (value >= -32n && value <= -1n) return 'nfixint';
      if (value >= 0n && value <= 255n) return 'u8';
      if (value >= 0n && value <= 65535n) return 'u16';
      if (value >= 0n && value <= 4294967295n) return 'u32';
      if (value >= 0n && value <= 18446744073709551615n) return 'u64';
      if (value >= -128n && value <= 127n) return 'i8';
      if (value >= -32768n && value <= 32767n) return 'i16';
      if (value >= -2147483648n && value <= 2147483647n) return 'i32';
      return 'i64';
    }
    function enc(n) {
      if (!n || typeof n.t !== 'string') throw new Error('Invalid AST node');
      switch (n.t) {
        case 'pfixint': case 'nfixint': case 'u8': case 'u16': case 'u32': case 'u64': case 'i8': case 'i16': case 'i32': case 'i64': {
          var iv = intValue(n.v);
          if (iv < -9223372036854775808n || iv > 18446744073709551615n) throw new Error('Integer out of MessagePack range');
          writeIntTag(intFits(n.t, iv) ? n.t : canonicalInt(iv), iv);
          return;
        }
        case 'nil': w.u8(0xc0); return;
        case 'bool': w.u8(n.v ? 0xc3 : 0xc2); return;
        case 'f32':
          w.u8(0xca);
          if (n.raw && n.raw.length === 4) w.bytes(n.raw);
          else { scratchView.setFloat32(0, n.v, false); w.bytes(new Uint8Array(scratch, 0, 4)); }
          return;
        case 'f64':
          w.u8(0xcb);
          if (n.raw && n.raw.length === 8) w.bytes(n.raw);
          else { scratchView.setFloat64(0, n.v, false); w.bytes(new Uint8Array(scratch, 0, 8)); }
          return;
        case 'str': case 'str8': case 'str16': case 'str32':
          var sb = utf8Encoder.encode(String(n.v));
          if (sb.length > 0xffffffff) throw new Error('String too long for MessagePack');
          var st = n.t === 'str' && sb.length <= 31 ? 'str' :
                   n.t === 'str8' && sb.length <= 255 ? 'str8' :
                   n.t === 'str16' && sb.length <= 65535 ? 'str16' :
                   n.t === 'str32' && sb.length <= 0xffffffff ? 'str32' :
                   sb.length <= 31 ? 'str' : sb.length <= 255 ? 'str8' : sb.length <= 65535 ? 'str16' : 'str32';
          if (st === 'str') w.u8(0xa0 | sb.length);
          else if (st === 'str8') { w.u8(0xd9); w.u8(sb.length); }
          else if (st === 'str16') { w.u8(0xda); w.u8(sb.length >> 8); w.u8(sb.length); }
          else { w.u8(0xdb); writeUintValue(w, BigInt(sb.length), 4); }
          w.bytes(sb); return;
        case 'bin': case 'bin8': case 'bin16': case 'bin32':
          var b = n.v instanceof Uint8Array ? n.v : new Uint8Array(n.v || []);
          if (b.length > 0xffffffff) throw new Error('Binary payload too long for MessagePack');
          var bt = n.t === 'bin8' && b.length <= 255 ? 'bin8' :
                   n.t === 'bin16' && b.length <= 65535 ? 'bin16' :
                   n.t === 'bin32' && b.length <= 0xffffffff ? 'bin32' :
                   b.length <= 255 ? 'bin8' : b.length <= 65535 ? 'bin16' : 'bin32';
          if (bt === 'bin8') { w.u8(0xc4); w.u8(b.length); }
          else if (bt === 'bin16') { w.u8(0xc5); w.u8(b.length >> 8); w.u8(b.length); }
          else { w.u8(0xc6); writeUintValue(w, BigInt(b.length), 4); }
          w.bytes(b); return;
        case 'arr': case 'arr16': case 'arr32':
          var depth = arguments[1] || 0;
          if (depth > MAX_MSGPACK_DEPTH) throw new Error('MessagePack nesting depth exceeded');
          var a = n.v || [];
          if (a.length > 0xffffffff) throw new Error('Array too long for MessagePack');
          var at = n.t === 'arr' && a.length <= 15 ? 'arr' :
                   n.t === 'arr16' && a.length <= 65535 ? 'arr16' :
                   n.t === 'arr32' && a.length <= 0xffffffff ? 'arr32' :
                   a.length <= 15 ? 'arr' : a.length <= 65535 ? 'arr16' : 'arr32';
          if (at === 'arr') w.u8(0x90 | a.length);
          else if (at === 'arr16') { w.u8(0xdc); w.u8(a.length >> 8); w.u8(a.length); }
          else { w.u8(0xdd); writeUintValue(w, BigInt(a.length), 4); }
          for (var i = 0; i < a.length; i++) enc(a[i], depth + 1); return;
        case 'map': case 'map16': case 'map32':
          var depth = arguments[1] || 0;
          if (depth > MAX_MSGPACK_DEPTH) throw new Error('MessagePack nesting depth exceeded');
          var m = n.v || [];
          if (m.length > 0xffffffff) throw new Error('Map too long for MessagePack');
          var mt = n.t === 'map' && m.length <= 15 ? 'map' :
                   n.t === 'map16' && m.length <= 65535 ? 'map16' :
                   n.t === 'map32' && m.length <= 0xffffffff ? 'map32' :
                   m.length <= 15 ? 'map' : m.length <= 65535 ? 'map16' : 'map32';
          if (mt === 'map') w.u8(0x80 | m.length);
          else if (mt === 'map16') { w.u8(0xde); w.u8(m.length >> 8); w.u8(m.length); }
          else { w.u8(0xdf); writeUintValue(w, BigInt(m.length), 4); }
          for (var j = 0; j < m.length; j++) { enc(m[j][0], depth + 1); enc(m[j][1], depth + 1); } return;
        default: throw new Error('Unsupported AST tag: ' + n.t);
      }
    }
    function writeUintValue(writer, value, count) {
      for (var i = count - 1; i >= 0; i--) writer.u8(Number((value >> BigInt(i * 8)) & 0xffn));
    }
    enc(node);
    return w.toBytes();
  }

  function astToPlain(n, depth) {
    depth = depth || 0;
    if (depth > MAX_MSGPACK_DEPTH) throw new Error('MessagePack nesting depth exceeded');
    if (!n) return null;
    switch (n.t) {
      case 'nil': return null;
      case 'bool': return !!n.v;
      case 'f32': case 'f64': return Number(n.v);
      case 'str': case 'str8': case 'str16': case 'str32': return String(n.v);
      case 'bin': case 'bin8': case 'bin16': case 'bin32': return bytesToBase64(n.v);
      case 'arr': case 'arr16': case 'arr32': return n.v.map(function (x) { return astToPlain(x, depth + 1); });
      case 'map': case 'map16': case 'map32':
        var obj = {};
        for (var i = 0; i < n.v.length; i++) obj[String(astToPlain(n.v[i][0], depth + 1))] = astToPlain(n.v[i][1], depth + 1);
        return obj;
      default:
        if (typeof n.v === 'bigint') {
          if (n.v >= BigInt(Number.MIN_SAFE_INTEGER) && n.v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n.v);
          return n.v.toString();
        }
        return Number(n.v);
    }
  }

  function canonicalInt(n) {
    var isBig = typeof n === 'bigint';
    if (!isBig && (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n)) throw new Error('makeInt requires an integer');
    var v = isBig ? n : BigInt(n);
    if (v >= 0n) {
      if (v <= 127n) return makeNode('pfixint', Number(v), null);
      if (v <= 255n) return makeNode('u8', Number(v), null);
      if (v <= 65535n) return makeNode('u16', Number(v), null);
      if (v <= 4294967295n) return makeNode('u32', Number(v), null);
      if (v <= 18446744073709551615n) return makeNode('u64', v, null);
    } else {
      if (v >= -32n) return makeNode('nfixint', Number(v), null);
      if (v >= -128n) return makeNode('i8', Number(v), null);
      if (v >= -32768n) return makeNode('i16', Number(v), null);
      if (v >= -2147483648n) return makeNode('i32', Number(v), null);
      if (v >= -9223372036854775808n) return makeNode('i64', v, null);
    }
    throw new Error('Integer out of MessagePack range');
  }

  function makeNil() { return makeNode('nil', null, null); }
  function makeBool(b) { return makeNode('bool', !!b, null); }
  function makeInt(n) { return canonicalInt(n); }
  function makeFloat32(n) { return makeNode('f32', Math.fround(n), null); }
  function makeStr(s) {
    var str = String(s);
    var len = utf8Encoder.encode(str).length;
    var t = len <= 31 ? 'str' : len <= 255 ? 'str8' : len <= 65535 ? 'str16' : 'str32';
    return makeNode(t, str, null);
  }
  function makeArr(items) {
    items = items || [];
    var t = items.length <= 15 ? 'arr' : items.length <= 65535 ? 'arr16' : 'arr32';
    return makeNode(t, items, null);
  }

  function setInt(node, n) {
    var fresh = canonicalInt(n);
    if (['pfixint','nfixint','u8','u16','u32','u64','i8','i16','i32','i64'].indexOf(node.t) >= 0 &&
        (typeof node.v === 'bigint' || (typeof node.v === 'number' && isFinite(node.v) && Math.floor(node.v) === node.v)) &&
        BigInt(node.v) === BigInt(fresh.v)) return node;
    node.t = fresh.t; node.v = fresh.v; node.raw = null;
    return node;
  }
  function setFloat32(node, n) {
    var value = Math.fround(n);
    if (node.t === 'f32' && node.v === value) return node;
    node.t = 'f32'; node.v = value; node.raw = null;
    return node;
  }
  function setStr(node, s) {
    var str = String(s);
    if (node.v === str) return node;
    var len = utf8Encoder.encode(str).length;
    node.v = str;
    node.t = len <= 31 ? 'str' : len <= 255 ? 'str8' : len <= 65535 ? 'str16' : 'str32';
    node.raw = null;
    return node;
  }
  function setBool(node, b) { node.t = 'bool'; node.v = !!b; node.raw = null; return node; }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(bytes) {
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < bytes.length) {
      var rem = bytes.length - i;
      var m = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
      out += B64[(m >> 18) & 63] + B64[(m >> 12) & 63] + (rem === 2 ? B64[(m >> 6) & 63] : '=') + '=';
    }
    return out;
  }
  function base64ToBytes(b64) {
    var s = String(b64).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('Invalid base64');
    var pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    var out = new Uint8Array((s.length / 4) * 3 - pad);
    var p = 0;
    for (var i = 0; i < s.length; i += 4) {
      var c0 = B64.indexOf(s[i]), c1 = B64.indexOf(s[i + 1]);
      var c2 = s[i + 2] === '=' ? 0 : B64.indexOf(s[i + 2]);
      var c3 = s[i + 3] === '=' ? 0 : B64.indexOf(s[i + 3]);
      if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('Invalid base64');
      var q = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      if (p < out.length) out[p++] = (q >> 16) & 255;
      if (p < out.length) out[p++] = (q >> 8) & 255;
      if (p < out.length) out[p++] = q & 255;
    }
    return out;
  }

  var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  function gzipCompress(bytes) {
    if (isNode) {
      try { return Promise.resolve(new Uint8Array(require('zlib').gzipSync(bytes))); }
      catch (e) { return Promise.reject(e); }
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  function gzipDecompress(bytes) {
    if (bytes.length > MAX_COMPRESSED_DAT_BYTES) return Promise.reject(new Error('Compressed .dat exceeds maximum size'));
    if (isNode) {
      try { return Promise.resolve(new Uint8Array(require('zlib').gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_MP_BYTES }))); }
      catch (e) { return Promise.reject(e); }
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function readNext() {
      return reader.read().then(function (res) {
        if (res.done) {
          var out = new Uint8Array(total);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            out.set(chunks[i], offset);
            offset += chunks[i].byteLength;
          }
          return out;
        }
        var chunk = res.value;
        total += chunk.byteLength;
        if (total > MAX_UNCOMPRESSED_MP_BYTES) {
          reader.cancel();
          throw new Error('Decompressed MessagePack exceeds maximum size');
        }
        chunks.push(chunk);
        return readNext();
      });
    }
    return readNext();
  }

  function decodeDat(input) {
    return Promise.resolve().then(function () {
      var bytes;
      if (typeof input === 'string') bytes = utf8Encoder.encode(input);
      else if (input instanceof Uint8Array) bytes = input;
      else throw new Error('decodeDat expects string or Uint8Array');
      if (bytes.length > MAX_COMPRESSED_DAT_BYTES) throw new Error('Compressed .dat exceeds maximum size');
      var text = utf8Decoder.decode(bytes).replace(/^\uFEFF/, '').trim();
      if (text.indexOf(COMPRESSED_PREFIX) !== 0) throw new Error('Missing COMPRESSED: prefix');
      var b64 = text.slice(COMPRESSED_PREFIX.length);
      return gzipDecompress(base64ToBytes(b64)).then(function (mpBytes) {
        return { ast: decodeMsgPack(mpBytes), mpBytes: mpBytes };
      });
    });
  }
  function encodeDat(ast) {
    var mp = encodeMsgPack(ast);
    return gzipCompress(mp).then(function (gz) { return COMPRESSED_PREFIX + bytesToBase64(gz); });
  }
  function decodeDatSync(input) {
    if (!isNode) throw new Error('decodeDatSync requires Node.js zlib');
    var bytes = typeof input === 'string' ? utf8Encoder.encode(input) : input;
    if (bytes.length > MAX_COMPRESSED_DAT_BYTES) throw new Error('Compressed .dat exceeds maximum size');
    var text = utf8Decoder.decode(bytes).replace(/^\uFEFF/, '').trim();
    if (text.indexOf(COMPRESSED_PREFIX) !== 0) throw new Error('Missing COMPRESSED: prefix');
    var mpBytes = new Uint8Array(require('zlib').gunzipSync(base64ToBytes(text.slice(COMPRESSED_PREFIX.length)), { maxOutputLength: MAX_UNCOMPRESSED_MP_BYTES }));
    return { ast: decodeMsgPack(mpBytes), mpBytes: mpBytes };
  }
  function encodeDatSync(ast) {
    if (!isNode) throw new Error('encodeDatSync requires Node.js zlib');
    var gz = new Uint8Array(require('zlib').gzipSync(encodeMsgPack(ast)));
    return COMPRESSED_PREFIX + bytesToBase64(gz);
  }

  return {
    COMPRESSED_PREFIX: COMPRESSED_PREFIX,
    MAX_COMPRESSED_DAT_BYTES: MAX_COMPRESSED_DAT_BYTES,
    MAX_UNCOMPRESSED_MP_BYTES: MAX_UNCOMPRESSED_MP_BYTES,
    MAX_MSGPACK_DEPTH: MAX_MSGPACK_DEPTH,
    decodeMsgPack: decodeMsgPack,
    encodeMsgPack: encodeMsgPack,
    astToPlain: astToPlain,
    makeNil: makeNil,
    makeBool: makeBool,
    makeInt: makeInt,
    makeFloat32: makeFloat32,
    makeStr: makeStr,
    makeArr: makeArr,
    setInt: setInt,
    setFloat32: setFloat32,
    setStr: setStr,
    setBool: setBool,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    gzipCompress: gzipCompress,
    gzipDecompress: gzipDecompress,
    decodeDat: decodeDat,
    encodeDat: encodeDat,
    decodeDatSync: decodeDatSync,
    encodeDatSync: encodeDatSync
  };
});
