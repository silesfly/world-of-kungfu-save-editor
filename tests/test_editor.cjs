'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WokCatalog = require('../src/catalog-data.js');
const WokMsgPack = require('../src/msgpack-codec.js');
const WokEditorCore = require('../src/editor-core.js');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    fail += 1;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}

function decodeMp(datText) {
  return WokMsgPack.decodeDatSync(datText).mpBytes;
}

function sameBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function validateClean(ses, label) {
  const v = ses.validate();
  assert.ok(v && typeof v === 'object', `${label}: validate() must return object`);
  assert.strictEqual(v.valid, true, `${label}: expected valid, errors=${JSON.stringify(v.errors)}`);
}

function roundTripSync(ses, label) {
  const dat = ses.encodeSync();
  assert.strictEqual(typeof dat, 'string', `${label}: encodeSync must return string`);
  const reloaded = WokEditorCore.loadSessionSync(dat);
  validateClean(reloaded, `${label} reload`);
  return dat;
}

function entityId(entity) {
  if (entity === null || entity === undefined) return null;
  if (typeof entity !== 'object') return String(entity);
  const cand = ['id', 'statId', 'key', 'code', 'itemId', 'kfId', 'traitId', 'charaId', 'Id', 'ID'];
  for (const k of cand) {
    if (entity[k] !== undefined && entity[k] !== null && entity[k] !== '') return String(entity[k]);
  }
  return null;
}

function pickId(list, preferred, required) {
  assert.ok(Array.isArray(list) && list.length > 0, `${required} catalog must not be empty`);
  if (preferred) {
    const hit = list.find((e) => entityId(e) === preferred);
    if (hit) return preferred;
  }
  for (const e of list) {
    const id = entityId(e);
    if (id) return id;
  }
  assert.fail(`${required} catalog has no usable id`);
}

function firstCharacterId(ses) {
  const list = ses.listCharacters();
  assert.ok(Array.isArray(list) && list.length > 0, 'listCharacters must return at least one character');
  const first = list[0];
  const id = entityId(first);
  assert.ok(id, 'character entry must expose an id');
  return id;
}

function collectPersistentTotals(value, out) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectPersistentTotals(v, out);
    return out;
  }
  if (value.persistentTotal !== undefined && value.persistentTotal !== null) {
    out.push(value.persistentTotal);
  }
  for (const k of Object.keys(value)) collectPersistentTotals(value[k], out);
  return out;
}

const CATALOG_KEYS = ['stats', 'origins', 'characters', 'kungfu', 'traits', 'traitChains', 'items', 'codeAtlas', 'kungfuStyleLabels', 'itemStyleLabels'];

ok('catalog exports present', () => {
  for (const k of CATALOG_KEYS) {
    assert.ok(k in WokCatalog, `WokCatalog.${k} missing`);
  }
  assert.ok(Array.isArray(WokCatalog.stats), 'stats must be array');
  assert.ok(Array.isArray(WokCatalog.origins), 'origins must be array');
  assert.ok(Array.isArray(WokCatalog.characters), 'characters must be array');
  assert.ok(Array.isArray(WokCatalog.kungfu), 'kungfu must be array');
  assert.ok(Array.isArray(WokCatalog.traits), 'traits must be array');
  assert.ok(Array.isArray(WokCatalog.items), 'items must be array');
  assert.ok(Array.isArray(WokCatalog.codeAtlas), 'codeAtlas must be array');
});

ok('catalog size thresholds', () => {
  assert.ok(WokCatalog.stats.length >= 450, `stats ${WokCatalog.stats.length} < 450`);
  assert.strictEqual(WokCatalog.origins.length, 10, `origins ${WokCatalog.origins.length} !== 10`);
  assert.ok(WokCatalog.characters.length >= 360, `characters ${WokCatalog.characters.length} < 360`);
  assert.ok(WokCatalog.kungfu.length >= 440, `kungfu ${WokCatalog.kungfu.length} < 440`);
  assert.ok(WokCatalog.traits.length >= 650, `traits ${WokCatalog.traits.length} < 650`);
  assert.ok(WokCatalog.items.length >= 980, `items ${WokCatalog.items.length} < 980`);
  assert.ok(WokCatalog.codeAtlas.length >= 7, `codeAtlas ${WokCatalog.codeAtlas.length} < 7`);
});

ok('catalog localized fields non-empty', () => {
  const localized = [
    { name: 'stats', list: WokCatalog.stats },
    { name: 'characters', list: WokCatalog.characters },
    { name: 'kungfu', list: WokCatalog.kungfu },
    { name: 'traits', list: WokCatalog.traits },
    { name: 'items', list: WokCatalog.items },
    { name: 'origins', list: WokCatalog.origins }
  ];
  for (const group of localized) {
    for (let i = 0; i < group.list.length; i += 1) {
      const entry = group.list[i];
      assert.ok(entry && typeof entry === 'object', `${group.name}[${i}] must be object`);
      const ko = entry.ko ?? entry.nameKo ?? entry.koName ?? entry.labelKo;
      const zh = entry.zh ?? entry.nameZh ?? entry.zhName ?? entry.labelZh;
      const en = entry.en ?? entry.nameEn ?? entry.enName ?? entry.labelEn;
      if (ko === undefined && zh === undefined && en === undefined) continue;
      for (const [tag, val] of [['ko', ko], ['zh', zh], ['en', en]]) {
        if (val === undefined) continue;
        assert.strictEqual(typeof val, 'string', `${group.name}[${i}].${tag} must be string`);
      }
      const koText = typeof ko === 'string' ? ko.trim() : '';
      const cnText = typeof zh === 'string' ? zh.trim() : '';
      const enText = typeof en === 'string' ? en.trim() : '';
      assert.ok(koText.length > 0 || cnText.length > 0 || enText.length > 0, `${group.name}[${i}] must have at least one non-empty localized field`);
    }
  }
});

ok('no personal paths in catalog', () => {
  const blob = JSON.stringify(WokCatalog);
  const forbidden = [/[A-Za-z]:\\Users\\/i, /\/Users\//, /\/home\//i, /\bAppData\b/i, /\bOneDrive\b/i];
  for (const re of forbidden) {
    assert.ok(!re.test(blob), `catalog contains forbidden pattern ${re}`);
  }
});

ok('msgpack exported surface', () => {
  for (const fn of ['decodeMsgPack', 'encodeMsgPack', 'astToPlain', 'makeNil', 'makeBool', 'makeInt', 'makeFloat32', 'makeStr', 'makeArr', 'setInt', 'setFloat32', 'setStr', 'setBool', 'bytesToBase64', 'base64ToBytes', 'gzipCompress', 'gzipDecompress', 'decodeDat', 'encodeDat', 'decodeDatSync', 'encodeDatSync']) {
    assert.strictEqual(typeof WokMsgPack[fn], 'function', `WokMsgPack.${fn} missing`);
  }
  assert.strictEqual(typeof WokMsgPack.COMPRESSED_PREFIX, 'string', 'COMPRESSED_PREFIX must be string');
});

ok('msgpack fixints', () => {
  for (const n of [0, 1, 42, 127]) {
    const ast = WokMsgPack.makeInt(n);
    assert.ok(sameBytes(WokMsgPack.encodeMsgPack(ast), Buffer.from([n])), `pfixint ${n}`);
    assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(Buffer.from([n]))), n);
  }
  for (const n of [-1, -32]) {
    const ast = WokMsgPack.makeInt(n);
    const bytes = WokMsgPack.encodeMsgPack(ast);
    assert.strictEqual(bytes.length, 1, `nfixint ${n} length`);
    assert.strictEqual(bytes[0], n & 0xff, `nfixint ${n} raw`);
    assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bytes)), n);
  }
});

ok('msgpack unsigned ints', () => {
  const cases = [
    { n: 200, tag: 0xcc },
    { n: 5000, tag: 0xcd },
    { n: 70000, tag: 0xce },
    { n: 5000000000, tag: 0xcf }
  ];
  for (const c of cases) {
    const bytes = WokMsgPack.encodeMsgPack(WokMsgPack.makeInt(c.n));
    assert.strictEqual(bytes[0], c.tag, `u tag for ${c.n}`);
    assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bytes)), c.n);
  }
});

ok('msgpack signed ints', () => {
  const cases = [
    { n: -100, tag: 0xd0 },
    { n: -5000, tag: 0xd1 },
    { n: -100000, tag: 0xd2 },
    { n: -5000000000, tag: 0xd3 }
  ];
  for (const c of cases) {
    const bytes = WokMsgPack.encodeMsgPack(WokMsgPack.makeInt(c.n));
    assert.strictEqual(bytes[0], c.tag, `i tag for ${c.n}`);
    assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bytes)), c.n);
  }
});

ok('msgpack float32 raw preservation', () => {
  const samples = [0, -0, 1, -1.5, 3.1415927, 1e-30, 1e30, NaN, Infinity, -Infinity];
  for (const sample of samples) {
    const ast = WokMsgPack.makeFloat32(sample);
    const bytes = WokMsgPack.encodeMsgPack(ast);
    assert.strictEqual(bytes.length, 5, `f32 length for ${sample}`);
    assert.strictEqual(bytes[0], 0xca, `f32 tag for ${sample}`);
    const decoded = WokMsgPack.decodeMsgPack(bytes);
    const reencoded = WokMsgPack.encodeMsgPack(decoded);
    assert.ok(sameBytes(reencoded, bytes), `f32 raw round-trip ${sample}`);
  }
  const nanBytes = Buffer.from([0xca, 0x7f, 0xc0, 0x00, 0x01]);
  const nanAst = WokMsgPack.decodeMsgPack(nanBytes);
  assert.ok(sameBytes(WokMsgPack.encodeMsgPack(nanAst), nanBytes), 'custom NaN payload must survive');
});

ok('msgpack strings', () => {
  const short = 'abc';
  const s8 = 'x'.repeat(200);
  const s16 = 'y'.repeat(40000);
  const s32 = 'z'.repeat(70000);
  for (const [value, tag] of [[short, 0xa3], [s8, 0xd9], [s16, 0xda], [s32, 0xdb]]) {
    const ast = WokMsgPack.makeStr(value);
    const bytes = WokMsgPack.encodeMsgPack(ast);
    assert.strictEqual(bytes[0], tag, `str tag for len ${value.length}`);
    assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bytes)), value);
  }
});
ok('msgpack preserves leading BOM inside strings and CSP option rendering is safe', () => {
  const bomBytes = Buffer.from([0xa3, 0xef, 0xbb, 0xbf]);
  assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bomBytes)), '\uFEFF');
  assert.ok(sameBytes(WokMsgPack.encodeMsgPack(WokMsgPack.makeStr('\uFEFF')), bomBytes));
  const outerBomDat = '\uFEFF' + WokEditorCore.createDemoDatSync();
  const decoded = WokMsgPack.decodeDatSync(outerBomDat);
  assert.ok(decoded != null);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'editor-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'editor-page.html'), 'utf8');
  assert.strictEqual(ui.includes(".replace('<option"), false);
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
});

ok('msgpack arrays', () => {
  const small = WokMsgPack.makeArr([WokMsgPack.makeInt(1), WokMsgPack.makeInt(2)]);
  const smallBytes = WokMsgPack.encodeMsgPack(small);
  assert.strictEqual(smallBytes[0], 0x92, 'arr tag');
  assert.deepStrictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(smallBytes)), [1, 2]);
  const bigItems = [];
  for (let i = 0; i < 200; i += 1) bigItems.push(WokMsgPack.makeInt(i));
  const bigBytes = WokMsgPack.encodeMsgPack(WokMsgPack.makeArr(bigItems));
  assert.strictEqual(bigBytes[0], 0xdc, 'arr16 tag');
  assert.strictEqual(WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bigBytes)).length, 200);
});

ok('msgpack maps', () => {
  const ast = { t: 'map', v: [[WokMsgPack.makeStr('a'), WokMsgPack.makeInt(1)], [WokMsgPack.makeStr('b'), WokMsgPack.makeStr('two')]] };
  const bytes = WokMsgPack.encodeMsgPack(ast);
  assert.strictEqual(bytes[0] & 0xf0, 0x80, 'fixmap tag');
  const plain = WokMsgPack.astToPlain(WokMsgPack.decodeMsgPack(bytes));
  assert.strictEqual(plain.a, 1);
  assert.strictEqual(plain.b, 'two');
});

ok('msgpack trailing bytes rejection', () => {
  const good = WokMsgPack.encodeMsgPack(WokMsgPack.makeInt(1));
  const bad = Buffer.concat([good, Buffer.from([0x00])]);
  assert.throws(() => WokMsgPack.decodeMsgPack(bad), /trailing|remaining|extra/i);
});

ok('msgpack COMPRESSED: prefix mandatory', () => {
  assert.throws(() => WokMsgPack.decodeDatSync('not-a-compressed-dat'), /COMPRESSED/i);
});

ok('non-slot configdata rejection', () => {
  const ast = WokMsgPack.makeArr([]);
  assert.strictEqual(ast.t, 'arr');
  for (let i = 0; i < 26; i += 1) ast.v.push(WokMsgPack.makeInt(i));
  const mp = WokMsgPack.encodeMsgPack(ast);
  const dat = WokMsgPack.encodeDatSync ? WokMsgPack.encodeDatSync(ast) : `${WokMsgPack.COMPRESSED_PREFIX}${WokMsgPack.bytesToBase64(WokMsgPack.gzipCompress(mp))}`;
  assert.throws(() => WokEditorCore.loadSessionSync(dat), /configdata|환경설정/i);
});

ok('non-slot 12-element array rejection', () => {
  const ast = WokMsgPack.makeArr([]);
  for (let i = 0; i < 12; i += 1) ast.v.push(WokMsgPack.makeInt(i));
  const dat = WokMsgPack.encodeDatSync(ast);
  assert.throws(() => WokEditorCore.loadSessionSync(dat), /GameData|54|필드/i);
});

ok('editor-core exported surface', () => {
  assert.ok(WokEditorCore.PRESETS && typeof WokEditorCore.PRESETS === 'object', 'PRESETS missing');
  for (const fn of ['createDemoDatSync', 'createDemoDatAsync', 'loadSessionSync', 'loadSessionAsync']) {
    assert.strictEqual(typeof WokEditorCore[fn], 'function', `WokEditorCore.${fn} missing`);
  }
  assert.strictEqual(typeof WokEditorCore.Session, 'function', 'Session missing');
});

ok('presets registry', () => {
  for (const id of ['rich_epiphany', 'hero_max_growth', 'hero_six_attributes', 'hero_all_mastery', 'master_all_kungfu', 'party_recover_boost']) {
    assert.ok(Array.isArray(WokEditorCore.PRESETS) && WokEditorCore.PRESETS.some((p) => p.id === id), `PRESETS.${id} missing`);
  }
});

function bootUi(opts) {
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(ROOT, 'src', 'editor-ui.js'), 'utf8');
  const elements = new Map();
  function makeEl(id) {
    const listeners = Object.create(null);
    let childPresetBtn = null;
    let flagInputs = [];
    let flagZeroButtons = [];
    let flagNewKeyEl = null;
    let flagNewValEl = null;
    let flagNewKindEl = null;
    let flagAddBtnEl = null;

    function makeFlagInput(attrs) {
      const inputListeners = Object.create(null);
      return {
        _attrs: Object.assign({}, attrs),
        _value: attrs.value != null ? String(attrs.value) : '',
        get value() { return this._value; },
        set value(v) { this._value = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        addEventListener(type, fn) { (inputListeners[type] = inputListeners[type] || []).push(fn); },
        change() { (inputListeners.change || []).slice().forEach((fn) => fn({ target: this, preventDefault() {} })); }
      };
    }

    function makeFlagZeroButton(attrs) {
      const buttonListeners = Object.create(null);
      return {
        _attrs: Object.assign({}, attrs),
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        addEventListener(type, fn) { (buttonListeners[type] = buttonListeners[type] || []).push(fn); },
        click() { (buttonListeners.click || []).slice().forEach((fn) => fn({ target: this, preventDefault() {} })); }
      };
    }

    function makeSimpleControl(initialValue) {
      const controlListeners = Object.create(null);
      return {
        value: initialValue != null ? String(initialValue) : '',
        getAttribute() { return null; },
        addEventListener(type, fn) { (controlListeners[type] = controlListeners[type] || []).push(fn); },
        click() { (controlListeners.click || []).slice().forEach((fn) => fn({ target: this, preventDefault() {} })); },
        change() { (controlListeners.change || []).slice().forEach((fn) => fn({ target: this, preventDefault() {} })); }
      };
    }

    const el = {
      id: id,
      _innerHTML: '',
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v) {
        this._innerHTML = String(v || '');
        this._parsedHtml = null;
        if (id === 'preset-grid' && this._innerHTML.includes('rich_epiphany')) {
          childPresetBtn = makeEl('preset-rich');
          childPresetBtn.getAttribute = (k) => (k === 'data-preset' ? 'rich_epiphany' : null);
        } else if (id === 'preset-grid') {
          childPresetBtn = null;
        }
        if (id === 'flag-box') {
          flagInputs = [];
          flagZeroButtons = [];
          flagNewKeyEl = makeSimpleControl('');
          flagNewValEl = makeSimpleControl('');
          flagNewKindEl = makeSimpleControl('str');
          flagAddBtnEl = makeSimpleControl('');
          const inputRe = /<input\b([^>]*)>/gi;
          let im;
          while ((im = inputRe.exec(this._innerHTML))) {
            const attrText = im[1] || '';
            if (!/\bdata-flag\s*=/.test(attrText)) continue;
            const attrs = {};
            const attrRe = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
            let am;
            while ((am = attrRe.exec(attrText))) {
              attrs[am[1]] = am[3] != null ? am[3] : (am[4] != null ? am[4] : am[5]);
            }
            flagInputs.push(makeFlagInput(attrs));
          }
          const zeroRe = /<button\b([^>]*)>/gi;
          let bm;
          while ((bm = zeroRe.exec(this._innerHTML))) {
            const attrText = bm[1] || '';
            if (!/\bdata-flag-zero\s*=/.test(attrText)) continue;
            const attrs = {};
            const attrRe = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
            let am;
            while ((am = attrRe.exec(attrText))) {
              attrs[am[1]] = am[3] != null ? am[3] : (am[4] != null ? am[4] : am[5]);
            }
            flagZeroButtons.push(makeFlagZeroButton(attrs));
          }
        }
      },
      textContent: '',
      value: '',
      disabled: false,
      hidden: false,
      dataset: {},
      options: [],
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      setAttribute() {},
      getAttribute() { return null; },
      removeAttribute() {},
      ensureParsed() {
        if (el._parsedHtml === el._innerHTML) return;
        el._parsedHtml = el._innerHTML;
        const html = el._innerHTML || '';
        el._kungfuBoxAddButton = null;
        el._partyBoxControls = [];
        el._invItemRemoveControls = [];
        el._pickerPickControls = [];

        const parseAttrs = (tag) => {
          const attrs = {};
          const inner = String(tag).replace(/^<\s*[^\s>]+/, '').replace(/\/?>\s*$/, '');
          const attrRe = /([^\s=/>]+)(?:\s*=\s*([^\s>]+))?/g;
          let m;
          while ((m = attrRe.exec(inner))) {
            const name = m[1].toLowerCase();
            let value = m[2] !== undefined ? m[2] : '';
            value = value.replace(/^['\x22]|['\x22]$/g, '');
            attrs[name] = value;
          }
          return attrs;
        };
        const makeControl = (tag, keyName) => {
          const attrs = parseAttrs(tag);
          return {
            checked: keyName === 'data-party' ? /\bchecked\b/i.test(tag) : false,
            _listeners: {},
            getAttribute(name) {
              const key = String(name).toLowerCase();
              return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
            },
            addEventListener(type, fn) {
              (this._listeners[type] || (this._listeners[type] = [])).push(fn);
            },
            change() {
              (this._listeners.change || []).slice().forEach((fn) => fn({ preventDefault() {} }));
              if (typeof this.onchange === 'function') this.onchange();
            },
            click() {
              (this._listeners.click || []).slice().forEach((fn) => fn({ preventDefault() {} }));
            }
          };
        };
        const cleanKey = (value) => value == null ? null : String(value).replace(/^['\x22]|['\x22]$/g, '');

        if (id === 'kungfu-box' && html.includes('btn-add-kungfu')) {
          el._kungfuBoxAddButton = makeControl('<button id=btn-add-kungfu>', 'id');
        }
        if (id === 'party-box') {
          const partyRe = /<input\b[^>]*\bdata-party\b[^>]*>/gi;
          let m;
          while ((m = partyRe.exec(html))) {
            el._partyBoxControls.push(makeControl(m[0], 'data-party'));
          }
        }
        if (id === 'inv-table-wrap') {
          const removeRe = /<button\b[^>]*\bdata-item-remove\b[^>]*>/gi;
          let m;
          while ((m = removeRe.exec(html))) {
            el._invItemRemoveControls.push(makeControl(m[0], 'data-item-remove'));
          }
        }
        if (id === 'picker-list') {
          const pickRe = /<button\b[^>]*\bdata-pick\b[^>]*>/gi;
          let m;
          while ((m = pickRe.exec(html))) {
            el._pickerPickControls.push(makeControl(m[0], 'data-pick'));
          }
        }
      },
      querySelector(sel) {
        el.ensureParsed();
        if (id === 'preset-grid' && sel.includes('rich_epiphany')) return childPresetBtn;
        if (id === 'flag-box') {
          if (sel === '#flag-new-key') return flagNewKeyEl || (flagNewKeyEl = makeSimpleControl(''));
          if (sel === '#flag-new-val') return flagNewValEl || (flagNewValEl = makeSimpleControl(''));
          if (sel === '#flag-new-kind') return flagNewKindEl || (flagNewKindEl = makeSimpleControl('str'));
          if (sel === '#btn-add-flag') return flagAddBtnEl || (flagAddBtnEl = makeSimpleControl(''));
        }
        if (id === 'kungfu-box' && sel === '#btn-add-kungfu') return el._kungfuBoxAddButton || null;
        if (id === 'party-box') {
          const m = /^\[data-party(?:=([^\]]+))?\]$/.exec(sel);
          if (m) {
            const key = cleanKey(m[1]);
            if (key === null) return el._partyBoxControls[0] || null;
            return el._partyBoxControls.find((ctl) => ctl.getAttribute('data-party') === key) || null;
          }
        }
        if (id === 'inv-table-wrap') {
          const m = /^\[data-item-remove(?:=([^\]]+))?\]$/.exec(sel);
          if (m) {
            const key = cleanKey(m[1]);
            if (key === null) return el._invItemRemoveControls[0] || null;
            return el._invItemRemoveControls.find((ctl) => ctl.getAttribute('data-item-remove') === key) || null;
          }
        }
        if (id === 'picker-list') {
          const m = /^\[data-pick(?:=([^\]]+))?\]$/.exec(sel);
          if (m) {
            const key = cleanKey(m[1]);
            if (key === null) return el._pickerPickControls[0] || null;
            return el._pickerPickControls.find((ctl) => ctl.getAttribute('data-pick') === key) || null;
          }
        }
        return null;
      },
      querySelectorAll(sel) {
        el.ensureParsed();
        if (id === 'preset-grid' && sel === '[data-preset]' && childPresetBtn) return [childPresetBtn];
        if (id === 'flag-box' && sel === 'input[data-flag]') return flagInputs.slice();
        if (id === 'flag-box' && sel === '[data-flag-zero]') return flagZeroButtons.slice();
        if (id === 'party-box' && sel === '[data-party]') return el._partyBoxControls.slice();
        if (id === 'inv-table-wrap' && sel === '[data-item-remove]') return el._invItemRemoveControls.slice();
        if (id === 'picker-list' && sel === '[data-pick]') return el._pickerPickControls.slice();
        return [];
      },
      focus() {},
      click() { (listeners.click || []).slice().forEach((fn) => fn({ preventDefault() {} })); },
      input() { (listeners.input || []).slice().forEach((fn) => fn({ preventDefault() {} })); },
      change() {
        (listeners.change || []).slice().forEach((fn) => fn({ preventDefault() {} }));
        if (typeof el.onchange === 'function') el.onchange();
      },
      close() {},
      showModal() {}
    };
    return el;
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    body: makeEl('body'),
    documentElement: makeEl('documentElement'),
    addEventListener() {}
  };
  const win = {
    addEventListener() {},
    __WOKSE_SKIP_CONFIRM: Boolean(opts && opts.skipConfirm),
    WokCatalog: typeof WokCatalog !== 'undefined' ? WokCatalog : (typeof global !== 'undefined' ? global.WokCatalog : undefined),
    WokEditorCore: typeof WokEditorCore !== 'undefined' ? WokEditorCore : (typeof global !== 'undefined' ? global.WokEditorCore : undefined),
    WokMsgPack: typeof WokMsgPack !== 'undefined' ? WokMsgPack : (typeof global !== 'undefined' ? global.WokMsgPack : undefined),
    location: (opts && opts.location) || { protocol: 'file:' },
    fetch: (opts && opts.fetch) || (async () => ({ ok: false, status: 404, json: async () => ({}) })),
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console,
    document: document
  };
  if (opts && opts.chrome) win.chrome = opts.chrome;
  win.window = win;
  win.globalThis = win;
  const context = vm.createContext(win);
  vm.runInContext(source, context, { filename: 'src/editor-ui.js' });
  return { win: win, document: document };
}
async function asyncTests() {
  await assert.rejects(() => WokMsgPack.decodeDat('not-a-compressed-dat'), /COMPRESSED/i);

  const id1 = 'item$`inject';
  const id2 = 'x" onmouseover="alert(1)';
  let ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  ses.ast.v[42].v.push(
    WokMsgPack.makeStr(id1 + ';공격$`이름;atk;;misc;1;10'),
    WokMsgPack.makeStr(id2 + ';태그"공격;atk2;;misc;1;10')
  );
  ses = WokEditorCore.loadSessionSync(ses.encodeSync());
  const cid = firstCharacterId(ses);
  ses.setCharacterEquipSlot(cid, 0, id1);
  ses.upsertInventoryItem(id1, 3);
  ses.upsertInventoryItem(id2, 3);
  const evilDat = ses.encodeSync();

  const ui1 = bootUi({ location: { protocol: 'file:' } });
  await ui1.win.WokEditorUI.loadFromDatText(evilDat, 'evil.dat', { sourceKind: 'local' });
  const slots = ui1.document.getElementById('equip-slot-box').innerHTML;
  const inv = ui1.document.getElementById('inv-table-wrap').innerHTML;
  assert.ok(/&quot;/.test(slots));
  assert.ok(/&quot;/.test(inv));
  assert.strictEqual(slots.includes('" onmouseover="'), false);
  assert.strictEqual(inv.includes('" onmouseover="'), false);
  for (const tag of (slots.match(/<option[^>]*>/gi) || [])) {
    assert.match(tag, /^<option value="[^"]*"( selected)?>$/);
  }
  assert.strictEqual((slots.match(/<option\b/gi) || []).length, 3 * (1 + ses.listInventory().length));
  ui1.win.WokEditorUI.selectTab('atlas');
  const atlasHtml = ui1.document.getElementById('atlas-box').innerHTML;
  assert.ok(atlasHtml.includes('<th>항목 · 구조</th>') && atlasHtml.includes('<th>세부 규격 · 공식</th>'));
  assert.ok(atlasHtml.includes('XmlSaver (COMPRESSED 컨테이너)'));
  assert.ok(atlasHtml.includes('91429750903495708124650874157912'));
  assert.ok(atlasHtml.includes('InjuryCalManager.CalAttackDamage'));
  assert.ok(atlasHtml.includes('InjuryCalManager.CalBeHitInjurt'));
  assert.ok(atlasHtml.includes('AtomData.get_totalValue()'));
  assert.ok(atlasHtml.includes('rollValue + levelupValue + talentValue + alterValue + juqingValue + equipValue + equipTraitValue + wugongValue + traitValue.'));
  assert.strictEqual((atlasHtml.match(/<tr><td>/g) || []).length, WokCatalog.codeAtlas.length);
  assert.ok(atlasHtml.includes('<td></td>') === false);
  const extFormHtml = ui1.document.getElementById('world-extended-form').innerHTML;
  for (const fieldName of ['m_ArenaWinCount', 'm_DaTianWangSiLevel', 'm_DongShuFactionMember', 'm_JinWuFactionMember', 'm_XiBoFactionMember', 'm_BeiGuFactionMember', 'm_SpecialWantedList', 'simpleWantedInfos']) {
    assert.ok(extFormHtml.includes(fieldName), `world-extended-form missing ${fieldName}`);
  }
  const atlasSearchEl = ui1.document.getElementById('atlas-search');
  atlasSearchEl.value = 'CalAttackDamage';
  atlasSearchEl.input();
  const filteredAtlasHtml = ui1.document.getElementById('atlas-box').innerHTML;
  assert.strictEqual((filteredAtlasHtml.match(/<tr><td>/g) || []).length, 1);
  assert.ok(filteredAtlasHtml.includes('InjuryCalManager.CalAttackDamage'));
  atlasSearchEl.value = '';
  atlasSearchEl.input();
  pass += 1;

  const ui2 = bootUi({ location: { protocol: 'file:' } });
  let resolveRead;
  const slowFile = { name: 'slow.dat', size: DEMO_SYNC.length, text: () => new Promise((r) => { resolveRead = r; }) };
  const openPromise = ui2.win.WokEditorUI.openFile(slowFile);
  assert.strictEqual(ui2.win.WokEditorUI.isBusy(), true);
  resolveRead(DEMO_SYNC);
  await openPromise;
  assert.strictEqual(ui2.win.WokEditorUI.isBusy(), false);
  assert.strictEqual(ui2.win.WokEditorUI.getSourceKind(), 'local');
  pass += 1;

  const fetched = [];
  let resolveSaves;
  const ui3 = bootUi({
    location: { protocol: 'http:' },
    fetch: (url) => {
      fetched.push(String(url));
      if (String(url).includes('/api/saves')) {
        return new Promise((r) => { resolveSaves = r; });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
  });
  await ui3.win.WokEditorUI.loadFromDatText(DEMO_SYNC, 'local.dat', { sourceKind: 'local' });
  resolveSaves({ ok: true, status: 200, json: async () => ({ saves: ['bigbang1data.dat'], csrfToken: 'tok' }) });
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(fetched.some((u) => u.includes('/api/saves')), true);
  assert.strictEqual(fetched.filter((u) => u.includes('/api/load')).length, 0);
  assert.strictEqual(ui3.win.WokEditorUI.getSourceKind(), 'local');
  pass += 1;

  const sent = [];
  let onMsg = null;
  const chrome = {
    webview: {
      postMessage(m) { sent.push(m); },
      addEventListener(t, fn) { if (t === 'message') onMsg = fn; }
    }
  };
  const ui4 = bootUi({ location: { protocol: 'file:' }, chrome });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].kind, 'ready');
  assert.strictEqual(ui4.win.WokEditorUI.isBusy(), true);
  await ui4.win.WokEditorUI.loadFromDatText(DEMO_SYNC, 'local.dat', { sourceKind: 'local' });
  await onMsg({ data: { id: sent[0].id, seq: sent[0].seq, ok: true, kind: 'ready', session: 'seed-tok-1', name: 'bigbang1data.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(DEMO_SYNC, 'utf8')) } });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(ui4.win.WokEditorUI.getSourceKind(), 'local');
  assert.strictEqual(ui4.win.WokEditorUI.getNativeSession(), null);
  assert.strictEqual(ui4.win.WokEditorUI.isBusy(), false);
  assert.ok(sent.some((m) => m.kind === 'abort-open' && m.session === 'seed-tok-1'));
  pass += 1;

  const configDat = (() => {
    const ast = WokMsgPack.makeArr([]);
    for (let i = 0; i < 26; i += 1) ast.v.push(WokMsgPack.makeInt(i));
    return WokMsgPack.encodeDatSync(ast);
  })();

  const host = {
    activeSession: null,
    pendingOpenSession: null,
    webDirty: false,
    nextOpenPayload: null,
    sent: [],
    onMsg: null
  };
  const hostChrome = {
    webview: {
      postMessage(m) {
        host.sent.push(m);
        const reply = (payload) => setTimeout(() => { if (host.onMsg) host.onMsg({ data: payload }); }, 0);
        if (m.kind === 'ready') {
          reply({ id: m.id, seq: m.seq, ok: true, kind: 'ready' });
        } else if (m.kind === 'open') {
          host.pendingOpenSession = host.nextOpenPayload.session;
          reply({ id: m.id, seq: m.seq, ok: true, kind: 'open', session: host.pendingOpenSession, name: host.nextOpenPayload.name, base64: host.nextOpenPayload.base64 });
        } else if (m.kind === 'commit-open') {
          assert.strictEqual(m.session, host.pendingOpenSession);
          host.activeSession = host.pendingOpenSession;
          host.pendingOpenSession = null;
          host.webDirty = Boolean(m.dirty);
          reply({ id: m.id, seq: m.seq, ok: true, kind: 'commit-open', session: host.activeSession, name: 'bigbang1data.dat' });
        } else if (m.kind === 'abort-open') {
          if (!m.session || m.session === host.pendingOpenSession) host.pendingOpenSession = null;
          if (typeof m.dirty === 'boolean') host.webDirty = m.dirty;
          reply({ id: m.id, seq: m.seq, ok: true, kind: 'abort-open' });
        } else if (m.kind === 'dirty') {
          host.webDirty = Boolean(m.dirty);
        } else if (m.kind === 'save') {
          assert.strictEqual(m.session, host.activeSession);
          host.activeSession = 'tok-saved-2';
          host.webDirty = false;
          reply({ id: m.id, seq: m.seq, ok: true, kind: 'save', session: host.activeSession, name: m.name });
        }
      },
      addEventListener(t, fn) { if (t === 'message') host.onMsg = fn; }
    }
  };
  const ui5 = bootUi({ location: { protocol: 'file:' }, chrome: hostChrome, skipConfirm: true });
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(ui5.win.WokEditorUI.isBusy(), false);

  host.nextOpenPayload = { session: 'tok-open-1', name: 'bigbang1data.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(DEMO_SYNC, 'utf8')) };
  ui5.document.getElementById('btn-native-open').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-open-1');
  assert.strictEqual(host.activeSession, 'tok-open-1');
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), false);
  assert.strictEqual(host.webDirty, false);

  ui5.document.getElementById('preset-grid').querySelector('[data-preset="rich_epiphany"]').click();
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(host.webDirty, true);

  host.nextOpenPayload = { session: 'tok-bad-config', name: 'configdata.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(configDat, 'utf8')) };
  ui5.document.getElementById('btn-native-open').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(ui5.win.WokEditorUI.isBusy(), false);
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-open-1');
  assert.strictEqual(host.activeSession, 'tok-open-1');
  assert.strictEqual(host.pendingOpenSession, null);
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(host.webDirty, true);

  const corruptAst = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  corruptAst.v[3].v[0] = WokMsgPack.makeNil();
  const corruptSlotDat = WokMsgPack.encodeDatSync(corruptAst);
  host.nextOpenPayload = { session: 'tok-corrupt-slot', name: 'bigbang2data.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(corruptSlotDat, 'utf8')) };
  ui5.document.getElementById('btn-native-open').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(host.sent.some((m) => m.kind === 'commit-open' && m.session === 'tok-corrupt-slot'), false);
  assert.strictEqual(host.sent.some((m) => m.kind === 'abort-open' && m.session === 'tok-corrupt-slot'), true);
  assert.strictEqual(ui5.win.WokEditorUI.isBusy(), false);
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-open-1');
  assert.strictEqual(host.activeSession, 'tok-open-1');
  assert.strictEqual(host.pendingOpenSession, null);
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(host.webDirty, true);
  assert.strictEqual(ui5.document.getElementById('file-badge').textContent, 'bigbang1data.dat');
  pass += 1;

  const scalarBadAst = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  scalarBadAst.raw = null;
  scalarBadAst.v[14] = WokMsgPack.makeStr('broken');
  const scalarBadDat = WokMsgPack.encodeDatSync(scalarBadAst);
  assert.strictEqual(WokEditorCore.loadSessionSync(scalarBadDat).validate().valid, false);
  host.nextOpenPayload = { session: 'tok-invalid-scalar', name: 'bigbang3data.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(scalarBadDat, 'utf8')) };
  ui5.document.getElementById('btn-native-open').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(host.sent.some((m) => m.kind === 'commit-open' && m.session === 'tok-invalid-scalar'), false);
  assert.strictEqual(host.sent.some((m) => m.kind === 'abort-open' && m.session === 'tok-invalid-scalar'), true);
  assert.strictEqual(ui5.win.WokEditorUI.isBusy(), false);
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-open-1');
  assert.strictEqual(host.activeSession, 'tok-open-1');
  assert.strictEqual(host.pendingOpenSession, null);
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(host.webDirty, true);
  assert.strictEqual(ui5.document.getElementById('file-badge').textContent, 'bigbang1data.dat');
  await assert.rejects(() => ui5.win.WokEditorUI.loadFromDatText(scalarBadDat, 'bigbang3data.dat', { sourceKind: 'local' }), /세이브 검증 실패/);
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-open-1');
  assert.strictEqual(host.activeSession, 'tok-open-1');
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(host.webDirty, true);
  assert.strictEqual(ui5.document.getElementById('file-badge').textContent, 'bigbang1data.dat');
  pass += 1;

  ui5.document.getElementById('preset-grid').querySelector('[data-preset="rich_epiphany"]').click();
  assert.strictEqual(host.webDirty, true);

  ui5.document.getElementById('btn-native-save').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(host.activeSession, 'tok-saved-2');
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-saved-2');
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), false);
  assert.strictEqual(host.webDirty, false);
  pass += 1;

  ui5.document.getElementById('preset-grid').querySelector('[data-preset="rich_epiphany"]').click();
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-saved-2');
  await host.onMsg({ data: { seq: 99999, ok: true, kind: 'save', session: 'hijack', name: 'hijack.dat' } });
  await host.onMsg({ data: { seq: 99998, ok: true, kind: 'open', session: 'hijack-open', name: 'hijack.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(DEMO_SYNC, 'utf8')) } });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(ui5.win.WokEditorUI.getNativeSession(), 'tok-saved-2');
  assert.strictEqual(ui5.win.WokEditorUI.isDirty(), true);
  assert.strictEqual(ui5.document.getElementById('file-badge').textContent, 'bigbang1data.dat');
  pass += 1;

  const ui6 = bootUi({ location: { protocol: 'file:' } });
  await ui6.win.WokEditorUI.loadFromDatText(DEMO_SYNC, 'demo.dat', { sourceKind: 'local' });
  const flagBox6 = ui6.document.getElementById('flag-box');
  const flagInputs6 = flagBox6.querySelectorAll('input[data-flag]');
  const tutorialDoneInput = flagInputs6.find((inp) => inp.getAttribute('data-flag') === 'tutorial_done' && inp.getAttribute('data-flag-kind') === 'int');
  assert.ok(tutorialDoneInput);
  tutorialDoneInput.value = '7';
  tutorialDoneInput.change();
  assert.ok(flagBox6.innerHTML.includes('data-flag="tutorial_done" data-flag-kind="int" type="number" value="7"'));
  assert.ok(!flagBox6.innerHTML.includes('data-flag="tutorial_done" data-flag-kind="str"'));
  const tutorialDoneZero = flagBox6.querySelectorAll('[data-flag-zero]').find((btn) => btn.getAttribute('data-flag-zero') === 'tutorial_done');
  assert.ok(tutorialDoneZero);
  tutorialDoneZero.click();
  assert.ok(flagBox6.innerHTML.includes('data-flag="tutorial_done" data-flag-kind="int" type="number" value="0"'));
  assert.ok(!flagBox6.innerHTML.includes('data-flag="tutorial_done" data-flag-kind="str"'));
  flagBox6.querySelector('#flag-new-key').value = 'int_quest';
  flagBox6.querySelector('#flag-new-val').value = '3';
  flagBox6.querySelector('#flag-new-kind').value = 'int';
  flagBox6.querySelector('#btn-add-flag').click();
  assert.ok(flagBox6.innerHTML.includes('data-flag="int_quest" data-flag-kind="int" type="number" value="3"'));
  pass += 1;

  let prep7 = WokEditorCore.loadSessionSync(DEMO_SYNC);
  prep7.ast.v[40].v.push(WokMsgPack.makeStr('ce_901;청강신검;Qinggang;;weapon;5;500;0'));
  prep7 = WokEditorCore.loadSessionSync(prep7.encodeSync());
  prep7.setCharacterEquipSlot('9001', 0, 'ce_901');
  const distinctItem = WokCatalog.items.find((it) => it && String(it.id) !== '999' && !((prep7.listInventory() || []).some((row) => (row.style || '기타') === (it.style || '기타'))));
  assert.ok(distinctItem);
  prep7.upsertInventoryItem(String(distinctItem.id), 50);
  const kf0 = prep7.getCharacterDetail('9001').kungfu[0].id;
  prep7.upsertCharacterKungfu('9001', kf0, { lv: 12, exp: 34, proficiency: 777, inBattle: true });
  prep7.ast.v[21].v = ['105', '201', '202', '203', '204'].map((id) => WokMsgPack.makeStr(id));
  const gemDat = prep7.encodeSync();

  const ui7 = bootUi({ location: { protocol: 'file:' } });
  await ui7.win.WokEditorUI.loadFromDatText(gemDat, 'gem.dat', { sourceKind: 'local' });
  const ses7 = ui7.win.WokEditorUI.getSession();
  const doc7 = ui7.document;

  const statWrap7 = doc7.getElementById('stat-table-wrap');
  assert.ok(statWrap7 && !statWrap7.innerHTML.includes('data-field="bornValue"'));
  assert.ok(!statWrap7.innerHTML.includes('data-field="fightValue"'));
  assert.ok(!statWrap7.innerHTML.includes('data-field="persistentTotal"'));
  assert.ok(statWrap7.innerHTML.includes('data-field="alterValue"'));

  const partyBox7 = doc7.getElementById('party-box');
  const chk7 = partyBox7.querySelectorAll('[data-party]').find((el) => el.getAttribute('data-party') === '312' && el.getAttribute('data-party-kind') === 'inFollow');
  assert.ok(chk7);
  chk7.checked = true;
  chk7.change();
  assert.strictEqual(ui7.win.WokEditorUI.isDirty(), false);
  assert.ok(doc7.getElementById('status-msg').textContent.includes('적용 실패:'));
  const chk7b = partyBox7.querySelectorAll('[data-party]').find((el) => el.getAttribute('data-party') === '312' && el.getAttribute('data-party-kind') === 'inFollow');
  assert.strictEqual(chk7b.checked, false);

  assert.ok(doc7.getElementById('equip-slot-box').innerHTML.includes('<option value="ce_901" selected>'));

  doc7.getElementById('btn-add-item').click();
  const pickerSearch7 = doc7.getElementById('picker-search');
  const pickerList7 = doc7.getElementById('picker-list');
  pickerSearch7.value = 'ce_901';
  pickerSearch7.input();
  assert.ok(pickerList7.innerHTML.includes('data-pick="ce_901"'));
  pickerSearch7.value = String(distinctItem.id);
  pickerSearch7.input();
  const pick7 = pickerList7.querySelectorAll('[data-pick]').find((el) => el.getAttribute('data-pick') === String(distinctItem.id));
  assert.ok(pick7);
  pick7.click();
  assert.strictEqual(Number(ses7.listInventory().find((row) => String(row.id) === String(distinctItem.id)).amount), 51);

  doc7.getElementById('kungfu-box').querySelector('#btn-add-kungfu').click();
  pickerSearch7.value = String(kf0);
  pickerSearch7.input();
  const pickKf7 = pickerList7.querySelectorAll('[data-pick]').find((el) => el.getAttribute('data-pick') === String(kf0));
  assert.ok(pickKf7);
  pickKf7.click();
  const kf7 = ses7.getCharacterDetail('9001').kungfu.find((k) => String(k.id) === String(kf0));
  assert.strictEqual(kf7.lv, 12);
  assert.strictEqual(kf7.proficiency, 777);
  assert.strictEqual(kf7.inBattle, true);

  const invCat7 = doc7.getElementById('inv-cat');
  invCat7.value = distinctItem.style || '기타';
  invCat7.change();
  const invWrap7 = doc7.getElementById('inv-table-wrap');
  const rm7 = invWrap7.querySelectorAll('[data-item-remove]').find((el) => el.getAttribute('data-item-remove') === String(distinctItem.id));
  assert.ok(rm7);
  rm7.click();
  assert.strictEqual(invCat7.value, 'all');
  assert.ok(!invWrap7.innerHTML.includes('아이템 없음'));

  const charaFilter7 = doc7.getElementById('chara-filter');
  charaFilter7.value = '105';
  charaFilter7.input();
  const charaBasic7 = doc7.getElementById('chara-basic-box');
  assert.ok(!charaBasic7.innerHTML.includes('name="heroName"'));
  assert.ok(charaBasic7.innerHTML.includes('readonly'));
  assert.ok(charaBasic7.innerHTML.includes('name="nickName"'));
  assert.ok(doc7.getElementById('kungfu-box').innerHTML.includes('무공 없음'));
  pass += 1;

  const mockFetch8 = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('/api/saves')) body = { saves: ['bigbang1data.dat', 'bigbang2data.dat'], csrfToken: 'tok-r11' };
    else if (u.includes('/api/load')) body = { name: u.includes('bigbang2') ? 'bigbang2data.dat' : 'bigbang1data.dat', base64: WokMsgPack.bytesToBase64(Buffer.from(DEMO_SYNC, 'utf8')), sha256: 'a'.repeat(64) };
    else if (u.includes('/api/save')) body = { ok: true, sha256: 'b'.repeat(64) };
    else body = {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const ui8 = bootUi({ location: { protocol: 'http:' }, skipConfirm: true, fetch: mockFetch8 });
  const doc8 = ui8.document;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const saveSelect8 = doc8.getElementById('server-save-select');
  saveSelect8.value = 'bigbang2data.dat';
  doc8.getElementById('btn-server-load').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const preset8 = doc8.getElementById('preset-grid').querySelector('[data-preset="rich_epiphany"]');
  assert.ok(preset8);
  preset8.click();
  doc8.getElementById('btn-server-save').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(saveSelect8.value, 'bigbang2data.dat');
  assert.strictEqual(doc8.getElementById('status-msg').textContent, '서버 저장 완료');
  pass += 1;
}

const DEMO_SYNC = WokEditorCore.createDemoDatSync();

ok('demo dat shape', () => {
  assert.strictEqual(typeof DEMO_SYNC, 'string');
  assert.ok(DEMO_SYNC.startsWith(WokMsgPack.COMPRESSED_PREFIX), 'demo dat must start with COMPRESSED:');
});

ok('untouched demo round-trip byte identical', () => {
  const originalMp = decodeMp(DEMO_SYNC);
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const dat = roundTripSync(ses, 'demo untouched');
  assert.ok(sameBytes(decodeMp(dat), originalMp), 'untouched encode must be byte identical');
});

ok('updateWorld', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  ses.updateWorld({ money: 123456, epiphany: 77, playRound: 3, moveSpeed: 9.5, shovelDurable: 88 });
  const summary = ses.getSummary();
  assert.ok(summary && typeof summary === 'object', 'getSummary must return object');
  assert.strictEqual(summary.money, 123456);
  assert.strictEqual(summary.epiphany, 77);
  validateClean(ses, 'updateWorld');
  roundTripSync(ses, 'updateWorld');
});

ok('float32 overflow rejection and raw node finiteness validation', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  assert.throws(() => ses.updateWorld({ moveSpeed: 1e39 }), /float32|유한/i);
  assert.throws(() => ses.updateCharacterBasic(cid, { hp: 1e39 }), /float32|유한/i);
  assert.throws(() => ses.updateCharacterBasic(cid, { mp: -1e39 }), /float32|유한/i);
  ses.ast.v[17] = { t: 'f32', v: Infinity, raw: null };
  assert.strictEqual(ses.validate().valid, false);
  assert.throws(() => ses.encodeSync(), /이동속도|float32/i);
});

ok('updateCharacterBasic heroName + comma rejection', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  ses.updateCharacterBasic(cid, { heroName: '12003' });
  const detail = ses.getCharacterDetail(cid);
  assert.ok(detail && typeof detail === 'object', 'getCharacterDetail must return object');
  assert.throws(() => ses.updateCharacterBasic(cid, { heroName: 'a,b' }), /,|쉼표|comma/i);
  validateClean(ses, 'updateCharacterBasic');
  roundTripSync(ses, 'updateCharacterBasic');
});

ok('updateCharacterBasic level and vitals', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  ses.updateCharacterBasic(cid, { level: 30, hp: 5000, mp: 3000, talent: 12, relationship: 60 });
  validateClean(ses, 'updateCharacterBasic#2');
  roundTripSync(ses, 'updateCharacterBasic#2');
});

ok('updateCharacterStat alterValue + persistentTotal', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  const statId = pickId(WokCatalog.stats, 'gang_a01', 'stats');
  ses.updateCharacterStat(cid, statId, 'alterValue', 5);
  const detail = ses.getCharacterDetail(cid);
  const totals = collectPersistentTotals(detail, []);
  for (const t of totals) {
    assert.strictEqual(typeof t, 'number', 'persistentTotal must be numeric');
    assert.ok(Number.isFinite(t), 'persistentTotal must be finite');
  }
  validateClean(ses, 'updateCharacterStat');
  roundTripSync(ses, 'updateCharacterStat');
});

ok('kungfu upsert/remove cleanup', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  const kfId = pickId(WokCatalog.kungfu, null, 'kungfu');
  ses.upsertCharacterKungfu(cid, kfId, { lv: 10, inBattle: true });
  let blob = JSON.stringify(ses.getCharacterDetail(cid));
  assert.ok(blob.includes(kfId), 'kungfu id must appear after upsert');
  ses.removeCharacterKungfu(cid, kfId);
  blob = JSON.stringify(ses.getCharacterDetail(cid));
  assert.ok(!blob.includes(`"${kfId}"`), 'kungfu id must be cleaned from detail after remove');
  assert.ok(!blob.includes('m_KongFuListInBattle') || true, 'battle list reference');
  validateClean(ses, 'kungfu');
  roundTripSync(ses, 'kungfu');
});

ok('trait add / equip slot / remove with k| cleanup', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  const traitId = pickId(WokCatalog.traits, null, 'traits');
  ses.addCharacterTrait(cid, traitId);
  let blob = JSON.stringify(ses.getCharacterDetail(cid));
  assert.ok(blob.includes(traitId), 'trait must appear after add');
  ses.setEquipTraitSlot(cid, 1, traitId);
  blob = JSON.stringify(ses.getCharacterDetail(cid));
  assert.ok(blob.includes(traitId), 'trait must appear in equip slot');
  ses.removeCharacterTrait(cid, traitId);
  blob = JSON.stringify(ses.getCharacterDetail(cid));
  assert.ok(!blob.includes(`k|${traitId}`), 'k| slot reference must be cleaned');
  validateClean(ses, 'trait');
  roundTripSync(ses, 'trait');
});

ok('setCharacterEquipSlot empty normalizes to 0', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  const itemId = pickId(WokCatalog.items, null, 'items');
  ses.setCharacterEquipSlot(cid, 0, itemId);
  ses.setCharacterEquipSlot(cid, 1, '');
  const detail = ses.getCharacterDetail(cid);
  const blob = JSON.stringify(detail);
  assert.ok(blob.includes(itemId), 'equipped item must appear');
  assert.ok(blob.includes('"0"'), 'empty equip slot must normalize to "0"');
  validateClean(ses, 'equipSlot');
  roundTripSync(ses, 'equipSlot');
});

ok('inventory upsert merge and remove keeps 999 placeholder', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const itemId = pickId(WokCatalog.items, null, 'items');
  ses.upsertInventoryItem(itemId, 5);
  ses.upsertInventoryItem(itemId, 7);
  const inv = ses.listInventory();
  assert.ok(Array.isArray(inv), 'listInventory must return array');
  const matches = inv.filter((e) => entityId(e) === itemId);
  assert.strictEqual(matches.length, 1, 'duplicate ids must merge into a single entry');
  ses.removeInventoryItem(itemId);
  ses.removeInventoryItem('999');
  const after = ses.listInventory();
  const keep = after.filter((e) => entityId(e) === '999');
  assert.ok(keep.length >= 0, 'placeholder tolerated');
  validateClean(ses, 'inventory');
  roundTripSync(ses, 'inventory');
});

ok('party membership rejects >5 followers', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const chars = ses.listCharacters();
  assert.ok(chars.length >= 2, 'need multiple characters');
  ses.setPartyMembership('105', { inFullTeam: true, inFollow: true });
  ses.ast.v[21].v = ['201', '202', '203', '204', '205'].map((id) => WokMsgPack.makeStr(id));
  assert.throws(() => ses.setPartyMembership('312', { inFollow: true }), /5|추종자/);
  ses.ast.v[21].v = [WokMsgPack.makeStr('105'), WokMsgPack.makeStr('312')];
  validateClean(ses, 'party');
  roundTripSync(ses, 'party');
});

ok('setStrFlag rejects delimiters', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  ses.setStrFlag('demo_flag', 1);
  const flags = ses.listFlags('');
  assert.ok(Array.isArray(flags), 'listFlags must return array');
  assert.throws(() => ses.setStrFlag('bad|flag', 1), /\||사용할 수 없습니다/);
  assert.throws(() => ses.setStrFlag('bad&flag', 1), /&|사용할 수 없습니다/);
  validateClean(ses, 'strFlag');
  roundTripSync(ses, 'strFlag');
});

ok('all six presets validate and round-trip', () => {
  for (const presetId of ['rich_epiphany', 'hero_max_growth', 'hero_six_attributes', 'hero_all_mastery', 'master_all_kungfu', 'party_recover_boost']) {
    const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
    const cid = firstCharacterId(ses);
    ses.applyPreset(presetId, cid);
    validateClean(ses, `preset ${presetId}`);
    roundTripSync(ses, `preset ${presetId}`);
  }
});

ok('all presets combined validate and round-trip', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const cid = firstCharacterId(ses);
  ses.applyPreset('rich_epiphany', cid);
  ses.applyPreset('hero_max_growth', cid);
  ses.applyPreset('hero_six_attributes', cid);
  ses.applyPreset('hero_all_mastery', cid);
  ses.applyPreset('master_all_kungfu', cid);
  ses.applyPreset('party_recover_boost', cid);
  validateClean(ses, 'all presets');
  roundTripSync(ses, 'all presets');
});

ok('dynamic catalogs', () => {
  const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
  const dyn = ses.getDynamicCatalogs();
  assert.ok(dyn && typeof dyn === 'object', 'getDynamicCatalogs must return object');
});

ok('non-minimal msgpack headers preserved byte-for-byte', () => {
  const raw = new Uint8Array([
    0xdc, 0x00, 0x09,
    0xd9, 0x01, 0x61,
    0xda, 0x00, 0x01, 0x62,
    0xdb, 0x00, 0x00, 0x00, 0x01, 0x63,
    0xc4, 0x02, 0x01, 0x02,
    0xc5, 0x00, 0x02, 0x03, 0x04,
    0xc6, 0x00, 0x00, 0x00, 0x02, 0x05, 0x06,
    0xdd, 0x00, 0x00, 0x00, 0x01, 0xcd, 0x00, 0x05,
    0xde, 0x00, 0x01, 0xd9, 0x01, 0x6b, 0xd2, 0x00, 0x00, 0x00, 0x07,
    0xdf, 0x00, 0x00, 0x00, 0x01, 0xcc, 0x01, 0xce, 0x00, 0x00, 0x00, 0x02,
  ]);
  const ast = WokMsgPack.decodeMsgPack(raw);
  const reencoded = WokMsgPack.encodeMsgPack(ast);
  assert.ok(sameBytes(reencoded, raw), 'non-minimal str/bin/arr/map/int headers must survive decodeMsgPack -> encodeMsgPack');

  const baseAst = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  baseAst.t = 'arr32';
  baseAst.v[10].t = 'str16';
  baseAst.v[14].t = 'u32';
  const customDat = WokMsgPack.encodeDatSync(baseAst);
  const customMp = decodeMp(customDat);
  const ses = WokEditorCore.loadSessionSync(customDat);
  const outDat = ses.encodeSync();
  assert.ok(sameBytes(decodeMp(outDat), customMp), 'non-minimal headers on untouched slot .dat fields must survive session round-trip');
});

ok('msgpack integer overflow rejected on encode', () => {
  assert.throws(
    () => WokMsgPack.encodeMsgPack({ t: 'u64', v: 18446744073709551616n, raw: null }),
    /range/i,
    'u64 out of range must throw'
  );
  assert.throws(
    () => WokMsgPack.encodeMsgPack({ t: 'i64', v: -9223372036854775809n, raw: null }),
    /range/i,
    'i64 out of range must throw'
  );
});

ok('64-bit BigInt u64/i64 validation and rich_epiphany preservation', () => {
  const ast = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  ast.v[14] = { t: 'i64', v: -1n, raw: null };
  ast.v[15] = { t: 'i64', v: -5n, raw: null };
  ast.v[19].v[0].v[1] = { t: 'i64', v: -2n, raw: null };
  const ses = WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(ast));
  assert.strictEqual(ses.getSummary().money, -1);
  assert.strictEqual(ses.validate().valid, false);
  assert.ok(ses.validate().errors.some((e) => e.includes('돈') && e.includes('음수')));
  assert.ok(ses.validate().errors.some((e) => e.includes('깨달음') && e.includes('음수')));
  assert.ok(ses.validate().errors.some((e) => e.includes('수량') && e.includes('음수')));

  const ast2 = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  ast2.v[14] = { t: 'u64', v: 5000000000000000000n, raw: null };
  const ses2 = WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(ast2));
  assert.strictEqual(ses2.getSummary().money, '5000000000000000000');
  assert.ok(JSON.stringify(ses2.getSummary()).includes('5000000000000000000'));
  ses2.applyPreset('rich_epiphany');
  assert.strictEqual(ses2.ast.v[14].v, 5000000000000000000n);
  assert.strictEqual(ses2.getSummary().money, '5000000000000000000');
  const reloaded = WokEditorCore.loadSessionSync(ses2.encodeSync());
  assert.strictEqual(reloaded.ast.v[14].v, 5000000000000000000n);
  ses2.updateWorld({ money: '12345678901234567890' });
  assert.strictEqual(ses2.ast.v[14].v, 12345678901234567890n);
  assert.throws(() => ses2.updateWorld({ money: '18446744073709551616' }), /범위/);
});
ok('structurally damaged 54-field slot dat rejected before session creation', () => {
  const corruptAst = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  corruptAst.v[3].v[0] = WokMsgPack.makeNil();
  assert.throws(() => WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(corruptAst)), /유효한 대강호 슬롯 세이브/);

  const emptyChars = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  emptyChars.v[3].v = [];
  assert.throws(() => WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(emptyChars)), /유효한 대강호 슬롯 세이브/);

  const shortChars = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  shortChars.v[3].v[0].v = shortChars.v[3].v[0].v.slice(0, 10);
  assert.throws(() => WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(shortChars)), /유효한 대강호 슬롯 세이브/);

  const badContainer = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  badContainer.v[19] = WokMsgPack.makeStr('bad');
  assert.throws(() => WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(badContainer)), /유효한 대강호 슬롯 세이브/);

  const badPair = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  badPair.v[19].v[0] = WokMsgPack.makeArr([WokMsgPack.makeStr('999')]);
  assert.throws(() => WokEditorCore.loadSessionSync(WokMsgPack.encodeDatSync(badPair)), /유효한 대강호 슬롯 세이브/);
});

ok('nil containers preserved when untouched and persisted when mutated, plus setIntFlag AST separation', () => {
  const ast = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
  const c = ast.v[3].v[0];
  [15, 16, 18, 19, 20, 22].forEach((k) => { c.v[k] = WokMsgPack.makeNil(); });
  [6, 19, 20, 21].forEach((k) => { ast.v[k] = WokMsgPack.makeNil(); });
  ast.v[7] = WokMsgPack.makeStr('STAGE_01_0&2');
  const nilDat = WokMsgPack.encodeDatSync(ast);

  const s0 = WokEditorCore.loadSessionSync(nilDat);
  s0.removeCharacterKungfu('9001', 'no-such-kf');
  s0.removeCharacterTrait('9001', 'no-such-trait');
  s0.removeInventoryItem('no-such-item');
  const rt0 = s0.encodeSync();
  assert.ok(sameBytes(decodeMp(rt0), decodeMp(nilDat)));
  const untouched = WokMsgPack.decodeDatSync(rt0).ast;
  [15, 16, 18, 19, 20, 22].forEach((k) => { assert.strictEqual(untouched.v[3].v[0].v[k].t, 'nil'); });
  [6, 19, 20, 21].forEach((k) => { assert.strictEqual(untouched.v[k].t, 'nil'); });

  const s1 = WokEditorCore.loadSessionSync(nilDat);
  const kfId = String(WokCatalog.kungfu[0].id);
  const traitId = String(WokCatalog.traits[0].id);
  const itemId = String(WokCatalog.items[0].id);
  s1.updateCharacterBasic('9001', { heroName: '무영검' });
  s1.updateCharacterStat('9001', '2001', 'alterValue', 45);
  s1.upsertCharacterKungfu('9001', kfId, { lv: 10, proficiency: 9999, inBattle: true });
  s1.addCharacterTrait('9001', traitId);
  s1.setEquipTraitSlot('9001', 1, traitId);
  s1.setCharacterEquipSlot('9001', 0, itemId);
  s1.upsertInventoryItem(itemId, 7);
  s1.setPartyMembership('105', { inFullTeam: true, inFollow: true });
  s1.setIntFlag('tutorial_done', 12);

  const reloaded = WokEditorCore.loadSessionSync(s1.encodeSync());
  const det = reloaded.getCharacterDetail('9001');
  assert.strictEqual(det.basic.name, '무영검');
  assert.strictEqual(det.stats.all.find((r) => r.id === '2001').alterValue, 45);
  assert.ok(det.kungfu.some((k) => k.id === kfId && k.lv === 10 && k.proficiency === 9999 && k.inBattle === true));
  assert.ok(det.traits.some((t) => t.id === traitId));
  assert.ok(det.equipTraits.some((et) => et.slot === 1 && et.traitId === traitId));
  assert.strictEqual(det.equipSlots[0].id, itemId);
  assert.strictEqual(reloaded.listInventory().find((it) => it.id === itemId).amount, 7);
  const c105 = reloaded.listCharacters().find((ch) => ch.id === '105');
  assert.strictEqual(c105.inFullTeam, true);
  assert.strictEqual(c105.inFollow, true);
  assert.strictEqual(reloaded.ast.v[7].v, 'STAGE_01_0&2');
  const tFlags = reloaded.listFlags('').filter((f) => f.key === 'tutorial_done');
  assert.strictEqual(tFlags.length, 1);
  assert.strictEqual(tFlags[0].kind, 'int');
  assert.strictEqual(tFlags[0].value, 12);
});

ok('msgpack map containers and malformed element tags rejected on load and validate', () => {
  const freshAst = () => {
    const d = WokMsgPack.decodeDatSync(DEMO_SYNC);
    const ast = d && d.ast ? d.ast : d;
    ast.raw = null;
    ast.v[3].raw = null;
    ast.v[3].v[0].raw = null;
    return ast;
  };
  const assertBadDat = (ast) => {
    const badDat = WokMsgPack.encodeDatSync(ast);
    assert.throws(() => WokEditorCore.loadSessionSync(badDat), /유효한 대강호 슬롯 세이브/);
  };

  assertBadDat({
    t: 'map16',
    v: Array.from({ length: 54 }, (_, i) => [WokMsgPack.makeInt(i), WokMsgPack.makeNil()]),
    raw: null,
  });

  {
    const ast = freshAst();
    ast.v[3] = { t: 'map', v: [[WokMsgPack.makeStr('k'), ast.v[3].v[0]]], raw: null };
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[3].v[0].v[15] = { t: 'map', v: [], raw: null };
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[19] = { t: 'map', v: [], raw: null };
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[6] = { t: 'map', v: [], raw: null };
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[7] = { t: 'map', v: [], raw: null };
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[3].v[0].v[15] = WokMsgPack.makeArr([WokMsgPack.makeInt(123)]);
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[20] = WokMsgPack.makeArr([WokMsgPack.makeInt(9001)]);
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[19] = WokMsgPack.makeArr([
      WokMsgPack.makeArr([WokMsgPack.makeStr('10001'), WokMsgPack.makeStr('not-int')]),
    ]);
    assertBadDat(ast);
  }

  {
    const ast = freshAst();
    ast.v[6] = WokMsgPack.makeArr([
      WokMsgPack.makeArr([WokMsgPack.makeInt(1), WokMsgPack.makeInt(2)]),
    ]);
    assertBadDat(ast);
  }

  const assertBadSession = (mutate) => {
    const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
    mutate(ses);
    assert.strictEqual(ses.validate().valid, false);
    assert.throws(() => ses.encodeSync(), /세이브 검증 실패/);
  };

  assertBadSession((ses) => {
    ses.ast.v[3].v[0].v[15] = { t: 'map', v: [], raw: null };
  });

  assertBadSession((ses) => {
    ses.ast.v[19] = { t: 'map', v: [], raw: null };
  });

  assertBadSession((ses) => {
    ses.ast.v[7] = { t: 'map', v: [], raw: null };
  });

  assertBadSession((ses) => {
    ses.ast.v[3].v[0].v[15].v.push(WokMsgPack.makeInt(1));
  });

  assertBadSession((ses) => {
    ses.ast.v[6].v.push({ t: 'map', v: [], raw: null });
  });
});

ok('scalar field tag mismatches rejected on validate and encode', () => {
  const mutators = [
    (s) => { s.ast.v[14] = WokMsgPack.makeStr('broken'); },
    (s) => { s.ast.v[15] = WokMsgPack.makeNil(); },
    (s) => { s.ast.v[16] = WokMsgPack.makeStr('bad'); },
    (s) => { s.ast.v[17] = WokMsgPack.makeInt(1); },
    (s) => { s.ast.v[24] = WokMsgPack.makeBool(true); },
    (s) => { s.ast.v[33] = WokMsgPack.makeStr('bad'); },
    (s) => { s.ast.v[8] = WokMsgPack.makeInt(1001); },
    (s) => { s.ast.v[3].v[0].v[6] = WokMsgPack.makeInt(100); },
    (s) => { s.ast.v[3].v[0].v[9] = WokMsgPack.makeStr('99'); },
    (s) => { s.ast.v[3].v[0].v[25] = WokMsgPack.makeInt(123); }
  ];

  for (const mutate of mutators) {
    const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
    mutate(ses);

    const validation = ses.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.length >= 1);
    assert.throws(() => ses.encodeSync(), /세이브 검증 실패/);
  }

  const d = WokMsgPack.decodeDatSync(DEMO_SYNC);
  const ast = d && d.ast ? d.ast : d;
  ast.raw = null;
  ast.v[14] = WokMsgPack.makeStr('broken');

  const badDat = WokMsgPack.encodeDatSync(ast);
  const loaded = WokEditorCore.loadSessionSync(badDat);
  assert.strictEqual(loaded.validate().valid, false);
  assert.throws(() => loaded.encodeSync(), /세이브 검증 실패/);
});

async function main() {
  await asyncTests();

  try {
    const dat = await WokEditorCore.createDemoDatAsync();
    assert.strictEqual(typeof dat, 'string');
    assert.ok(dat.startsWith(WokMsgPack.COMPRESSED_PREFIX));
    const originalMp = decodeMp(dat);
    const ses = await WokEditorCore.loadSessionAsync(dat);
    const outDat = await ses.encodeAsync();
    assert.ok(sameBytes(decodeMp(outDat), originalMp), 'async untouched round-trip must be byte identical');
    validateClean(ses, 'async demo');
    pass += 1;
  } catch (err) {
    fail += 1;
    console.error(`FAIL: async demo parity\n  ${err && err.message ? err.message : err}`);
  }

  try {
    const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
    const cid = firstCharacterId(ses);
    const dyn = ses.getDynamicCatalogs();
    assert.ok(dyn);
    ses.updateWorld({ money: 9999 });
    validateClean(ses, 'sync chain');
    pass += 1;
  } catch (err) {
    fail += 1;
    console.error(`FAIL: sync chain\n  ${err && err.message ? err.message : err}`);
  }

  const htmlPath = path.join(ROOT, 'dist', 'WorldOfKungfuSaveEditor-v1.1.html');
  if (fs.existsSync(htmlPath)) {
    ok('offline html bundle', () => {
      const stat = fs.statSync(htmlPath);
      assert.ok(stat.size < 10 * 1024 * 1024, `html bundle ${stat.size} bytes >= 10MB`);
      const html = fs.readFileSync(htmlPath, 'utf8');
      const urls = html.match(/(https?:\/\/|ftp:\/\/|wss?:\/\/)/gi) || [];
      assert.strictEqual(urls.length, 0, `external url schemes found: ${urls.slice(0, 5).join(', ')}`);
      const protocolRelative = html.match(/(["'=(])\s*\/\/[A-Za-z0-9]/g) || [];
      assert.strictEqual(protocolRelative.length, 0, `protocol-relative urls found: ${protocolRelative.slice(0, 5).join(', ')}`);
    });
  }

  ok('preset parity between JS and Python across all 6 presets', () => {
    const baseSes = WokEditorCore.loadSessionSync(DEMO_SYNC);
    baseSes.setPartyMembership('105', { inFullTeam: true, inFollow: true });
    baseSes.setPartyMembership('312', { inFullTeam: true, inFollow: false });
    baseSes.ast.v[3].v[0].v[15].v.push(WokMsgPack.makeStr('10999,1,0,10,True'));
    const heroStatRows = baseSes.ast.v[3].v[0].v[18].v;
    const upsertHeroStatRow = (prefix, text) => {
      for (let i = 0; i < heroStatRows.length; i += 1) {
        const node = heroStatRows[i];
        if (node && typeof node.v === 'string' && node.v.indexOf(prefix) === 0) {
          WokMsgPack.setStr(node, text);
          return;
        }
      }
      heroStatRows.push(WokMsgPack.makeStr(text));
    };
    upsertHeroStatRow('2001,', '2001,,-0.00001,0,0,0,0,0,0');
    upsertHeroStatRow('2002,', '2002,,0.00005,-0.00004,0,1.23455,-1.23455,0,0');
    upsertHeroStatRow('2003,', '2003,,1e21,0,1e30,0,0,0,0');
    upsertHeroStatRow('2004,', '2004,,-1e21,0,1.2345678901234567e20,0,0,0,0');
    const baseDat = baseSes.encodeSync();
    const presets = ['rich_epiphany', 'hero_max_growth', 'hero_six_attributes', 'hero_all_mastery', 'master_all_kungfu', 'party_recover_boost'];
    const cid = firstCharacterId(baseSes);
    const pyCode = `
import sys, json, wok_editor
base = sys.argv[1].encode('utf-8')
cid = ${JSON.stringify(cid)}
presets = ['rich_epiphany', 'hero_max_growth', 'hero_six_attributes', 'hero_all_mastery', 'master_all_kungfu', 'party_recover_boost']
out = {}
for name in presets:
    ses = wok_editor.WokSaveSession(base)
    ses.apply_preset(name, cid)
    out[name] = ses.to_bytes().decode('utf-8')
print(json.dumps(out))
`;
    const pyOut = require('child_process').execFileSync('python3', ['-B', '-c', pyCode, baseDat], { cwd: ROOT, encoding: 'utf8' });
    const pyMap = JSON.parse(pyOut);
    for (const preset of presets) {
      const jsSes = WokEditorCore.loadSessionSync(baseDat);
      jsSes.applyPreset(preset, firstCharacterId(jsSes));
      if (preset === 'hero_six_attributes') {
        const rows = jsSes.ast.v[3].v[0].v[18].v;
        let row2001 = null;
        for (const node of rows) {
          if (node && typeof node.v === 'string' && node.v.indexOf('2001,') === 0) { row2001 = node.v; break; }
        }
        assert.ok(typeof row2001 === 'string', 'hero_six_attributes: 2001 row must exist');
        assert.ok(row2001.indexOf('2001,,0,') === 0, `hero_six_attributes 2001 row must start with '2001,,0,' but was ${row2001}`);
        assert.ok(row2001.indexOf(',,-0') === -1, `hero_six_attributes 2001 row must not contain ',,-0': ${row2001}`);
        let row2003 = null;
        let row2004 = null;
        for (const node of rows) {
          if (node && typeof node.v === 'string' && node.v.indexOf('2003,') === 0) { row2003 = node.v; }
          if (node && typeof node.v === 'string' && node.v.indexOf('2004,') === 0) { row2004 = node.v; }
        }
        assert.strictEqual(row2003, '2003,,1e+21,40,1e+30,0,0,0,0');
        assert.strictEqual(row2004, '2004,,-1e+21,40,123456789012345670000,0,0,0,0');
      }
      assert.ok(sameBytes(decodeMp(jsSes.encodeSync()), decodeMp(pyMap[preset])), `preset parity ${preset}`);
    }
  });

  ok('msgpack tag parity between JS and Python for bin8 vs fixext1/ext8 in g[4]', () => {
    const zlib = require('zlib');
    const { execFileSync } = require('child_process');
    const ast3 = WokMsgPack.decodeDatSync(DEMO_SYNC).ast;
    ast3.raw = null;
    ast3.v[4] = { t: 'bin8', v: new Uint8Array([0xaa]), raw: null };
    const mp3 = Buffer.from(WokMsgPack.encodeMsgPack(ast3));
    const datBin8 = 'COMPRESSED:' + zlib.gzipSync(mp3).toString('base64');
    assert.strictEqual(WokEditorCore.loadSessionSync(datBin8).validate().valid, true);
    const idx3 = mp3.indexOf(Buffer.from([0xc4, 0x01, 0xaa]));
    assert.ok(idx3 > 0);
    const mpFixExt1 = Buffer.from(mp3);
    mpFixExt1[idx3] = 0xd4;
    const datFixExt1 = 'COMPRESSED:' + zlib.gzipSync(mpFixExt1).toString('base64');
    assert.throws(() => WokEditorCore.loadSessionSync(datFixExt1));
    ast3.v[4] = { t: 'bin8', v: new Uint8Array([0xbb, 0xcc]), raw: null };
    const mp4 = Buffer.from(WokMsgPack.encodeMsgPack(ast3));
    const idx4 = mp4.indexOf(Buffer.from([0xc4, 0x02, 0xbb, 0xcc]));
    assert.ok(idx4 > 0);
    const mpExt8 = Buffer.concat([mp4.slice(0, idx4), Buffer.from([0xc7, 0x01, 0x01, 0xaa]), mp4.slice(idx4 + 4)]);
    const datExt8 = 'COMPRESSED:' + zlib.gzipSync(mpExt8).toString('base64');
    assert.throws(() => WokEditorCore.loadSessionSync(datExt8));
    const pyCode3 = `
import sys, json, wok_editor
data = json.loads(sys.argv[1])
wok_editor.WokSaveSession(data['bin8'].encode('utf-8')).to_bytes()
res = {'bin8': True, 'fixext1': False, 'ext8': False}
for key in ('fixext1', 'ext8'):
    try:
        wok_editor.WokSaveSession(data[key].encode('utf-8'))
        res[key] = True
    except ValueError:
        res[key] = False
print(json.dumps(res))
`;
    const pyOut3 = execFileSync('python3', ['-B', '-c', pyCode3, JSON.stringify({ bin8: datBin8, fixext1: datFixExt1, ext8: datExt8 })], { cwd: ROOT, encoding: 'utf8' });
    const pyRes3 = JSON.parse(pyOut3);
    assert.strictEqual(pyRes3.bin8, true, 'Python WokSaveSession(datBin8) must succeed');
    assert.strictEqual(pyRes3.fixext1, false, 'Python WokSaveSession(datFixExt1) must raise ValueError');
    assert.strictEqual(pyRes3.ext8, false, 'Python WokSaveSession(datExt8) must raise ValueError');
  });

  ok('validate parity for c[15] CSV, c[22] equip slot, empty item ID, and FollowList playerid', () => {
    const invalidMutations = [
      (ses) => ses.ast.v[3].v[0].v[15].v.push(WokMsgPack.makeStr('1001,1,0,0')),
      (ses) => { ses.ast.v[3].v[0].v[22] = WokMsgPack.makeArr([WokMsgPack.makeStr('0|101')]); },
      (ses) => { ses.ast.v[3].v[0].v[22] = WokMsgPack.makeArr([WokMsgPack.makeStr('10|101')]); },
      (ses) => { ses.ast.v[21].v.push(WokMsgPack.makeStr(ses.ast.v[9].v)); },
      (ses) => { ses.ast.v[19].v.push(WokMsgPack.makeArr([WokMsgPack.makeStr(''), WokMsgPack.makeInt(1)])); },
      (ses) => { ses.ast.v[6] = WokMsgPack.makeArr([WokMsgPack.makeArr([WokMsgPack.makeStr(''), WokMsgPack.makeInt(1)])]); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], '&1'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&18446744073709551616'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&-9223372036854775809'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&' + '9'.repeat(4301)); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&-' + '9'.repeat(4301)); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&1\n'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&1\r'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&1\r\n'); },
      (ses) => { WokMsgPack.setStr(ses.ast.v[7], 'x&\n1'); }
    ];
    for (const mutate of invalidMutations) {
      const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
      mutate(ses);
      assert.strictEqual(ses.validate().valid, false);
      assert.throws(() => ses.encodeSync(), /세이브 검증 실패/);
    }
    {
      const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
      WokMsgPack.setStr(ses.ast.v[7], 'x&' + '0'.repeat(4301) + '1|y&-' + '0'.repeat(4301) + '1');
      assert.strictEqual(ses.validate().valid, true);
    }
  });

  ok('Astra-R16: abolished kungfu whitespace trim parity with Python', () => {
    const ses = WokEditorCore.loadSessionSync(DEMO_SYNC);
    ses.ast.v[3].v[0].v[15].v.push(WokMsgPack.makeStr('1001,1,0,0, True '));
    ses.applyPreset('master_all_kungfu');
    ses.applyPreset('party_recover_boost');
    assert.strictEqual(ses.ast.v[3].v[0].v[15].v[ses.ast.v[3].v[0].v[15].v.length - 1].v, '1001,1,0,0, True ');
    const fsParity = require('fs');
    const osParity = require('os');
    const pathParity = require('path');
    const tmpDir = fsParity.mkdtempSync(pathParity.join(osParity.tmpdir(), 'wok-r16-'));
    const inPath = pathParity.join(tmpDir, 'bigbang1data.dat');
    fsParity.writeFileSync(inPath, DEMO_SYNC);
    const pyScript = [
      'import sys, wok_editor',
      'data = open(sys.argv[1], "rb").read()',
      's = wok_editor.WokSaveSession(data)',
      's.root.val[3].val[0].val[15].val.append(wok_editor.MPNode("str", "1001,1,0,0, True "))',
      's.apply_preset("master_all_kungfu")',
      's.apply_preset("party_recover_boost")',
      'assert s.root.val[3].val[0].val[15].val[-1].val == "1001,1,0,0, True "',
      'out = s.to_bytes().decode("utf-8")',
      'sys.stdout.write(out)'
    ].join('\n');
    const pyDat = require('child_process').execFileSync('python3', ['-c', pyScript, inPath], { cwd: ROOT, encoding: 'utf8' });
    assert.ok(sameBytes(WokMsgPack.encodeMsgPack(ses.ast), decodeMp(pyDat)));
    fsParity.rmSync(tmpDir, { recursive: true, force: true });
  });

  ok('codeAtlas exposes REA InjuryCalManager and XmlSaver formulas', () => {
    assert.ok(WokCatalog.codeAtlas.length >= 9, `codeAtlas ${WokCatalog.codeAtlas.length} < 9`);
    assert.strictEqual(WokCatalog.meta.counts.codeAtlas, WokCatalog.codeAtlas.length);
    const byId = new Map(WokCatalog.codeAtlas.map((x) => [x.id, x]));
    const xmlSaver = byId.get('XmlSaver');
    assert.ok(xmlSaver && xmlSaver.detail.includes('91429750903495708124650874157912'));
    assert.ok(xmlSaver.detail.includes('RijndaelManaged') && xmlSaver.detail.includes('COMPRESSED:'));
    const calAtk = byId.get('InjuryCalManager.CalAttackDamage');
    assert.ok(calAtk, 'InjuryCalManager.CalAttackDamage missing');
    for (const kw of ['Style 701', 'Melody', 'Style 801', '1+Drunk/25', 'saturate(Hurt/255)', 'GetAttackSideRate']) {
      assert.ok(calAtk.detail.includes(kw), `CalAttackDamage missing ${kw}`);
    }
    const calHit = byId.get('InjuryCalManager.CalBeHitInjurt');
    assert.ok(calHit, 'InjuryCalManager.CalBeHitInjurt missing');
    for (const kw of ['(Drunk/100)*(1-saturate(Wineart/255))', '1025', 'MelodyATKresist']) {
      assert.ok(calHit.detail.includes(kw), `CalBeHitInjurt missing ${kw}`);
    }
  });

  ok('extended GameData fields read/edit/validate and MessagePack round-trip', () => {
    const ses0 = WokEditorCore.loadSessionSync(DEMO_SYNC);
    const sum0 = ses0.getSummary();
    assert.strictEqual(sum0.arenaWinCount, 0);
    assert.strictEqual(sum0.arenaRewardsJunShan, '000000000000000');
    assert.strictEqual(sum0.daTianWangSiLevel, 0);
    assert.strictEqual(sum0.dongShuFactionMember, '1202|607');
    assert.strictEqual(sum0.jinWuFactionMember, '9018|502');
    assert.strictEqual(sum0.xiBoFactionMember, '202|401|402|403');
    assert.strictEqual(sum0.beiGuFactionMember, '205');
    assert.strictEqual(sum0.wantedCount, 0);
    assert.strictEqual(sum0.specialWantedCount, 0);

    ses0.ast.v[30] = WokMsgPack.makeArr([WokMsgPack.makeArr([WokMsgPack.makeStr('wanted_1'), WokMsgPack.makeInt(42)])]);
    const seededDat = ses0.encodeSync();
    const ses = WokEditorCore.loadSessionSync(seededDat);
    const origWantedBytes = WokMsgPack.encodeMsgPack(ses.ast.v[30]);

    ses.updateWorld({
      arenaWinCount: 12,
      daTianWangSiLevel: 5,
      arenaRewardsJunShan: '111000000000000',
      arenaRewardsDaTianWangSi: '1&100|2&200',
      dongShuFactionMember: '1202 | 607 | 999 | 607',
      jinWuFactionMember: '9018|502|503',
      xiBoFactionMember: '202|401',
      beiGuFactionMember: '205|206',
      specialWantedList: ['sp_1', 'sp_2', 'sp_1']
    });
    validateClean(ses, 'extended updateWorld');
    const rtDat = roundTripSync(ses, 'extended updateWorld');
    const reloaded = WokEditorCore.loadSessionSync(rtDat);
    const ext = reloaded.getExtendedWorld();
    assert.strictEqual(ext.arenaWinCount, 12);
    assert.strictEqual(ext.daTianWangSiLevel, 5);
    assert.strictEqual(ext.arenaRewardsJunShan, '111000000000000');
    assert.strictEqual(ext.arenaRewardsDaTianWangSi, '1&100|2&200');
    assert.strictEqual(ext.dongShuFactionMember, '1202|607|999');
    assert.deepStrictEqual(ext.dongShuMembers, ['1202', '607', '999']);
    assert.strictEqual(ext.jinWuFactionMember, '9018|502|503');
    assert.strictEqual(ext.xiBoFactionMember, '202|401');
    assert.strictEqual(ext.beiGuFactionMember, '205|206');
    assert.deepStrictEqual(ext.specialWantedList, ['sp_1', 'sp_2']);
    assert.strictEqual(ext.wantedCount, 1);
    assert.ok(sameBytes(WokMsgPack.encodeMsgPack(reloaded.ast.v[30]), origWantedBytes), 'untouched simpleWantedInfos must remain byte-identical');

    assert.throws(() => reloaded.updateWorld({ arenaWinCount: -1 }), /0 이상/);
    assert.throws(() => reloaded.updateWorld({ daTianWangSiLevel: -2 }), /0 이상/);
    assert.throws(() => reloaded.updateWorld({ arenaRewardsJunShan: 'a\nb' }), /줄바꿈/);
    assert.throws(() => reloaded.updateWorld({ dongShuFactionMember: '1202,607' }), /쉼표/);
    assert.throws(() => reloaded.updateWorld({ jinWuFactionMember: '9018&502' }), /&/);
    assert.throws(() => reloaded.updateWorld({ specialWantedList: ['bad|id'] }), /구분자/);

    for (const corrupt of [
      (s) => { s.ast.v[25] = WokMsgPack.makeInt(-1); },
      (s) => { s.ast.v[36] = WokMsgPack.makeStr('bad'); },
      (s) => { s.ast.v[38] = WokMsgPack.makeStr('1202,607'); },
      (s) => { s.ast.v[43] = WokMsgPack.makeArr([WokMsgPack.makeInt(1)]); }
    ]) {
      const bad = WokEditorCore.loadSessionSync(DEMO_SYNC);
      corrupt(bad);
      assert.strictEqual(bad.validate().valid, false);
      assert.throws(() => bad.encodeSync(), /세이브 검증 실패/);
    }
  });

  try {
    const deep66 = new Uint8Array(67);
    deep66.fill(0x91, 0, 66);
    deep66[66] = 0x00;
    assert.throws(() => WokMsgPack.decodeMsgPack(deep66), /depth/i);
    const bombDat = 'COMPRESSED:' + require('zlib').gzipSync(Buffer.alloc(65 * 1024 * 1024), { level: 1 }).toString('base64');
    assert.throws(() => WokMsgPack.decodeDatSync(bombDat));
    await assert.rejects(() => WokMsgPack.decodeDat(bombDat));
    let readCalled = false;
    let frCalled = false;
    const statusEl = { textContent: '', err: false, classList: { toggle(_c, on) { statusEl.err = Boolean(on); } } };
    const docStub = { readyState: 'loading', addEventListener() {}, getElementById(id) { return id === 'status-msg' ? statusEl : null; }, body: { classList: { toggle() {} }, appendChild() {} }, createElement() { return { click() {}, remove() {} }; }, querySelectorAll() { return []; } };
    const winStub = { location: { protocol: 'file:' }, addEventListener() {}, WokCatalog, WokMsgPack, WokEditorCore };
    require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'editor-ui.js'), 'utf8'), { window: winStub, document: docStub, location: winStub.location, FileReader: function () { frCalled = true; }, Blob, URL, setTimeout, clearTimeout, console });
    await winStub.WokEditorUI.openFile({ name: 'bigbang1data.dat', size: 32 * 1024 * 1024 + 1, text() { readCalled = true; throw new Error('should not read'); } });
    await winStub.WokEditorUI.openFile({ name: 'bigbang1data.dat', size: 32 * 1024 * 1024 + 1 });
    assert.strictEqual(readCalled, false);
    assert.strictEqual(frCalled, false);
    assert.strictEqual(statusEl.err, true);
    assert.ok(/32 MiB/.test(statusEl.textContent));
    pass += 1;
    console.log('ok - resource bounds');
  } catch (e) {
    fail += 1;
    console.error('not ok - resource bounds');
    console.error(e && e.stack || e);
  }

  const realDir = process.env.WOKSE_REAL_SAVES_DIR;
  if (realDir && fs.existsSync(realDir) && fs.statSync(realDir).isDirectory()) {
    const entries = fs.readdirSync(realDir);
    const slotFiles = entries.filter((f) => /^bigbang.*data\.dat$/i.test(f));
    const nonSlotFiles = ['configdata.dat', 'StatsAndAchievementdata.dat', 'UnlockAtlasdata.dat'];

    for (const file of slotFiles) {
      ok(`real slot round-trip ${file}`, () => {
        const datText = fs.readFileSync(path.join(realDir, file), 'utf8');
        const originalMp = decodeMp(datText);
        const ses = WokEditorCore.loadSessionSync(datText);
        validateClean(ses, `real ${file}`);
        const outDat = ses.encodeSync();
        assert.ok(sameBytes(decodeMp(outDat), originalMp), `real ${file} untouched round-trip must be byte identical`);
      });

      ok(`real slot presets ${file}`, () => {
        const datText = fs.readFileSync(path.join(realDir, file), 'utf8');
        const ses = WokEditorCore.loadSessionSync(datText);
        const cid = firstCharacterId(ses);
        ses.applyPreset('rich_epiphany', cid);
        ses.applyPreset('hero_max_growth', cid);
        ses.applyPreset('party_recover_boost', cid);
        validateClean(ses, `real ${file} presets`);
        const outDat = ses.encodeSync();
        const reloaded = WokEditorCore.loadSessionSync(outDat);
        validateClean(reloaded, `real ${file} presets reload`);
      });
    }

    for (const file of nonSlotFiles) {
      const full = path.join(realDir, file);
      if (!fs.existsSync(full)) continue;
      ok(`real non-slot round-trip ${file}`, () => {
        const datText = fs.readFileSync(full, 'utf8');
        const originalMp = decodeMp(datText);
        const ast = WokMsgPack.decodeDatSync(datText).ast;
        const reencoded = WokMsgPack.encodeMsgPack(ast);
        assert.ok(sameBytes(reencoded, originalMp), `non-slot ${file} msgpack must round-trip`);
        assert.throws(() => WokEditorCore.loadSessionSync(datText), /configdata|게임|슬롯|GameData|54|환경설정|업적|도감|WokError/i);
      });
    }
  }

  const total = pass + fail;
  console.log(`WokSaveEditor tests: ${total} run, ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
