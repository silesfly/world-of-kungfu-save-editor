(function () {
  'use strict';
  const C = window.WokCatalog || {};
  const Core = window.WokEditorCore || {};
  const MsgPack = window.WokMsgPack || {};
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : (d == null ? 0 : d); };
  const int = (v, d) => Math.trunc(num(v, d));
  const intInput = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (/^-?[0-9]+$/.test(s)) {
      const b = BigInt(s);
      if (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(b);
      return s;
    }
    return int(v);
  };
  const arr = (v) => Array.isArray(v) ? v : [];
  const isWebView2 = Boolean(window.chrome && window.chrome.webview);
  const isHttp = !isWebView2 && location.protocol.slice(0, 4) === 'http';
  let session = null;
  let nativeSession = null;
  let fileName = '';
  let dirty = false;
  let busy = false;
  let csrfToken = null;
  let saves = [];
  let seq = 0;
  let selectedCharaId = null;
  let activeTab = 'summary';
  let activeStatGroup = 'all';
  let statSearch = '';
  let invSearch = '';
  let invCat = 'all';
  let flagSearch = '';
  let pickerHandler = null;
  let sourceKind = 'none';
  let serverLoadedName = '';
  let serverExpectedSha = '';
  let editRevision = 0;
  let sessionEpoch = 0;
  let pendingNative = null;
  let pickerItems = [];
  const tabs = ['summary', 'chara', 'kungfu', 'inventory', 'party', 'atlas'];
  const statGroups = ['core', 'aptitude', 'mastery', 'combat', 'profile', 'all'];
  const setStatus = (msg, err) => { const el = $('status-msg'); if (el) { el.textContent = msg || ''; el.classList.toggle('error', Boolean(err)); } };
  const postNativeNotice = (payload) => {
    if (!isWebView2 || !window.chrome.webview || !window.chrome.webview.postMessage) return;
    seq += 1;
    window.chrome.webview.postMessage(Object.assign({ id: 'notice-' + seq, seq: seq }, payload || {}));
  };
  const setBusy = (v) => { busy = Boolean(v); document.body.classList.toggle('busy', busy); refreshTransportUi(); };
  const renderDirtyBadge = () => {
    const b = $('dirty-badge');
    if (b) { b.hidden = !dirty; b.textContent = dirty ? '수정됨' : ''; }
  };
  const syncNativeDirty = () => {
    if (isWebView2) postNativeNotice({ kind: 'dirty', dirty: dirty });
  };
  const markDirty = (v, forceSync) => {
    const next = v == null ? true : Boolean(v);
    const changed = next !== dirty;
    dirty = next;
    renderDirtyBadge();
    if (changed || forceSync) syncNativeDirty();
  };
  const setFileBadge = () => { const b = $('file-badge'); if (b) b.textContent = fileName || '세이브 없음'; };
  const getSummarySafe = () => { try { return session && session.getSummary ? session.getSummary() : null; } catch (e) { return null; } };
  const getDynamicSafe = () => { try { return session && session.getDynamicCatalogs ? session.getDynamicCatalogs() : {}; } catch (e) { return {}; } };
  const isSession = () => Boolean(session);
  const refreshTransportUi = () => {
    const dl = $('btn-download-dat');
    if (dl) dl.disabled = !session || busy;
    const no = $('btn-native-open');
    if (no) no.disabled = busy;
    const ns = $('btn-native-save');
    if (ns) ns.disabled = !session || busy || sourceKind !== 'native' || !nativeSession;
    const nc = $('btn-native-save-copy');
    if (nc) nc.disabled = !session || busy;
    const sl = $('btn-server-load');
    if (sl) sl.disabled = busy;
    const ss = $('btn-server-save');
    if (ss) ss.disabled = !session || busy || sourceKind !== 'server' || !serverLoadedName || !serverExpectedSha;
  };
  const confirmDiscardIfDirty = () => {
    if (!dirty || window.__WOKSE_SKIP_CONFIRM) return true;
    if (typeof window.confirm === 'function') return Boolean(window.confirm('저장하지 않은 변경 사항이 있습니다. 계속하시겠습니까?'));
    return true;
  };
  const refreshAll = () => {
    refreshTransportUi();
    setFileBadge();
    renderDirtyBadge();
    if (!session) {
      ['summary-cards', 'preset-grid', 'world-form', 'chara-select', 'chara-basic-box', 'stat-group-bar', 'stat-table-wrap', 'kungfu-box', 'trait-box', 'equip-slot-box', 'inv-table-wrap', 'forged-box', 'party-box', 'flag-box', 'atlas-box', 'validate-box', 'raw-json-box'].forEach((id) => { const el = $(id); if (el) el.innerHTML = ''; });
      return;
    }
    try { renderSummary(); } catch (e) { setStatus('요약 렌더 오류: ' + e.message, true); }
    try { renderChara(true); } catch (e) { setStatus('캐릭터 렌더 오류: ' + e.message, true); }
    try { renderKungfu(); } catch (e) { setStatus('무공 렌더 오류: ' + e.message, true); }
    try { renderInventory(); } catch (e) { setStatus('인벤토리 렌더 오류: ' + e.message, true); }
    try { renderParty(); } catch (e) { setStatus('파티 렌더 오류: ' + e.message, true); }
    try { renderAtlas(); } catch (e) { setStatus('도감 렌더 오류: ' + e.message, true); }
  };
  const preflightSession = (s) => {
    if (!s || typeof s !== 'object') throw new Error('유효하지 않은 세이브 세션입니다.');
    s.getSummary();
    const chars = arr(s.listCharacters && s.listCharacters());
    if (!chars.length) throw new Error('세이브에 캐릭터 데이터가 없습니다.');
    const hero = chars.find((c) => c && c.isHero) || chars[0];
    if (!hero || !hero.id) throw new Error('주인공 캐릭터 ID를 확인할 수 없습니다.');
    s.getCharacterDetail(hero.id);
    s.listInventory();
    s.listFlags('');
    const v = s.validate();
    if (!v || v.valid !== true) throw new Error('세이브 검증 실패: ' + ((v && Array.isArray(v.errors) && v.errors.length) ? v.errors.join(' / ') : '유효하지 않은 세이브 데이터입니다.'));
    if (typeof s.toPlainJson === 'function') s.toPlainJson();
  };
  const activateLoadedSession = (s, name, opts) => {
    opts = opts || {};
    sessionEpoch += 1;
    editRevision += 1;
    session = s;
    fileName = name || 'save.dat';
    const kind = opts.sourceKind || 'local';
    sourceKind = kind;
    if (kind === 'native') {
      nativeSession = opts.nativeSession || null;
      serverLoadedName = '';
      serverExpectedSha = '';
    } else if (kind === 'server') {
      nativeSession = null;
      serverLoadedName = opts.serverLoadedName || fileName;
      serverExpectedSha = opts.serverExpectedSha || '';
      if (isWebView2) postNativeNotice({ kind: 'detach', dirty: false });
    } else {
      nativeSession = null;
      serverLoadedName = '';
      serverExpectedSha = '';
      if (isWebView2) postNativeNotice({ kind: 'detach', dirty: false });
    }
    selectedCharaId = null;
    const list = arr(session.listCharacters && session.listCharacters());
    const hero = list.find((c) => c.isHero) || list[0];
    selectedCharaId = hero ? hero.id : null;
    invCat = 'all';
    markDirty(false, true);
    setStatus(fileName + ' 불러옴');
    refreshAll();
    renderRawJson();
    return session;
  };
  const loadFromDatText = async (datText, name, opts) => {
    opts = opts || {};
    if (!datText) throw new Error('DAT 내용이 없습니다.');
    if (!Core.loadSessionAsync) throw new Error('WokEditorCore.loadSessionAsync를 사용할 수 없습니다.');
    if (!opts.keepBusy) setBusy(true);
    try {
      const s = await Core.loadSessionAsync(datText, name);
      preflightSession(s);
      return activateLoadedSession(s, name, opts);
    } catch (e) {
      setStatus('불러오기 실패: ' + e.message, true);
      throw e;
    } finally {
      if (!opts.keepBusy && !pendingNative) setBusy(false);
    }
  };
  const applyMutation = (fn, msg) => {
    if (busy) { setStatus('작업 처리 중입니다.', true); return false; }
    if (!session) { setStatus('먼저 세이브를 불러오세요.', true); return false; }
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        setBusy(true);
        r.then(() => { editRevision += 1; markDirty(true, true); setStatus(msg || '적용됨'); refreshAll(); renderRawJson(); }).catch((e) => { refreshAll(); renderRawJson(); setStatus('적용 실패: ' + e.message, true); }).finally(() => setBusy(false));
      } else {
        editRevision += 1;
        markDirty(true, true);
        setStatus(msg || '적용됨');
        refreshAll();
        renderRawJson();
      }
      return true;
    } catch (e) {
      refreshAll();
      renderRawJson();
      setStatus('적용 실패: ' + e.message, true);
      return false;
    }
  };
  const selectTab = (name) => {
    if (tabs.indexOf(name) < 0) name = 'summary';
    activeTab = name;
    tabs.forEach((t) => {
      const b = $('tab-btn-' + t);
      const p = $('panel-' + t);
      const on = t === name;
      if (b) { b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1'); }
      if (p) p.hidden = !on;
    });
    const b = $('tab-btn-' + name);
    if (b && b.focus) b.focus();
  };
  const wireTabs = () => {
    tabs.forEach((t, i) => {
      const b = $('tab-btn-' + t);
      if (!b) return;
      b.addEventListener('click', () => selectTab(t));
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          const n = (i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          selectTab(tabs[n]);
        }
      });
    });
  };
  const renderSummary = () => {
    const s = getSummarySafe();
    if (!s) return;
    const cards = [
      ['파일', s.fileName], ['키', s.key], ['플레이어', s.playerId], ['주인공', s.heroName],
      ['출생', s.originKo], ['장면', s.scene], ['돈', s.money], ['깨달음', s.epiphany],
      ['라운드', s.playRound], ['이동속도', s.moveSpeed], ['삽 내구도', s.shovelDurable], ['모드', s.gameMode],
      ['버전', s.version], ['캐릭터', s.charaCount], ['풀팀', s.fullTeamCount], ['추종', s.followCount],
      ['아이템', s.itemCount], ['커스텀 장비', s.customEquipCount], ['커스텀 무공', s.customKungfuCount]
    ];
    const el = $('summary-cards');
    if (el) el.innerHTML = cards.map((x) => '<div class="summary-card"><div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + '</div></div>').join('');
    const pg = $('preset-grid');
    if (pg) {
      const ps = arr(Core.PRESETS);
      pg.innerHTML = ps.map((p) => '<button type="button" class="preset-card" data-preset="' + esc(p.id) + '"><strong>' + esc(p.titleKo) + '</strong><span>' + esc(p.descKo) + '</span></button>').join('');
      pg.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-preset');
          const target = selectedCharaId || (s.playerId);
          applyMutation(() => session.applyPreset(id, target), '프리셋 적용: ' + id);
        });
      });
    }
    const wf = $('world-form');
    if (wf) {
      const chars = arr(session.listCharacters());
      const hero = chars.find((c) => c.isHero) || chars[0] || null;
      const origins = arr(C.origins);
      wf.innerHTML = '<div class="form-grid">' +
        (hero ? '<label>주인공 이름<input name="heroName" value="' + esc(hero.name || hero.ko || s.heroName) + '"></label>' : '') +
        '<label>돈<input name="money" type="number" value="' + esc(s.money) + '"></label>' +
        '<label>깨달음<input name="epiphany" type="number" value="' + esc(s.epiphany) + '"></label>' +
        '<label>라운드<input name="playRound" type="number" value="' + esc(s.playRound) + '"></label>' +
        '<label>이동속도<input name="moveSpeed" type="number" step="any" value="' + esc(s.moveSpeed) + '"></label>' +
        '<label>삽 내구도<input name="shovelDurable" type="number" value="' + esc(s.shovelDurable) + '"></label>' +
        '<label>게임 모드<input name="gameMode" value="' + esc(s.gameMode) + '"></label>' +
        '<label>출생<select name="originId">' + origins.map((o) => '<option value="' + esc(o.id) + '"' + (String(o.id) === String(s.originId) ? ' selected' : '') + '>' + esc(o.ko || o.cn || o.id) + '</option>').join('') + '</select></label>' +
        '<label>장면<input name="scene" value="' + esc(s.scene) + '"></label>' +
        '</div>';
      const onWorld = (ev) => {
        const t = ev.target;
        if (!t || !t.name) return;
        if (t.name === 'heroName') {
          if (!hero) return;
          applyMutation(() => session.updateCharacterBasic(hero.id, { heroName: t.value }), '주인공 이름 변경');
        } else {
          const val = ['money', 'epiphany', 'playRound', 'shovelDurable'].indexOf(t.name) >= 0 ? intInput(t.value) : (t.name === 'moveSpeed' ? num(t.value) : t.value);
          applyMutation(() => session.updateWorld({ [t.name]: val }), t.name + ' 변경');
        }
      };
      wf.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', onWorld));
    }
  };
  const renderChara = (skipCascade) => {
    if (!session) return;
    const prevCharaId = selectedCharaId;
    const all = arr(session.listCharacters());
    const filter = ($('chara-filter') && $('chara-filter').value || '').trim().toLowerCase();
    const shown = all.filter((c) => {
      if (!filter) return true;
      return [c.id, c.name, c.ko, c.cn].some((v) => String(v == null ? '' : v).toLowerCase().indexOf(filter) >= 0);
    });
    if (shown.length) {
      if (!shown.some((c) => String(c.id) === String(selectedCharaId))) selectedCharaId = shown[0].id;
    } else if (!all.some((c) => String(c.id) === String(selectedCharaId))) {
      selectedCharaId = (all[0] || {}).id || null;
    }
    const sel = $('chara-select');
    if (sel) {
      if (shown.length === 0) {
        sel.innerHTML = '<option value="">검색 결과 없음</option>';
        sel.disabled = true;
      } else {
        sel.innerHTML = shown.map((c) => '<option value="' + esc(c.id) + '"' + (String(c.id) === String(selectedCharaId) ? ' selected' : '') + '>' + esc((c.isHero ? '★ ' : '') + (c.ko || c.name || c.cn || c.id)) + ' (Lv.' + esc(c.level) + ')</option>').join('');
        sel.disabled = false;
        sel.value = selectedCharaId != null ? String(selectedCharaId) : '';
      }
      sel.onchange = () => { selectedCharaId = sel.value; renderCharaDetail(); renderKungfu(); renderInventory(); renderRawJson(); };
    }
    const cf = $('chara-filter');
    if (cf && !cf.__wokBound) { cf.__wokBound = true; cf.addEventListener('input', () => { renderChara(false); }); }
    renderCharaDetail();
    if (!skipCascade && String(selectedCharaId) !== String(prevCharaId)) { renderKungfu(); renderInventory(); renderRawJson(); }
  };
  const renderCharaDetail = () => {
    if (!session || selectedCharaId == null) { const b = $('chara-basic-box'); if (b) b.innerHTML = '<p class="muted">캐릭터가 없습니다.</p>'; return; }
    let d;
    try { d = session.getCharacterDetail(selectedCharaId); } catch (e) { setStatus('캐릭터 상세 오류: ' + e.message, true); return; }
    const b = d.basic || {};
    const box = $('chara-basic-box');
    if (box) {
      box.innerHTML = '<div class="basic-grid">' +
        '<label>ID<input value="' + esc(b.id) + '" readonly></label>' +
        (b.isHero ? '<label>이름<input name="heroName" value="' + esc(b.name) + '"></label>' : '<label>이름 (주인공 전용)<input value="' + esc(b.name || b.ko || b.cn) + '" readonly></label>') +
        '<label>한글<input value="' + esc(b.ko) + '" readonly></label>' +
        '<label>중문<input value="' + esc(b.cn) + '" readonly></label>' +
        '<label>주인공<input value="' + esc(b.isHero ? '예' : '아니오') + '" readonly></label>' +
        '<label>레벨<input name="level" type="number" value="' + esc(b.level) + '"></label>' +
        '<label>경험치<input name="exp" type="number" value="' + esc(b.exp) + '"></label>' +
        '<label>HP<input name="hp" type="number" value="' + esc(b.hp) + '"></label>' +
        '<label>MP<input name="mp" type="number" value="' + esc(b.mp) + '"></label>' +
        '<label>재능<input name="talent" type="number" value="' + esc(b.talent) + '"></label>' +
        '<label>관계<input name="relationship" type="number" value="' + esc(b.relationship) + '"></label>' +
        '<label>수련<input name="trainingId" value="' + esc(b.trainingId) + '"></label>' +
        '<label>별명<input name="nickName" value="' + esc(b.nickName) + '"></label>' +
        '<label>문파<input name="guild" value="' + esc(b.guild) + '"></label>' +
        '</div>';
      box.querySelectorAll('input[name]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const n = inp.name;
          const v = ['level', 'exp', 'talent', 'relationship'].indexOf(n) >= 0 ? intInput(inp.value) : (n === 'hp' || n === 'mp' ? int(inp.value) : inp.value);
          applyMutation(() => session.updateCharacterBasic(selectedCharaId, { [n]: v }), '캐릭터 ' + n + ' 변경');
        });
      });
    }
    const gb = $('stat-group-bar');
    if (gb) {
      gb.innerHTML = statGroups.map((g) => '<button type="button" class="stat-tab' + (g === activeStatGroup ? ' active' : '') + '" data-group="' + esc(g) + '">' + esc(g) + '</button>').join('');
      gb.querySelectorAll('[data-group]').forEach((btn) => btn.addEventListener('click', () => { activeStatGroup = btn.getAttribute('data-group'); renderStatTable(); }));
    }
    const ss = $('stat-search');
    if (ss && !ss.__wokBound) { ss.__wokBound = true; ss.addEventListener('input', () => { statSearch = ss.value || ''; renderStatTable(); }); }
    renderStatTable();
  };
  const renderStatTable = () => {
    if (!session || selectedCharaId == null) return;
    let d;
    try { d = session.getCharacterDetail(selectedCharaId); } catch (e) { return; }
    const all = arr(d.stats && d.stats.all);
    const q = String(statSearch || '').trim().toLowerCase();
    const rows = all.filter((s) => {
      if (activeStatGroup !== 'all' && s.cat !== activeStatGroup) return false;
      if (!q) return true;
      return [s.id, s.ko, s.cn, s.cat].some((v) => String(v == null ? '' : v).toLowerCase().indexOf(q) >= 0);
    });
    const w = $('stat-table-wrap');
    if (!w) return;
    const editableStatFields = ['stringValue', 'alterValue', 'rollValue', 'juqingValue', 'levelupValue', 'talentValue'];
    const fields = [['stringValue', '문자'], ['bornValue', '출생'], ['alterValue', '변경'], ['fightValue', '전투'], ['rollValue', '판정'], ['juqingValue', '줄거리'], ['levelupValue', '레벨업'], ['talentValue', '재능'], ['persistentTotal', '합계']];
    w.innerHTML = '<table class="data-table"><thead><tr><th>ID</th><th>한글</th><th>분류</th>' + fields.map((f) => '<th>' + esc(f[1]) + '</th>').join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.map((s) => '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.ko || s.cn) + '</td><td>' + esc(s.cat) + '</td>' + fields.map((f) => {
        const v = s[f[0]];
        if (editableStatFields.indexOf(f[0]) < 0) return '<td class="readonly-cell">' + esc(v == null ? 0 : v) + '</td>';
        if (f[0] === 'stringValue') return '<td><input data-stat="' + esc(s.id) + '" data-field="stringValue" value="' + esc(v == null ? '' : v) + '"></td>';
        return '<td><input data-stat="' + esc(s.id) + '" data-field="' + esc(f[0]) + '" type="number" step="any" value="' + esc(v == null ? 0 : v) + '"></td>';
      }).join('') + '</tr>').join('') : '<tr><td colspan="' + (3 + fields.length) + '">검색 결과 없음</td></tr>') + '</tbody></table>';
    w.querySelectorAll('input[data-stat]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const sid = inp.getAttribute('data-stat');
        const field = inp.getAttribute('data-field');
        const raw = inp.value;
        const v = field === 'stringValue' ? raw : num(raw);
        applyMutation(() => session.updateCharacterStat(selectedCharaId, sid, field, v), '스탯 ' + sid + ' 변경');
      });
    });
  };
  const renderKungfu = () => {
    if (!session || selectedCharaId == null) return;
    let d;
    try { d = session.getCharacterDetail(selectedCharaId); } catch (e) { return; }
    const kbox = $('kungfu-box');
    if (kbox) {
      const rows = arr(d.kungfu);
      kbox.innerHTML = '<div class="box-head"><h3>무공</h3><button type="button" id="btn-add-kungfu">+ 무공 추가</button></div>' +
        '<table class="data-table"><thead><tr><th>ID</th><th>이름</th><th>레벨</th><th>경험치</th><th>숙련도</th><th>전투</th><th>폐기</th><th>최대</th><th></th></tr></thead><tbody>' +
        (rows.length ? rows.map((k) => '<tr><td>' + esc(k.id) + '</td><td>' + esc(k.ko || k.cn) + '</td><td><input data-kf="' + esc(k.id) + '" data-kf-field="lv" type="number" value="' + esc(k.lv) + '"></td><td><input data-kf="' + esc(k.id) + '" data-kf-field="exp" type="number" value="' + esc(k.exp) + '"></td><td><input data-kf="' + esc(k.id) + '" data-kf-field="proficiency" type="number" step="any" value="' + esc(k.proficiency) + '"></td><td><input data-kf="' + esc(k.id) + '" data-kf-field="inBattle" type="checkbox"' + (k.inBattle ? ' checked' : '') + '></td><td><input data-kf="' + esc(k.id) + '" data-kf-field="isAbolished" type="checkbox"' + (k.isAbolished ? ' checked' : '') + '></td><td>' + esc(k.maxLv) + '</td><td><button type="button" data-kf-remove="' + esc(k.id) + '">삭제</button></td></tr>').join('') : '<tr><td colspan="9">무공 없음</td></tr>') + '</tbody></table>';
      kbox.querySelectorAll('[data-kf]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const kid = inp.getAttribute('data-kf');
          const f = inp.getAttribute('data-kf-field');
          let v = inp.type === 'checkbox' ? inp.checked : (f === 'proficiency' ? num(inp.value) : int(inp.value));
          applyMutation(() => {
            const opt = {}; opt[f] = v;
            const fresh = session.getCharacterDetail(selectedCharaId);
            const cur = arr(fresh && fresh.kungfu).find((x) => String(x.id) === String(kid)) || {};
            return session.upsertCharacterKungfu(selectedCharaId, kid, Object.assign({ lv: cur.lv, exp: cur.exp, proficiency: cur.proficiency, inBattle: cur.inBattle, isAbolished: cur.isAbolished }, opt));
          }, '무공 변경');
        });
      });
      kbox.querySelectorAll('[data-kf-remove]').forEach((btn) => btn.addEventListener('click', () => {
        const kid = btn.getAttribute('data-kf-remove');
        applyMutation(() => session.removeCharacterKungfu(selectedCharaId, kid), '무공 삭제');
      }));
      const add = kbox.querySelector('#btn-add-kungfu');
      if (add) add.addEventListener('click', () => openKungfuPicker());
    }
    const tbox = $('trait-box');
    if (tbox) {
      const slots = arr(d.equipTraits);
      const learned = arr(d.traits);
      tbox.innerHTML = '<div class="box-head"><h3>특성</h3><button type="button" id="btn-add-trait">+ 특성 추가</button></div>' +
        '<div class="equip-trait-grid">' + Array.from({ length: 9 }, (_, i) => {
          const slot = i + 1;
          const cur = slots.find((x) => Number(x.slot) === slot) || {};
          return '<label>슬롯 ' + slot + '<select data-etrait="' + slot + '"><option value="">없음</option>' + arr(C.traits).filter((t) => t && t.id != null).map((t) => '<option value="' + esc(t.id) + '"' + (String(t.id) === String(cur.traitId) ? ' selected' : '') + '>' + esc(t.ko || t.cn || t.id) + '</option>').join('') + '</select></label>';
        }).join('') + '</div>' +
        '<table class="data-table"><thead><tr><th>ID</th><th>이름</th><th>보너스</th><th></th></tr></thead><tbody>' +
        (learned.length ? learned.map((t) => '<tr><td>' + esc(t.id) + '</td><td>' + esc(t.ko || t.cn) + '</td><td>' + esc(t.bonus) + '</td><td><button type="button" data-trait-remove="' + esc(t.id) + '">삭제</button></td></tr>').join('') : '<tr><td colspan="4">특성 없음</td></tr>') + '</tbody></table>';
      tbox.querySelectorAll('[data-etrait]').forEach((sel) => {
        sel.addEventListener('change', () => {
          const slot = int(sel.getAttribute('data-etrait'));
          applyMutation(() => session.setEquipTraitSlot(selectedCharaId, slot, sel.value || null), '장비 특성 변경');
        });
      });
      tbox.querySelectorAll('[data-trait-remove]').forEach((btn) => btn.addEventListener('click', () => {
        const tid = btn.getAttribute('data-trait-remove');
        applyMutation(() => session.removeCharacterTrait(selectedCharaId, tid), '특성 삭제');
      }));
      const add = tbox.querySelector('#btn-add-trait');
      if (add) add.addEventListener('click', () => openTraitPicker());
    }
  };
  const renderInventory = () => {
    if (!session) return;
    const slotsBox = $('equip-slot-box');
    if (slotsBox) {
      if (selectedCharaId == null) slotsBox.innerHTML = '';
      else {
        let d;
        try { d = session.getCharacterDetail(selectedCharaId); } catch (e) { d = null; }
        const slots = arr(d && d.equipSlots);
        const dyn = getDynamicSafe();
        const items = arr(session.listInventory());
        const renderOption = (it, selected) => '<option value="' + esc(it.id) + '"' + (selected ? ' selected' : '') + '>' + esc((it.ko || it.cn || it.id) + ' x' + it.amount) + '</option>';
        slotsBox.innerHTML = '<h3>장비 슬롯</h3><div class="equip-slot-grid">' + Array.from({ length: 3 }, (_, i) => {
          const cur = slots.find((s) => Number(s.slot) === i) || {};
          const curId = cur.id == null ? '' : String(cur.id);
          const hasCur = curId !== '' && curId !== '0';
          const curInItems = hasCur && items.some((it) => String(it.id) === curId);
          const prepend = hasCur && !curInItems
            ? '<option value="' + esc(curId) + '" selected>' + esc((cur.ko || cur.cn || cur.id) + ' (장착중)') + '</option>'
            : '';
          const opts = prepend + items.map((it) => renderOption(it, String(it.id) === String(cur.id))).join('');
          return '<label>슬롯 ' + i + '<select data-eqslot="' + i + '"><option value="">없음</option>' + opts + '</select></label>';
        }).join('') + '</div>';
        slotsBox.querySelectorAll('[data-eqslot]').forEach((sel) => {
          sel.addEventListener('change', () => {
            const slot = int(sel.getAttribute('data-eqslot'));
            applyMutation(() => session.setCharacterEquipSlot(selectedCharaId, slot, sel.value || null), '장비 슬롯 변경');
          });
        });
      }
    }
    const inv = arr(session.listInventory());
    const cats = ['all'].concat(Array.from(new Set(inv.map((it) => it.style || '기타'))));
    if (cats.indexOf(invCat) < 0) invCat = 'all';
    const csel = $('inv-cat');
    if (csel) {
      if (csel.options.length !== cats.length || csel.__cats !== cats.join('|')) {
        csel.__cats = cats.join('|');
        csel.innerHTML = cats.map((c) => '<option value="' + esc(c) + '">' + esc(c === 'all' ? '전체' : c) + '</option>').join('');
      }
      csel.value = invCat;
      csel.onchange = () => { invCat = csel.value || 'all'; renderInventoryTable(arr(session.listInventory())); };
    }
    const search = $('inv-search');
    if (search && !search.__wokBound) { search.__wokBound = true; search.addEventListener('input', () => { invSearch = search.value || ''; renderInventoryTable(arr(session.listInventory())); }); }
    renderInventoryTable(inv);
    const add = $('btn-add-item');
    if (add && !add.__wokBound) { add.__wokBound = true; add.addEventListener('click', () => openItemPicker()); }
    const forged = $('forged-box');
    if (forged) {
      const dyn = getDynamicSafe();
      const ce = arr(dyn.customEquips);
      const ck = arr(dyn.customKungfu);
      forged.innerHTML = '<div class="forged-cols"><div><h3>커스텀 장비</h3>' + (ce.length ? '<ul>' + ce.map((x) => '<li>' + esc(x.ko || x.cn || x.id) + ' <small>' + esc(x.id) + '</small></li>').join('') + '</ul>' : '<p class="muted">없음</p>') + '</div><div><h3>커스텀 무공</h3>' + (ck.length ? '<ul>' + ck.map((x) => '<li>' + esc(x.ko || x.cn || x.id) + ' <small>' + esc(x.id) + '</small></li>').join('') + '</ul>' : '<p class="muted">없음</p>') + '</div></div>';
    }
  };
  const renderInventoryTable = (inv) => {
    const q = invSearch.trim().toLowerCase();
    const rows = arr(inv).filter((it) => {
      if (invCat !== 'all' && (it.style || '기타') !== invCat) return false;
      if (!q) return true;
      return [it.id, it.ko, it.cn, it.style].some((v) => String(v == null ? '' : v).toLowerCase().indexOf(q) >= 0);
    });
    const w = $('inv-table-wrap');
    if (!w) return;
    w.innerHTML = '<table class="data-table"><thead><tr><th>ID</th><th>이름</th><th>분류</th><th>별</th><th>가격</th><th>장비</th><th>수량</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map((it) => '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.ko || it.cn) + '</td><td>' + esc(it.style) + '</td><td>' + esc(it.star) + '</td><td>' + esc(it.price) + '</td><td>' + esc(it.equipSlot) + '</td><td><input data-item="' + esc(it.id) + '" type="number" value="' + esc(it.amount) + '"></td><td><button type="button" data-item-remove="' + esc(it.id) + '">삭제</button></td></tr>').join('') : '<tr><td colspan="8">아이템 없음</td></tr>') + '</tbody></table>';
    w.querySelectorAll('input[data-item]').forEach((inp) => {
      inp.addEventListener('change', () => applyMutation(() => session.upsertInventoryItem(inp.getAttribute('data-item'), intInput(inp.value)), '아이템 수량 변경'));
    });
    w.querySelectorAll('[data-item-remove]').forEach((btn) => btn.addEventListener('click', () => applyMutation(() => session.removeInventoryItem(btn.getAttribute('data-item-remove')), '아이템 삭제')));
  };
  const renderParty = () => {
    if (!session) return;
    const chars = arr(session.listCharacters());
    const box = $('party-box');
    if (box) {
      box.innerHTML = '<h3>파티</h3><table class="data-table"><thead><tr><th>ID</th><th>이름</th><th>주인공</th><th>풀팀</th><th>추종</th></tr></thead><tbody>' +
        (chars.length ? chars.map((c) => '<tr><td>' + esc(c.id) + '</td><td>' + esc(c.ko || c.name || c.cn) + '</td><td>' + esc(c.isHero ? '예' : '') + '</td><td><input type="checkbox" data-party="' + esc(c.id) + '" data-party-kind="inFullTeam"' + (c.inFullTeam ? ' checked' : '') + '></td><td><input type="checkbox" data-party="' + esc(c.id) + '" data-party-kind="inFollow"' + (c.inFollow ? ' checked' : '') + '></td></tr>').join('') : '<tr><td colspan="5">캐릭터 없음</td></tr>') + '</tbody></table>';
      box.querySelectorAll('[data-party]').forEach((chk) => {
        chk.addEventListener('change', () => {
          const cid = chk.getAttribute('data-party');
          const kind = chk.getAttribute('data-party-kind');
          const freshChars = arr(session.listCharacters());
          const cur = freshChars.find((c) => String(c.id) === String(cid)) || {};
          const opt = { inFullTeam: kind === 'inFullTeam' ? chk.checked : Boolean(cur.inFullTeam), inFollow: kind === 'inFollow' ? chk.checked : Boolean(cur.inFollow) };
          applyMutation(() => session.setPartyMembership(cid, opt), '파티 변경');
        });
      });
    }
    const fb = $('flag-box');
    if (fb) {
      const q = flagSearch.trim().toLowerCase();
      const flags = arr(session.listFlags(q)).filter((f) => !q || String(f.key).toLowerCase().indexOf(q) >= 0 || String(f.value).toLowerCase().indexOf(q) >= 0);
      fb.innerHTML = '<div class="flag-add"><input id="flag-new-key" placeholder="새 플래그 키"><input id="flag-new-val" type="number" placeholder="값"><select id="flag-new-kind"><option value="str">str</option><option value="int">int</option></select><button type="button" id="btn-add-flag">+ 플래그</button></div>' +
        '<table class="data-table"><thead><tr><th>키</th><th>값</th><th>종류</th><th></th></tr></thead><tbody>' +
        (flags.length ? flags.map((f) => '<tr><td>' + esc(f.key) + '</td><td><input data-flag="' + esc(f.key) + '" data-flag-kind="' + esc(f.kind) + '" type="number" value="' + esc(f.value) + '"></td><td>' + esc(f.kind) + '</td><td><button type="button" data-flag-zero="' + esc(f.key) + '" data-flag-kind="' + esc(f.kind) + '">0</button></td></tr>').join('') : '<tr><td colspan="4">플래그 없음</td></tr>') + '</tbody></table>';
      fb.querySelectorAll('input[data-flag]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const key = inp.getAttribute('data-flag');
          const kind = inp.getAttribute('data-flag-kind');
          const val = intInput(inp.value);
          applyMutation(() => kind === 'int' ? session.setIntFlag(key, val) : session.setStrFlag(key, val), '플래그 변경');
        });
      });
      fb.querySelectorAll('[data-flag-zero]').forEach((btn) => btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-flag-zero');
        const kind = btn.getAttribute('data-flag-kind');
        applyMutation(() => kind === 'int' ? session.setIntFlag(key, 0) : session.setStrFlag(key, 0), '플래그 0');
      }));
      const add = fb.querySelector('#btn-add-flag');
      if (add) add.addEventListener('click', () => {
        const k = fb.querySelector('#flag-new-key').value.trim();
        const v = intInput(fb.querySelector('#flag-new-val').value);
        const kindEl = fb.querySelector('#flag-new-kind');
        const kind = kindEl ? kindEl.value : 'str';
        if (k) applyMutation(() => kind === 'int' ? session.setIntFlag(k, v) : session.setStrFlag(k, v), '플래그 추가');
      });
    }
    const fs = $('flag-search');
    if (fs && !fs.__wokBound) { fs.__wokBound = true; fs.addEventListener('input', () => { flagSearch = fs.value || ''; renderParty(); }); }
  };
  const renderAtlas = () => {
    if (!session) return;
    const box = $('atlas-box');
    if (box) {
      const atlas = arr(C.codeAtlas);
      box.innerHTML = '<table class="data-table"><thead><tr><th>ID</th><th>항목 · 구조</th><th>세부 규격 · 공식</th></tr></thead><tbody>' +
        (atlas.length ? atlas.map((a) => '<tr><td>' + esc(a.id) + '</td><td>' + esc(a.title || a.ko || '') + '</td><td>' + esc(a.detail || a.cn || a.en || '') + '</td></tr>').join('') : '<tr><td colspan="3">도감 없음</td></tr>') + '</tbody></table>';
    }
    const vb = $('validate-box');
    if (vb) {
      let v = null;
      try { v = session.validate(); } catch (e) { v = { ok: false, errors: [e.message], warnings: [] }; }
      if (Array.isArray(v)) v = { ok: v.length === 0, errors: v, warnings: [] };
      const ok = v && (v.ok === true || v.valid === true || (!v.errors && !v.warnings));
      const errors = arr(v && (v.errors || v.error || v.messages));
      const warnings = arr(v && (v.warnings || v.warning));
      vb.innerHTML = '<h3>검증</h3><p class="' + (ok ? 'ok' : 'error') + '">' + (ok ? '정상' : '확인 필요') + '</p>' +
        (errors.length ? '<ul class="errors">' + errors.map((x) => '<li>' + esc(typeof x === 'string' ? x : (x.message || JSON.stringify(x))) + '</li>').join('') + '</ul>' : '') +
        (warnings.length ? '<ul class="warnings">' + warnings.map((x) => '<li>' + esc(typeof x === 'string' ? x : (x.message || JSON.stringify(x))) + '</li>').join('') + '</ul>' : '');
    }
    renderRawJson();
  };
  const renderRawJson = () => {
    const el = $('raw-json-box');
    if (!el) return;
    let obj = { session: null, character: null };
    try { obj.session = session ? session.getSummary() : null; } catch (e) { obj.session = { error: e.message }; }
    try {
      if (session && selectedCharaId != null) {
        const d = session.getCharacterDetail(selectedCharaId);
        obj.character = { basic: d.basic, statCount: arr(d.stats && d.stats.all).length, kungfuCount: arr(d.kungfu).length, traitCount: arr(d.traits).length };
      }
    } catch (e) { obj.character = { error: e.message }; }
    el.innerHTML = '<pre>' + esc(JSON.stringify(obj, null, 2)) + '</pre>';
  };
  const renderPickerList = () => {
    const q = (($('picker-search') && $('picker-search').value) || '').trim().toLowerCase();
    const shown = arr(pickerItems).filter((x) => {
      if (!q) return true;
      return [x.id, x.ko, x.cn, x.en, x.name].some((v) => String(v == null ? '' : v).toLowerCase().indexOf(q) >= 0);
    }).slice(0, 80);
    const list = $('picker-list');
    if (!list) return;
    const dlg = $('picker-dialog');
    list.innerHTML = shown.map((x) => '<button type="button" class="picker-item" data-pick="' + esc(x.id) + '"><strong>' + esc(x.ko || x.cn || x.name || x.id) + '</strong><span>' + esc(x.cn || x.en || x.id) + '</span></button>').join('');
    list.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-pick');
      try { if (pickerHandler) pickerHandler(id); if (dlg) dlg.close(); } catch (e) { setStatus('선택 실패: ' + e.message, true); }
    }));
  };
  const openPicker = (title, items, onPick) => {
    const dlg = $('picker-dialog');
    if (!dlg) return;
    pickerHandler = onPick;
    pickerItems = arr(items);
    const tt = $('picker-title'); if (tt) tt.textContent = title;
    const ss = $('picker-search'); if (ss) ss.value = '';
    const ps = $('picker-search');
    if (ps && !ps.__wokBound) { ps.__wokBound = true; ps.addEventListener('input', renderPickerList); }
    renderPickerList();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  };
  const closePicker = () => { const d = $('picker-dialog'); if (!d) return; if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const dedupeById = (list) => {
    const seen = new Set();
    return arr(list).filter((x) => {
      if (!x || x.id == null) return false;
      const k = String(x.id);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const openKungfuPicker = () => {
    if (selectedCharaId == null) return;
    const dyn = getDynamicSafe();
    const items = dedupeById(arr(C.kungfu).concat(arr(dyn.customKungfu)));
    openPicker('무공 추가', items, (id) => applyMutation(() => {
      const d = session.getCharacterDetail(selectedCharaId);
      const cur = arr(d && d.kungfu).find((x) => String(x.id) === String(id));
      const fields = cur ? {
        lv: cur.lv,
        exp: cur.exp,
        proficiency: cur.proficiency,
        isAbolished: Boolean(cur.isAbolished),
        inBattle: Boolean(cur.inBattle)
      } : { lv: 1, exp: 0, proficiency: 0, isAbolished: false, inBattle: false };
      return session.upsertCharacterKungfu(selectedCharaId, id, fields);
    }, '무공 추가'));
  };
  const openTraitPicker = () => {
    if (selectedCharaId == null) return;
    const items = arr(C.traits);
    openPicker('특성 추가', items, (id) => applyMutation(() => session.addCharacterTrait(selectedCharaId, id), '특성 추가'));
  };
  const openItemPicker = () => {
    const dyn = getDynamicSafe();
    const items = dedupeById(arr(C.items).concat(arr(dyn.customEquips), arr(dyn.customItems)).filter((x) => String(x && x.id) !== '999'));
    openPicker('아이템 추가', items, (id) => applyMutation(() => {
      const cur = arr(session.listInventory()).find((x) => String(x && x.id) === String(id));
      const raw = cur && cur.amount != null ? String(cur.amount).trim() : '';
      const amount = cur && /^\d+$/.test(raw) && BigInt(raw) >= 1n ? intInput(String(BigInt(raw) + 1n)) : 1;
      return session.upsertInventoryItem(id, amount);
    }, '아이템 추가'));
  };
  const maxDatFileBytes = (MsgPack && MsgPack.MAX_COMPRESSED_DAT_BYTES) || (32 * 1024 * 1024);
  const readFileAsText = (file) => {
    if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0 || file.size > maxDatFileBytes) return Promise.reject(new Error('세이브 파일 크기가 허용 범위(최대 32 MiB)를 벗어났습니다.'));
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('파일을 읽을 수 없습니다.'));
      r.readAsText(file, 'utf-8');
    });
  };
  const openFile = async (file) => {
    if (!file || busy) return;
    if (file.name && !/\.dat$/i.test(file.name)) { setStatus('.dat 파일만 열 수 있습니다.', true); return; }
    if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0 || file.size > maxDatFileBytes) { setStatus('세이브 파일 크기가 허용 범위(최대 32 MiB)를 벗어났습니다.', true); return; }
    if (!confirmDiscardIfDirty()) return;
    setBusy(true);
    try {
      const text = await readFileAsText(file);
      await loadFromDatText(text, file.name || 'save.dat', { sourceKind: 'local', keepBusy: true });
    } catch (e) { setStatus(e.message, true); }
    finally { setBusy(false); }
  };
  const downloadDat = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const datText = await session.encodeAsync();
      const blob = new Blob([datText], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'save.dat';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setStatus('DAT 다운로드');
    } catch (e) { setStatus('인코딩 실패: ' + e.message, true); } finally { setBusy(false); }
  };
  const sendNative = (kind, extra) => {
    if (!isWebView2 || !window.chrome.webview.postMessage) return 0;
    const reqSeq = ++seq;
    const msg = Object.assign({ id: 'req-' + reqSeq, seq: reqSeq, kind, session: nativeSession, name: fileName || null, base64: null }, extra || {});
    try { window.chrome.webview.postMessage(msg); return reqSeq; } catch (e) { setStatus('네이티브 전송 실패: ' + e.message, true); return 0; }
  };
  const decodeB64Text = (b64) => {
    const bytes = MsgPack.base64ToBytes ? MsgPack.base64ToBytes(b64) : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  };
  const handleNativeReply = async (reply) => {
    if (!reply || typeof reply !== 'object') return;
    const matched = Boolean(pendingNative && reply.seq != null && Number(reply.seq) === Number(pendingNative.seq));
    if (!matched) {
      if (reply.base64 && reply.session) postNativeNotice({ kind: 'abort-open', session: reply.session, dirty: dirty });
      return;
    }
    const pending = pendingNative;
    pendingNative = null;
    if (reply.cancelled) {
      syncNativeDirty();
      setBusy(false);
      return;
    }
    if (reply.error || reply.ok === false) {
      if (pending.kind === 'commit-open' && pending.openSession) {
        postNativeNotice({ kind: 'abort-open', session: pending.openSession, dirty: dirty });
      } else {
        syncNativeDirty();
      }
      setStatus('네이티브 오류: ' + (typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error || '요청 실패')), true);
      setBusy(false);
      return;
    }
    if (pending.kind === 'ready' || pending.kind === 'open') {
      if (!reply.base64) {
        syncNativeDirty();
        setBusy(false);
        return;
      }
      if (pending.kind === 'ready' && (session !== null || sourceKind !== 'none' || dirty || sessionEpoch !== pending.sessionEpoch)) {
        postNativeNotice({ kind: 'abort-open', session: reply.session || null, dirty: dirty });
        setBusy(false);
        return;
      }
      try {
        const text = decodeB64Text(reply.base64);
        const parsed = await Core.loadSessionAsync(text, reply.name || 'save.dat');
        preflightSession(parsed);
        if (pending.kind === 'ready' && (session !== null || sourceKind !== 'none' || dirty || sessionEpoch !== pending.sessionEpoch)) {
          postNativeNotice({ kind: 'abort-open', session: reply.session || null, dirty: dirty });
          setBusy(false);
          return;
        }
        const openToken = reply.session || null;
        const commitSeq = sendNative('commit-open', { session: openToken, dirty: false });
        if (!commitSeq) {
          postNativeNotice({ kind: 'abort-open', session: openToken, dirty: dirty });
          setStatus('네이티브 열기 커밋 실패', true);
          setBusy(false);
          return;
        }
        pendingNative = { seq: commitSeq, kind: 'commit-open', parsedSession: parsed, name: reply.name || fileName || 'save.dat', openSession: openToken };
        return;
      } catch (e) {
        postNativeNotice({ kind: 'abort-open', session: reply.session || null, dirty: dirty });
        setStatus('네이티브 불러오기 실패: ' + e.message, true);
        setBusy(false);
        return;
      }
    }
    if (pending.kind === 'commit-open') {
      if (pending.openSession && String(reply.session || '') !== String(pending.openSession)) {
        postNativeNotice({ kind: 'abort-open', session: pending.openSession, dirty: dirty });
        setStatus('네이티브 열기 토큰 불일치', true);
        setBusy(false);
        return;
      }
      try {
        activateLoadedSession(pending.parsedSession, reply.name || pending.name || 'save.dat', { sourceKind: 'native', nativeSession: reply.session || pending.openSession });
      } catch (e) {
        setStatus('네이티브 세션 활성화 실패: ' + e.message, true);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (pending.kind === 'save') {
      if (reply.kind !== 'save' || sourceKind !== 'native' || sessionEpoch !== pending.sessionEpoch) {
        syncNativeDirty();
        setBusy(false);
        return;
      }
      nativeSession = reply.session != null ? reply.session : nativeSession;
      if (reply.name) fileName = reply.name;
      if (editRevision === pending.saveRevision) markDirty(false, true);
      else syncNativeDirty();
      setBusy(false);
      setFileBadge();
      refreshTransportUi();
      setStatus('네이티브 저장 완료');
      return;
    }
    if (pending.kind === 'save-copy') {
      if (reply.kind !== 'save-copy' || sessionEpoch !== pending.sessionEpoch) {
        syncNativeDirty();
        setBusy(false);
        return;
      }
      if (editRevision === pending.saveRevision && sourceKind !== 'native') markDirty(false, true);
      else syncNativeDirty();
      setBusy(false);
      setFileBadge();
      refreshTransportUi();
      setStatus('복사본 저장 완료');
      return;
    }
    setBusy(false);
  };
  const wireNative = () => {
    if (!isWebView2) return;
    const bar = $('native-bar'); if (bar) bar.hidden = false;
    const open = $('btn-native-open');
    if (open) open.addEventListener('click', () => {
      if (busy) return;
      if (!confirmDiscardIfDirty()) return;
      setBusy(true);
      const s = sendNative('open');
      if (!s) { setBusy(false); return; }
      pendingNative = { seq: s, kind: 'open', sessionEpoch: sessionEpoch, saveRevision: editRevision };
    });
    const save = $('btn-native-save');
    if (save) save.addEventListener('click', async () => {
      if (busy) return;
      if (!session) { setStatus('세이브 없음', true); return; }
      if (sourceKind !== 'native' || !nativeSession) { setStatus('네이티브 세이브가 아닙니다.', true); return; }
      const rev = editRevision;
      const ep = sessionEpoch;
      setBusy(true);
      try {
        const text = await session.encodeAsync();
        const b64 = MsgPack.bytesToBase64(new TextEncoder().encode(text));
        const s = sendNative('save', { base64: b64, name: fileName || 'save.dat' });
        if (!s) { setBusy(false); return; }
        pendingNative = { seq: s, kind: 'save', sessionEpoch: ep, saveRevision: rev };
      } catch (e) { setStatus('인코딩 실패: ' + e.message, true); setBusy(false); }
    });
    const copy = $('btn-native-save-copy');
    if (copy) copy.addEventListener('click', async () => {
      if (busy) return;
      if (!session) { setStatus('세이브 없음', true); return; }
      const rev = editRevision;
      const ep = sessionEpoch;
      setBusy(true);
      try {
        const text = await session.encodeAsync();
        const b64 = MsgPack.bytesToBase64(new TextEncoder().encode(text));
        const s = sendNative('save-copy', { base64: b64, name: fileName || 'save.dat' });
        if (!s) { setBusy(false); return; }
        pendingNative = { seq: s, kind: 'save-copy', sessionEpoch: ep, saveRevision: rev };
      } catch (e) { setStatus('인코딩 실패: ' + e.message, true); setBusy(false); }
    });
    window.chrome.webview.addEventListener('message', (ev) => {
      let data = ev.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { setStatus('네이티브 응답 파싱 실패', true); return; } }
      handleNativeReply(data);
    });
    setBusy(true);
    const readySeq = sendNative('ready');
    if (readySeq) pendingNative = { seq: readySeq, kind: 'ready', sessionEpoch: sessionEpoch, saveRevision: editRevision };
    else setBusy(false);
  };
  const refreshServerSaves = async () => {
    if (!isHttp) return;
    try {
      const r = await fetch('/api/saves', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      saves = arr(j.saves);
      if (j.csrfToken) csrfToken = j.csrfToken;
      if (j.token) csrfToken = j.token;
      const bar = $('server-bar'); if (bar) bar.hidden = false;
      const sel = $('server-save-select');
      const prevVal = sel ? (sel.value || '') : '';
      const names = saves.map((s) => typeof s === 'string' ? s : ((s && (s.name || s.fileName)) || ''));
      const preferred = (sourceKind === 'server' && serverLoadedName && names.indexOf(serverLoadedName) >= 0) ? serverLoadedName : (prevVal && names.indexOf(prevVal) >= 0 ? prevVal : (names[0] || ''));
      if (sel) {
        sel.innerHTML = names.map((n) => '<option value="' + esc(n) + '"' + (n === preferred ? ' selected' : '') + '>' + esc(n || '(이름 없음)') + '</option>').join('');
        sel.value = preferred;
      }
      return j;
    } catch (e) { setStatus('서버 목록 실패: ' + e.message, true); }
  };
  const serverLoad = async (name, skipConfirm) => {
    if (!isHttp || !name || busy) return;
    if (!skipConfirm && !confirmDiscardIfDirty()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/load?name=' + encodeURIComponent(name), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const b64 = j.base64 || j.data || '';
      if (!b64) throw new Error('DAT 데이터가 없습니다.');
      const text = decodeB64Text(b64);
      const loadedName = j.name || name;
      await loadFromDatText(text, loadedName, { sourceKind: 'server', serverLoadedName: loadedName, serverExpectedSha: j.sha256 || '', keepBusy: true });
      const sel = $('server-save-select');
      if (sel) sel.value = loadedName;
      setBusy(false);
      setStatus('서버에서 불러옴: ' + loadedName);
    } catch (e) { setBusy(false); setStatus('서버 불러오기 실패: ' + e.message, true); }
  };
  const wireServer = () => {
    if (!isHttp) return;
    const bar = $('server-bar');
    refreshServerSaves().then((j) => {
      if (bar && j) bar.hidden = false;
      if (saves.length) {
        const first = typeof saves[0] === 'string' ? saves[0] : (saves[0] && (saves[0].name || saves[0].fileName));
        if (first && !session && sourceKind === 'none' && !dirty && !busy) serverLoad(first, true);
      }
    });
    const load = $('btn-server-load');
    if (load) load.addEventListener('click', () => {
      const sel = $('server-save-select');
      if (sel && sel.value) serverLoad(sel.value, false);
    });
    const save = $('btn-server-save');
    if (save) save.addEventListener('click', async () => {
      if (!session || busy || sourceKind !== 'server' || !serverLoadedName || !serverExpectedSha) { setStatus('서버 세이브 없음', true); return; }
      const rev = editRevision;
      setBusy(true);
      try {
        if (!csrfToken) await refreshServerSaves();
        const datText = await session.encodeAsync();
        const base64 = MsgPack.bytesToBase64(new TextEncoder().encode(datText));
        const r = await fetch('/api/save', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Wok-Token': csrfToken || '' }, body: JSON.stringify({ name: serverLoadedName, base64, expectedSha256: serverExpectedSha }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rj = await r.json().catch(() => ({}));
        if (rj.sha256) serverExpectedSha = rj.sha256;
        if (editRevision === rev) markDirty(false);
        await refreshServerSaves();
        setStatus('서버 저장 완료');
      } catch (e) { setStatus('서버 저장 실패: ' + e.message, true); } finally { setBusy(false); }
    });
  };
  const wireOffline = () => {
    const input = $('file-input');
    const open = $('btn-file-open');
    if (open && input) open.addEventListener('click', () => input.click());
    if (input) input.addEventListener('change', () => { const f = input.files && input.files[0]; if (f) openFile(f); input.value = ''; });
    const dl = $('btn-download-dat');
    if (dl) dl.addEventListener('click', downloadDat);
    const demo = $('btn-load-demo');
    if (demo) demo.addEventListener('click', async () => {
      if (busy) return;
      if (!confirmDiscardIfDirty()) return;
      setBusy(true);
      try {
        if (!Core.createDemoDatAsync) throw new Error('데모 생성기를 사용할 수 없습니다.');
        const dat = await Core.createDemoDatAsync();
        await loadFromDatText(dat, 'bigbang1data.dat', { sourceKind: 'demo', keepBusy: true });
        setBusy(false);
        setStatus('데모 세이브 생성');
      } catch (e) { setBusy(false); setStatus('데모 생성 실패: ' + e.message, true); }
    });
    document.body.addEventListener('dragover', (ev) => { ev.preventDefault(); document.body.classList.add('dragging'); });
    document.body.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
    document.body.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      document.body.classList.remove('dragging');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) await openFile(f);
    });
  };
  const wireTheme = () => {
    const b = $('btn-theme');
    if (!b) return;
    const saved = (() => { try { return localStorage.getItem('wok-theme'); } catch (e) { return ''; } })();
    if (saved) document.documentElement.dataset.theme = saved;
    b.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = cur;
      try { localStorage.setItem('wok-theme', cur); } catch (e) {}
      b.textContent = cur === 'light' ? '테마: 밝게' : '테마: 어둡게';
    });
    const cur = document.documentElement.dataset.theme || 'dark';
    b.textContent = cur === 'light' ? '테마: 밝게' : '테마: 어둡게';
  };
  const wirePicker = () => {
    const d = $('picker-dialog');
    const close = $('btn-picker-close');
    if (close) close.addEventListener('click', closePicker);
    if (d) d.addEventListener('cancel', (ev) => { ev.preventDefault(); closePicker(); });
    if (d) d.addEventListener('close', () => { pickerItems = []; pickerHandler = null; });
    const ps = $('picker-search');
    if (ps && !ps.__wokBound) { ps.__wokBound = true; ps.addEventListener('input', renderPickerList); }
  };
  const wireKeys = () => {
    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); const dl = $('btn-download-dat'); if (!isWebView2 && !isHttp && dl && !dl.disabled) dl.click(); }
    });
    window.addEventListener('beforeunload', (ev) => {
      if (dirty && !window.__WOKSE_SKIP_CONFIRM) {
        ev.preventDefault();
        ev.returnValue = '';
        return '';
      }
    });
  };
  const init = async () => {
    wireTheme();
    wireTabs();
    wirePicker();
    wireOffline();
    wireKeys();
    if (isWebView2) wireNative();
    if (isHttp) wireServer();
    selectTab('summary');
    setFileBadge();
    refreshTransportUi();
    if (!isWebView2 && !isHttp) setStatus('로컬 DAT를 열거나 데모를 생성하세요.');
    if (window.hasUnsavedChanges == null) window.hasUnsavedChanges = function () { return dirty; };
  };
  window.WokEditorUI = {
    isBusy: function () { return busy; },
    isDirty: function () { return dirty; },
    getSession: function () { return session; },
    getNativeSession: function () { return nativeSession; },
    getSourceKind: function () { return sourceKind; },
    loadFromDatText: loadFromDatText,
    openFile: openFile,
    selectTab: selectTab
  };
  window.hasUnsavedChanges = function () { return dirty; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
