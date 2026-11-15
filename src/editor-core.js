(function(root,factory){if(typeof module==='object'&&module.exports){module.exports=factory(require('./msgpack-codec.js'),require('./catalog-data.js'));}else{root.WokEditorCore=factory(root.WokMsgPack,root.WokCatalog);}})(typeof globalThis!=='undefined'?globalThis:this,function(WokMsgPack,WokCatalog){
'use strict';
const PRESETS=[
{id:'rich_epiphany',titleKo:'풍요로운 시작',descKo:'돈, 깨달음, 삽 내구도를 넉넉하게 보정합니다.'},
{id:'hero_max_growth',titleKo:'영웅 성장 극대화',descKo:'영웅의 레벨, 재능, HP/MP를 크게 보정합니다.'},
{id:'hero_six_attributes',titleKo:'육성 속성 강화',descKo:'영웅의 육성 속성 2001~2006을 40 이상으로 보정합니다.'},
{id:'hero_all_mastery',titleKo:'모든 숙련 강화',descKo:'영웅의 숙련 속성 3001~3014을 220 이상으로 보정합니다.'},
{id:'master_all_kungfu',titleKo:'무공 완성',descKo:'대상 캐릭터의 모든 무공 레벨과 숙련도를 최대치로 보정합니다.'},
{id:'party_recover_boost',titleKo:'파티 회복 강화',descKo:'영웅과 추종자의 재능, 관계, 무공 숙련, HP/MP, 이동속도를 보정합니다.'}
];
const ROOT_LEN=54, CHARA_LEN=29, VERSION='Vesion_20240907';
const MIN_I64 = -9223372036854775808n, MAX_U64 = 18446744073709551615n;
const MIN_SAFE_BI = BigInt(Number.MIN_SAFE_INTEGER), MAX_SAFE_BI = BigInt(Number.MAX_SAFE_INTEGER);
const INT_TAGS = new Set(['pfixint','nfixint','u8','u16','u32','u64','i8','i16','i32','i64']);
const ARR_TAGS = new Set(['arr','arr16','arr32']), STR_TAGS = new Set(['str','str8','str16','str32']);
const isArr=n=>!!n&&ARR_TAGS.has(n.t)&&Array.isArray(n.v);
const isStrNode=n=>!!n&&STR_TAGS.has(n.t)&&typeof n.v==='string';
const isNil=n=>!!n&&n.t==='nil';
const av=n=>isArr(n)?n.v:null;
const sv=n=>isStrNode(n)?n.v:'';
const nv=n=>n&&typeof n.v==='number'&&isFinite(n.v)?n.v:0;
const isAsciiSignedDigits=str=>{if(typeof str!=='string'||str.length===0)return false;let i=0;if(str.charCodeAt(0)===45){if(str.length<2)return false;i=1;}for(;i<str.length;i++){const c=str.charCodeAt(i);if(c<48||c>57)return false;}return true;};
const bi=n=>{if(!n)return 0n;if(typeof n.v==='bigint')return n.v;if(typeof n.v==='number'&&Number.isFinite(n.v))return BigInt(Math.trunc(n.v));if(typeof n.v==='string'&&isAsciiSignedDigits(n.v.trim()))return BigInt(n.v.trim());return 0n;};
const iv=n=>{const b=bi(n);return(b>=MIN_SAFE_BI&&b<=MAX_SAFE_BI)?Number(b):b.toString();};
const fv=n=>nv(n);
const boolv=n=>!!(n&&n.v);
const s=x=>x===null||x===undefined?'':String(x);
const isIntNode=n=>!!n&&INT_TAGS.has(n.t)&&((typeof n.v==='bigint'&&n.v>=MIN_I64&&n.v<=MAX_U64)||(typeof n.v==='number'&&Number.isFinite(n.v)&&Number.isInteger(n.v)&&BigInt(n.v)>=MIN_I64&&BigInt(n.v)<=MAX_U64));
const maxBig=(a,b)=>(a>=b?a:b);
const toBigIntChecked=(v,label)=>{let b;if(typeof v==='bigint')b=v;else if(typeof v==='number'){if(!Number.isFinite(v)||!Number.isInteger(v))throw new Error((label||'정수 값')+'이(가) 유효한 정수가 아닙니다.');b=BigInt(v);}else if(typeof v==='string'){const t=v.trim();if(!isAsciiSignedDigits(t))throw new Error((label||'정수 값')+'이(가) 유효한 정수가 아닙니다.');b=BigInt(t);}else throw new Error((label||'정수 값')+'이(가) 유효한 정수가 아닙니다.');if(b<MIN_I64||b>MAX_U64)throw new Error((label||'정수 값')+'이(가) 64비트 MessagePack 정수 범위를 벗어났습니다.');return b;};
const toInt=(v,d=0)=>{const n=Number(v);return isFinite(n)?Math.trunc(n):d;};
const toFloat=(v,d=0)=>{const n=Number(v);return isFinite(n)?n:d;};
const toFloat32Checked=(v,label)=>{const n=Number(v);const f=Math.fround(n);if(!Number.isFinite(n)||!Number.isFinite(f))throw new Error((label||'실수 값')+'이(가) 유한한 float32 범위를 벗어났습니다.');return f;};
const isFiniteF32Node=n=>!!n&&(n.t==='f32'||n.t==='f64')&&typeof n.v==='number'&&Number.isFinite(n.v)&&Number.isFinite(Math.fround(n.v));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const splitCsv=v=>s(v).split(',');
const parseKfRaw=raw=>{const p=splitCsv(raw);return{id:s(p[0]),lv:toInt(p[1],0),exp:toInt(p[2],0),proficiency:toInt(p[3],0),isAbolished:s(p[4]).trim().toLowerCase()==='true',parts:p};};
const kfRaw=(id,lv,exp,prof,ab)=>[s(id),toInt(lv),toInt(exp),toInt(prof),ab?'True':'False'].join(',');
const fmtNum=x=>Number.isInteger(x)?String(x):String(Number(Number(x).toFixed(4)));
const parseStatRaw=raw=>{const p=splitCsv(raw);return{id:s(p[0]),stringValue:s(p[1]),bornValue:toFloat(p[2],0),alterValue:toFloat(p[3],0),fightValue:toFloat(p[4],0),rollValue:toFloat(p[5],0),juqingValue:toFloat(p[6],0),levelupValue:toFloat(p[7],0),talentValue:toFloat(p[8],0),parts:p,persistentTotal:toFloat(p[5],0)+toFloat(p[7],0)+toFloat(p[8],0)+toFloat(p[3],0)+toFloat(p[6],0)};};
const statRaw=o=>[s(o.id),s(o.stringValue),fmtNum(toFloat(o.bornValue)),fmtNum(toFloat(o.alterValue)),fmtNum(toFloat(o.fightValue)),fmtNum(toFloat(o.rollValue)),fmtNum(toFloat(o.juqingValue)),fmtNum(toFloat(o.levelupValue)),fmtNum(toFloat(o.talentValue))].join(',');
const emptyEquipTraits=()=>Array.from({length:9},(_,i)=>`${i+1}|`);
const findMap=arr=>{const m=new Map();(arr||[]).forEach(x=>{if(x&&x.id!==undefined)m.set(s(x.id),x);});return m;};
const indexOfId=(list,id)=>list.findIndex(x=>s(x&&typeof x==='object'&&'v' in x?x.v:x)===s(id));
const setNum=(node,fn,v)=>{if(!node)return;fn(node,v);};
const getHero=session=>(av(session.ast.v[3])||[]).find(c=>isArr(c)&&s(sv(c.v[1]))===s(sv(session.ast.v[9])))||(av(session.ast.v[3])||[])[0]||null;
const getPlayerId=ast=>sv(ast.v[9]);
const catalogName=(obj,lang,id)=>{const o=obj&&obj.get(s(id));return o?s(o[lang]):'';};
const parseCustomEquip=raw=>{const p=s(raw).split(';');return{id:s(p[0]),name:s(p[1]),nameEn:s(p[2]),ko:s(p[1]),cn:s(p[1]),en:s(p[2]),style:s(p[3]),raw:s(raw),isCustom:true,kind:'equip'};};
const parseCustomKungfu=raw=>{const p=s(raw).split(';');return{id:s(p[0]),star:toInt(p[1],0),name:s(p[2]),nameTrans:s(p[3]),ko:s(p[2]),cn:s(p[3]),en:s(p[3]),icon:s(p[4]),bookIcon:s(p[5]),origin:s(p[6]),lv:toInt(p[7],0),style:s(p[8]),raw:s(raw),isCustom:true,kind:'kungfu',maxLv:20,dmg:0,mp:0};};
const parseCustomItem=raw=>{const p=s(raw).split(';');return{id:s(p[0]),name:s(p[1]),nameTrans:s(p[2]),bookIcon:s(p[3]),style:s(p[4]),star:toInt(p[5],0),value:toInt(p[6],0),ko:s(p[1]),cn:s(p[2]),en:s(p[2]),price:toInt(p[6],0),raw:s(raw),isCustom:true,kind:'item'};};
const customName=(o,id)=>o.id===s(id)?o:(o.name||o.ko||o.id);
function assertAst(ast){
 if(isArr(ast)&&ast.v.length===26)throw new Error('이 파일은 환경설정 데이터(configdata.dat)입니다. 슬롯 세이브 파일(bigbang1data.dat ~ bigbang24data.dat)을 열어 주세요.');
 const fail=()=>new Error('유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다. bigbang1data.dat ~ bigbang24data.dat 파일을 선택해 주세요.');
 if(!(isArr(ast)&&ast.v.length===54&&isArr(ast.v[3])&&ast.v[3].v.length>0&&isStrNode(ast.v[9])&&ast.v[9].v!==''&&(isNil(ast.v[7])||isStrNode(ast.v[7]))))throw fail();
 for(const c of ast.v[3].v){
  if(!(isArr(c)&&c.v.length===CHARA_LEN&&isStrNode(c.v[1])&&c.v[1].v!==''))throw fail();
  for(const k of [15,16,18,19,20,22]){ if(!(isNil(c.v[k])||(isArr(c.v[k])&&c.v[k].v.every(isStrNode))))throw fail(); }
 }
 for(const k of [6,19,20,21,40,41,42]){ if(!(isNil(ast.v[k])||isArr(ast.v[k])))throw fail(); }
 for(const k of [20,21,40,41,42]){ if(isArr(ast.v[k])&&!ast.v[k].v.every(isStrNode))throw fail(); }
 for(const k of [6,19]){ if(isArr(ast.v[k])){ for(const n of ast.v[k].v){ if(!(isArr(n)&&n.v.length>=2&&isStrNode(n.v[0])&&isIntNode(n.v[1])))throw fail(); } } }
}
function ensureArr(node){if(!node)throw new Error('배열 노드가 없습니다.');if(!isArr(node)){node.t='arr';node.v=[];node.raw=null;}return node.v;}
function getAtom(chara){return av(chara.v[18])||[];}
function atomRow(chara,id){const a=getAtom(chara);for(const n of a){if(sv(n).split(',')[0]===s(id))return n;}return null;}
function atomObj(chara,id){const n=atomRow(chara,id);return n?parseStatRaw(sv(n)):null;}
function heroName(ast){const ch=getHero({ast});const n=ch&&atomRow(ch,'12003');return n?parseStatRaw(sv(n)).stringValue:ch?sv(ch.v[25]):'';}
function setAtomRow(chara,row){
 const a=ensureArr(chara.v[18]);
 const raw=typeof row==='string'?row:statRaw(row);
 const id=splitCsv(raw)[0];
 const idx=a.findIndex(n=>sv(n).split(',')[0]===s(id));
 if(idx>=0)WokMsgPack.setStr(a[idx],raw);else a.push(WokMsgPack.makeStr(raw));
}
function ensureAtomRow(chara,id,defaults){
 if(atomRow(chara,id))return;
 setAtomRow(chara,Object.assign({id,stringValue:'',bornValue:0,alterValue:0,fightValue:0,rollValue:0,juqingValue:0,levelupValue:0,talentValue:0},defaults||{}));
}
function stRowFor(chara,id){
 const row=atomObj(chara,id);
 if(!row)return null;
 return row;
}
function persistentFromRow(row){return row?row.persistentTotal:0;}
function kungfuList(chara){return av(chara.v[15])||[];}
function battleList(chara){return av(chara.v[16])||[];}
function traitList(chara){return av(chara.v[19])||[];}
function equipList(chara){return av(chara.v[20])||[];}
function equipTraitList(chara){return av(chara.v[22])||[];}
function parseEquipTrait(raw){const p=s(raw).split('|');return{slot:toInt(p[0],0),traitId:s(p[1]),raw:s(raw)};}
function setEquipTraitRaw(chara,slot,traitId){const a=ensureArr(chara.v[22]);const raw=`${slot}|${traitId||''}`;const i=a.findIndex(n=>toInt(sv(n).split('|')[0],0)===slot);if(i>=0)WokMsgPack.setStr(a[i],raw);else a.push(WokMsgPack.makeStr(raw));}
function buildCatalogs(ast){
 const customEquips=(av(ast.v[40])||[]).map(n=>parseCustomEquip(sv(n))).filter(x=>x.id);
 const customKungfu=(av(ast.v[41])||[]).map(n=>parseCustomKungfu(sv(n))).filter(x=>x.id);
 const customItems=(av(ast.v[42])||[]).map(n=>parseCustomItem(sv(n))).filter(x=>x.id);
 const itemsBase=findMap(WokCatalog.items),kungfuBase=findMap(WokCatalog.kungfu),traitBase=findMap(WokCatalog.traits),charaBase=findMap(WokCatalog.characters);
 const itemCustomMap=new Map();customEquips.forEach(o=>itemCustomMap.set(s(o.id),o));customItems.forEach(o=>itemCustomMap.set(s(o.id),o));
 const kungfuCustomMap=new Map();customKungfu.forEach(o=>kungfuCustomMap.set(s(o.id),o));
 function resolveItem(id){const k=s(id);if(itemCustomMap.has(k))return itemCustomMap.get(k);if(itemsBase.has(k))return itemsBase.get(k);if(/^Mine\d+&/.test(k))return{id:k,ko:'발굴 보물 표식 ('+k+')',cn:k,en:k,style:'mine',star:0,price:0,equipSlot:-1,isCustom:true};return null;}
 function resolveKungfu(id){return kungfuCustomMap.get(s(id))||kungfuBase.get(s(id))||null;}
 function resolveTrait(id){return traitBase.get(s(id))||null;}
 function resolveChara(id){return charaBase.get(s(id))||null;}
 return{customEquips,customKungfu,customItems,resolveItem,resolveKungfu,resolveTrait,resolveChara};
}
function parseWhole(ast,fileName){
 const cat=buildCatalogs(ast);
 const self={ast,fileName:fileName||'',catalogs:cat};
 return new Session(self);
}
function Session(ctx){
 this.ast=ctx.ast;this.fileName=ctx.fileName;this.catalogs=ctx.catalogs;
}
Session.prototype.getDynamicCatalogs=function(){return this.catalogs;};
Session.prototype.getSummary=function(){
 const a=this.ast.v,origins=findMap(WokCatalog.origins);
 const hero=getHero(this),hname=nv(hero&&hero.v[25])?sv(hero.v[25]):'';
 return{
  fileName:this.fileName,key:sv(a[0]),playerId:sv(a[9]),heroName:heroName(this.ast)||hname,
  originId:sv(a[8]),originKo:(origins.get(sv(a[8]))||{}).ko||'',scene:sv(a[10]),
  money:iv(a[14]),epiphany:iv(a[15]),playRound:iv(a[16]),moveSpeed:fv(a[17]),
  shovelDurable:iv(a[33]),gameMode:iv(a[24]),version:sv(a[51]),
  charaCount:av(a[3])?av(a[3]).length:0,fullTeamCount:av(a[20])?av(a[20]).length:0,
  followCount:av(a[21])?av(a[21]).length:0,itemCount:av(a[19])?av(a[19]).length:0,
  customEquipCount:av(a[40])?av(a[40]).length:0,customKungfuCount:av(a[41])?av(a[41]).length:0
 };
};
Session.prototype.listCharacters=function(){
 const a=this.ast.v,pid=getPlayerId(this.ast),full=av(a[20])||[],follow=av(a[21])||[],out=[];
 (av(a[3])||[]).forEach((c,i)=>{
  const id=sv(c.v[1]),isHero=s(id)===s(pid)||i===0,ca=this.catalogs.resolveChara(id)||{};
  const hname=isHero?heroName(this.ast):'';
  out.push({index:i,id,name:hname||sv(c.v[25])||ca.ko||ca.cn||id,ko:ca.ko||'',cn:ca.cn||'',isHero,
   inFullTeam:indexOfId(full,id)>=0,inFollow:indexOfId(follow,id)>=0,level:iv(c.v[9]),exp:iv(c.v[10]),
   hp:fv(c.v[6]),mp:fv(c.v[7]),talent:iv(c.v[13]),relationship:iv(c.v[11]),trainingId:sv(c.v[8]),
   kungfuCount:av(c.v[15])?av(c.v[15]).length:0,traitCount:av(c.v[19])?av(c.v[19]).length:0,
   equipSlots:(av(c.v[20])||[]).map(sv)});
 });
 return out;
};
Session.prototype.getCharacterDetail=function(charaId){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const id=sv(c.v[1]),isHero=s(id)===s(getPlayerId(this.ast)),ca=this.catalogs.resolveChara(id)||{};
 const basic={id,name:isHero?heroName(this.ast):sv(c.v[25]),ko:ca.ko||'',cn:ca.cn||'',en:ca.en||'',isHero,
  level:iv(c.v[9]),exp:iv(c.v[10]),hp:fv(c.v[6]),mp:fv(c.v[7]),talent:iv(c.v[13]),
  relationship:iv(c.v[11]),ranking:iv(c.v[12]),trainingId:sv(c.v[8]),nickName:sv(c.v[25]),
  guild:sv(c.v[26]),currentTitleID:sv(c.v[24]),totalTalentCost:iv(c.v[28])};
 const all=(av(c.v[18])||[]).map(n=>{const r=parseStatRaw(sv(n)),sm=findMap(WokCatalog.stats).get(r.id)||{};return Object.assign({},r,{ko:sm.ko||'',cn:sm.cn||'',en:sm.en||'',cat:sm.cat||'기타',type:sm.type||'',maxVal:sm.maxVal,minVal:sm.minVal,isSave:sm.isSave});});
 const grouped={};all.forEach(r=>{(grouped[r.cat]=grouped[r.cat]||[]).push(r);});
 const kungfu=(av(c.v[15])||[]).map(n=>{
  const st=parseKfRaw(sv(n)),cat=this.catalogs.resolveKungfu(st.id)||{};
  return Object.assign({},st,{ko:cat.ko||st.id,cn:cat.cn||'',en:cat.en||'',star:cat.star||0,style:cat.style||'',maxLv:cat.maxLv||20,dmg:cat.dmg||0,mp:cat.mp||0,isCustom:!!cat.isCustom,raw:sv(n),inBattle:indexOfId(battleList(c),st.id)>=0});
 });
 const traits=(av(c.v[19])||[]).map(n=>{const tid=sv(n),cat=this.catalogs.resolveTrait(tid)||{};return{id:tid,ko:cat.ko||tid,cn:cat.cn||'',en:cat.en||'',good:cat.good,bonus:cat.bonus};});
 const equipTraits=(av(c.v[22])||[]).map(n=>{const et=parseEquipTrait(sv(n)),cat=this.catalogs.resolveTrait(et.traitId)||{};return Object.assign(et,{ko:cat.ko||'',cn:cat.cn||'',en:cat.en||''});});
 const equipSlots=(av(c.v[20])||[]).map((n,i)=>{const iid=sv(n),cat=this.catalogs.resolveItem(iid)||{};return{slot:i,id:iid,ko:cat.ko||'',cn:cat.cn||'',en:cat.en||'',style:cat.style||'',star:cat.star||0,price:cat.price||0,equipSlot:cat.equipSlot,isCustom:!!cat.isCustom};});
 return{basic,stats:{all,grouped},kungfu,traits,equipTraits,equipSlots};
};
Session.prototype.listInventory=function(){
 return(av(this.ast.v[19])||[]).map((n,i)=>{const p=av(n)||[],id=sv(p[0]),amt=iv(p[1]),cat=this.catalogs.resolveItem(id)||{};return{index:i,id,amount:amt,ko:cat.ko||id,cn:cat.cn||'',en:cat.en||'',style:cat.style||'',star:cat.star||0,price:cat.price||cat.value||0,equipSlot:cat.equipSlot,isCustom:!!cat.isCustom};});
};
Session.prototype.listFlags=function(filterStr){
 const q=s(filterStr).toLowerCase(),out=[];
 (av(this.ast.v[6])||[]).forEach(n=>{const p=av(n)||[],key=sv(p[0]),value=iv(p[1]);out.push({key,value,kind:'int'});});
 s(sv(this.ast.v[7])).split('|').filter(Boolean).forEach(part=>{const p=part.split('&'),key=p[0],value=p.length>1?p.slice(1).join('&'):'';out.push({key,value,kind:'str'});});
 return q?out.filter(x=>s(x.key).toLowerCase().includes(q)||s(x.value).toLowerCase().includes(q)):out;
};
Session.prototype.findChara=function(charaId){
 return(av(this.ast.v[3])||[]).find(c=>sv(c.v[1])===s(charaId))||null;
};
Session.prototype.updateWorld=function(patch){
 const a=this.ast.v;const p=patch||{};
 if('money' in p)WokMsgPack.setInt(a[14],toBigIntChecked(p.money,'돈'));
 if('epiphany' in p)WokMsgPack.setInt(a[15],toBigIntChecked(p.epiphany,'깨달음'));
 if('playRound' in p)WokMsgPack.setInt(a[16],toBigIntChecked(p.playRound,'플레이 라운드'));
 if('moveSpeed' in p)WokMsgPack.setFloat32(a[17],toFloat32Checked(p.moveSpeed,'이동속도'));
 if('shovelDurable' in p)WokMsgPack.setInt(a[33],toBigIntChecked(p.shovelDurable,'삽 내구도'));
 if('gameMode' in p)WokMsgPack.setInt(a[24],toBigIntChecked(p.gameMode,'게임 모드'));
 if('originId' in p)WokMsgPack.setStr(a[8],s(p.originId));
 if('scene' in p)WokMsgPack.setStr(a[10],s(p.scene));
 return this.getSummary();
};
Session.prototype.updateCharacterBasic=function(charaId,patch){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');const p=patch||{};
 if('heroName' in p){const v=s(p.heroName);if(v.includes(','))throw new Error('영웅 이름에는 쉼표(,)를 사용할 수 없습니다.');ensureAtomRow(c,'12003',{stringValue:v});const row=atomObj(c,'12003');row.stringValue=v;setAtomRow(c,row);}
 if('level' in p)WokMsgPack.setInt(c.v[9],toBigIntChecked(p.level,'레벨'));
 if('exp' in p)WokMsgPack.setInt(c.v[10],toBigIntChecked(p.exp,'경험치'));
 if('hp' in p)WokMsgPack.setFloat32(c.v[6],toFloat32Checked(p.hp,'HP'));
 if('mp' in p)WokMsgPack.setFloat32(c.v[7],toFloat32Checked(p.mp,'MP'));
 if('talent' in p)WokMsgPack.setInt(c.v[13],toBigIntChecked(p.talent,'재능'));
 if('relationship' in p)WokMsgPack.setInt(c.v[11],toBigIntChecked(p.relationship,'호감도'));
 if('nickName' in p)WokMsgPack.setStr(c.v[25],s(p.nickName));
 if('guild' in p)WokMsgPack.setStr(c.v[26],s(p.guild));
 if('trainingId' in p)WokMsgPack.setStr(c.v[8],s(p.trainingId)||'0');
 return this.getCharacterDetail(charaId).basic;
};
Session.prototype.updateCharacterStat=function(charaId,statId,field,value){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const allowed=['alterValue','rollValue','juqingValue','levelupValue','talentValue','stringValue'];
 if(allowed.indexOf(field)<0)throw new Error('지원하지 않는 스탯 필드입니다.');
 if(!atomObj(c,statId)&&!findMap(WokCatalog.stats).has(s(statId)))throw new Error('스탯 ID를 찾을 수 없습니다: '+s(statId));
 ensureAtomRow(c,statId);
 let row=atomObj(c,statId);
 if(!row)throw new Error('스탯을 찾을 수 없습니다.');
 if(field==='stringValue'){const v=s(value);if(v.includes(','))throw new Error('문자열 스탯에는 쉼표(,)를 사용할 수 없습니다.');row.stringValue=v;}
 else row[field]=toFloat(value);
 if(row.parts.length<8)row.parts=statRaw(row).split(',');
 setAtomRow(c,row);
 return parseStatRaw(sv(atomRow(c,statId)));
};
Session.prototype.upsertCharacterKungfu=function(charaId,kfId,opt){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const cat=this.catalogs.resolveKungfu(kfId);if(!cat)throw new Error('무공 ID를 찾을 수 없습니다: '+kfId);
 const id=s(kfId),o=opt||{},a=ensureArr(c.v[15]);
 const idx=a.findIndex(n=>parseKfRaw(sv(n)).id===id);
 const cur=idx>=0?parseKfRaw(sv(a[idx])):{id,lv:1,exp:0,proficiency:0,isAbolished:false};
 const lv='lv' in o?toInt(o.lv):cur.lv,exp='exp' in o?toInt(o.exp):cur.exp;
 const prof='proficiency' in o?toInt(o.proficiency):cur.proficiency;
 const ab='isAbolished' in o?!!o.isAbolished:cur.isAbolished;
 const raw=kfRaw(id,lv,exp,prof,ab);
 if(idx>=0)WokMsgPack.setStr(a[idx],raw);else a.push(WokMsgPack.makeStr(raw));
 if(o.inBattle===true){const bl=ensureArr(c.v[16]);if(indexOfId(bl,id)<0)bl.push(WokMsgPack.makeStr(id));}
 else if(o.inBattle===false){const bl=av(c.v[16]);if(bl){const bi=indexOfId(bl,id);if(bi>=0)bl.splice(bi,1);}}
 return parseKfRaw(raw);
};
Session.prototype.removeCharacterKungfu=function(charaId,kfId){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const id=s(kfId),a=kungfuList(c);
 for(let i=a.length-1;i>=0;i--)if(parseKfRaw(sv(a[i])).id===id)a.splice(i,1);
 const bl=battleList(c),bi=indexOfId(bl,id);if(bi>=0)bl.splice(bi,1);
 if(sv(c.v[8])===id)WokMsgPack.setStr(c.v[8],'0');
 return true;
};
Session.prototype.addCharacterTrait=function(charaId,traitId){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const id=s(traitId);if(!this.catalogs.resolveTrait(id))throw new Error('특성 ID를 찾을 수 없습니다: '+id);
 const a=ensureArr(c.v[19]);if(indexOfId(a,id)<0)a.push(WokMsgPack.makeStr(id));
 return true;
};
Session.prototype.removeCharacterTrait=function(charaId,traitId){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const id=s(traitId),a=traitList(c);
 for(let i=a.length-1;i>=0;i--)if(sv(a[i])===id)a.splice(i,1);
 const et=equipTraitList(c);
 et.forEach(n=>{const p=s(sv(n)).split('|');if(s(p[1])===id)WokMsgPack.setStr(n,`${p[0]}|`);});
 return true;
};
Session.prototype.setEquipTraitSlot=function(charaId,slot1to9,traitIdOrEmpty){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const slot=toInt(slot1to9);if(slot<1||slot>9)throw new Error('장비 특성 슬롯은 1~9입니다.');
 const id=s(traitIdOrEmpty);if(id&&!this.catalogs.resolveTrait(id))throw new Error('특성 ID를 찾을 수 없습니다: '+id);
 setEquipTraitRaw(c,slot,id);
 return id?`${slot}|${id}`:`${slot}|`;
};
Session.prototype.setCharacterEquipSlot=function(charaId,slot0to2,itemIdOrZero){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const slot=toInt(slot0to2);if(slot<0||slot>2)throw new Error('장비 슬롯은 0~2입니다.');
 let id=s(itemIdOrZero);if(!id||id==='0')id='0';else if(!this.catalogs.resolveItem(id))throw new Error('아이템 ID를 찾을 수 없습니다: '+id);
 const a=ensureArr(c.v[20]);while(a.length<3)a.push(WokMsgPack.makeStr('0'));WokMsgPack.setStr(a[slot],id);return id;
};
Session.prototype.upsertInventoryItem=function(itemId,amount){
 const id=s(itemId),amt=toBigIntChecked(amount,'아이템 수량');if(!this.catalogs.resolveItem(id))throw new Error('아이템 ID를 찾을 수 없습니다: '+id);
 if(amt<1n)throw new Error('아이템 수량은 1 이상이어야 합니다.');
 const a=ensureArr(this.ast.v[19]);let found=false;
 for(let i=a.length-1;i>=0;i--){const p=av(a[i])||[];if(sv(p[0])===id){if(!found){WokMsgPack.setInt(p[1],amt);found=true;}else{a.splice(i,1);}}}
 if(!found)a.push(WokMsgPack.makeArr([WokMsgPack.makeStr(id),WokMsgPack.makeInt(amt)]));
 return this.listInventory();
};
Session.prototype.removeInventoryItem=function(itemId){
 const id=s(itemId),a=av(this.ast.v[19])||[];
 for(let i=a.length-1;i>=0;i--){const p=av(a[i])||[];if(sv(p[0])===id){if(i===0&&id==='999')WokMsgPack.setInt(p[1],0);else a.splice(i,1);}}
 return this.listInventory();
};
Session.prototype.setPartyMembership=function(charaId,opt){
 const c=this.findChara(charaId);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
 const id=s(charaId),heroId=getPlayerId(this.ast),o=opt||{};
 if('inFullTeam' in o){if(o.inFullTeam){const full=ensureArr(this.ast.v[20]);if(indexOfId(full,id)<0)full.push(WokMsgPack.makeStr(id));}else{const full=av(this.ast.v[20]);if(full){const i=indexOfId(full,id);if(i>=0)full.splice(i,1);}}}
 if('inFollow' in o){
  if(o.inFollow&&s(id)!==s(heroId)){const follow=ensureArr(this.ast.v[21]);const i=indexOfId(follow,id);if(i<0){if(follow.length>=5)throw new Error('추종자는 최대 5명까지 가능합니다.');follow.push(WokMsgPack.makeStr(id));}}
  else{const follow=av(this.ast.v[21]);if(follow){const i=indexOfId(follow,id);if(i>=0)follow.splice(i,1);}}
  const curFollow=av(this.ast.v[21]);if(curFollow){for(let j=curFollow.length-1;j>=0;j--)if(sv(curFollow[j])===s(heroId))curFollow.splice(j,1);}
 }
 return true;
};
Session.prototype.setStrFlag=function(flagKey,intVal){
 const k=s(flagKey);if(!k)throw new Error('플래그 키가 비어 있습니다.');if(k.includes('|')||k.includes('&'))throw new Error('플래그 키에는 | 또는 &를 사용할 수 없습니다.');
 const ivVal=toBigIntChecked(intVal,'플래그 값');
 const parts=s(sv(this.ast.v[7])).split('|').filter(Boolean);let found=false;
 for(let i=0;i<parts.length;i++){const p=parts[i].split('&');if(p[0]===k){p.splice(1,p.length-1,String(ivVal));parts[i]=p.join('&');found=true;break;}}
 if(!found)parts.push(k+'&'+String(ivVal));
 WokMsgPack.setStr(this.ast.v[7],parts.join('|'));return true;
};
Session.prototype.setIntFlag=function(flagKey,intVal){
 const k=s(flagKey);if(!k)throw new Error('플래그 키가 비어 있습니다.');
 const ivVal=toBigIntChecked(intVal,'플래그 값');
 const a=ensureArr(this.ast.v[6]);let found=false;
 for(let i=a.length-1;i>=0;i--){const p=av(a[i])||[];if(sv(p[0])===k){if(!found){WokMsgPack.setInt(p[1],ivVal);found=true;}else a.splice(i,1);}}
 if(!found)a.push(WokMsgPack.makeArr([WokMsgPack.makeStr(k),WokMsgPack.makeInt(ivVal)]));
 return true;
};
Session.prototype.setFlag=function(flagKey,intVal,kind){return s(kind)==='int'?this.setIntFlag(flagKey,intVal):this.setStrFlag(flagKey,intVal);};
Session.prototype.applyPreset=function(presetId,targetCharaId){
 const id=s(presetId),a=this.ast.v;
 if(id==='rich_epiphany'){
  WokMsgPack.setInt(a[14],maxBig(bi(a[14]),9999999n));WokMsgPack.setInt(a[15],maxBig(bi(a[15]),999n));
  WokMsgPack.setInt(a[33],maxBig(bi(a[33]),9999n));
 }else if(id==='hero_max_growth'){
  const c=getHero(this);WokMsgPack.setInt(c.v[9],maxBig(bi(c.v[9]),60n));const nextTalent=maxBig(bi(c.v[13])+100n,200n);WokMsgPack.setInt(c.v[13],nextTalent>MAX_U64?MAX_U64:nextTalent);
  ['1003','1005'].forEach(sid=>{ensureAtomRow(c,sid);const r=atomObj(c,sid);r.alterValue=Math.max(r.alterValue,5000);setAtomRow(c,r);});
  WokMsgPack.setFloat32(c.v[6],Math.max(fv(c.v[6]),persistentFromRow(atomObj(c,'1003'))));
  WokMsgPack.setFloat32(c.v[7],Math.max(fv(c.v[7]),persistentFromRow(atomObj(c,'1005'))));
 }else if(id==='hero_six_attributes'){
  const c=getHero(this);for(let i=2001;i<=2006;i++){const sid=String(i);ensureAtomRow(c,sid);const r=atomObj(c,sid);if(r.persistentTotal<40)r.alterValue+=40-r.persistentTotal;setAtomRow(c,r);}
 }else if(id==='hero_all_mastery'){
  const c=getHero(this);for(let i=3001;i<=3014;i++){const sid=String(i);ensureAtomRow(c,sid);const r=atomObj(c,sid);if(r.persistentTotal<220)r.alterValue+=220-r.persistentTotal;setAtomRow(c,r);}
 }else if(id==='master_all_kungfu'){
  const c=targetCharaId?this.findChara(targetCharaId):getHero(this);if(!c)throw new Error('캐릭터를 찾을 수 없습니다.');
  const list=kungfuList(c);list.forEach(n=>{const st=parseKfRaw(sv(n)),cat=this.catalogs.resolveKungfu(st.id)||{},max=toInt(cat.maxLv)||20;if(!st.isAbolished){st.lv=Math.max(st.lv,max);st.proficiency=Math.max(st.proficiency,9999);WokMsgPack.setStr(n,kfRaw(st.id,st.lv,st.exp,st.proficiency,st.isAbolished));}});
 }else if(id==='party_recover_boost'){
  const hero=getHero(this),ids=new Set([sv(hero.v[1])]);(av(a[21])||[]).forEach(n=>ids.add(sv(n)));
  ids.forEach(cid=>{const c=this.findChara(cid);if(!c)return;const isHero=s(cid)===s(sv(hero.v[1]));
   WokMsgPack.setInt(c.v[13],maxBig(bi(c.v[13]),100n));if(!isHero)WokMsgPack.setInt(c.v[11],maxBig(bi(c.v[11]),100n));
   kungfuList(c).forEach(n=>{const st=parseKfRaw(sv(n));if(!st.isAbolished){st.proficiency=Math.max(st.proficiency,9999);WokMsgPack.setStr(n,kfRaw(st.id,st.lv,st.exp,st.proficiency,st.isAbolished));}});
   WokMsgPack.setFloat32(c.v[6],Math.max(fv(c.v[6]),persistentFromRow(atomObj(c,'1003'))));
   WokMsgPack.setFloat32(c.v[7],Math.max(fv(c.v[7]),persistentFromRow(atomObj(c,'1005'))));
   WokMsgPack.setFloat32(a[17],Math.max(fv(a[17]),2.25));
  });
 }else throw new Error('알 수 없는 프리셋입니다: '+presetId);
 return true;
};
Session.prototype.validate=function(){
 const errors=[],warnings=[];
 if(!isArr(this.ast)||this.ast.v.length!==54){errors.push('GameData 루트 배열 길이가 54가 아닙니다.');return{valid:false,errors,warnings};}
 const a=this.ast.v;
 const walkIntNodes=(n,depth)=>{const d=depth||0;if(d>64){errors.push('MessagePack 중첩 깊이가 상한(64)을 초과했습니다.');return;}if(!n||typeof n!=='object')return;if(n.t==='arr'||n.t==='arr16'||n.t==='arr32'){if(Array.isArray(n.v))n.v.forEach(x=>walkIntNodes(x,d+1));}else if(n.t==='map'||n.t==='map16'||n.t==='map32'){if(Array.isArray(n.v))n.v.forEach(pair=>{if(Array.isArray(pair))pair.forEach(x=>walkIntNodes(x,d+1));});}if(INT_TAGS.has(n.t)&&!isIntNode(n))errors.push('64비트 MessagePack 정수 범위를 벗어난 노드가 있습니다.');};
 walkIntNodes(this.ast);
 if(!isStrNode(a[9])||a[9].v==='')errors.push('플레이어 ID 필드가 유효한 문자열이 아닙니다.');
 if(!(isNil(a[7])||isStrNode(a[7])))errors.push('문자열 플래그 필드가 nil 또는 문자열이 아닙니다.');
 else if(isStrNode(a[7])&&a[7].v!==''){a[7].v.split('|').forEach((seg,i)=>{if(!seg)return;const kv=seg.split('&');if(kv.length!==2||!kv[0]||!isAsciiSignedDigits(kv[1])){errors.push(`문자열 플래그 ${i} 구조가 올바르지 않습니다.`);return;}const bv=BigInt(kv[1]);if(bv<MIN_I64||bv>MAX_U64)errors.push(`문자열 플래그 ${i} 값이 64비트 정수 범위를 벗어났습니다.`);});}
 for(const k of [6,19,20,21,40,41,42]){if(!(isNil(a[k])||isArr(a[k])))errors.push(`GameData 필드 [${k}]가 nil 또는 배열이 아닙니다.`);}
 for(const k of [20,21,40,41,42]){if(isArr(a[k])&&!a[k].v.every(isStrNode))errors.push(`GameData 필드 [${k}] 원소가 문자열이 아닙니다.`);}
 if(isArr(a[6])){a[6].v.forEach((n,i)=>{if(!(isArr(n)&&n.v.length>=2&&isStrNode(n.v[0])&&n.v[0].v!==''&&isIntNode(n.v[1])))errors.push(`정수 플래그 ${i} 구조가 올바르지 않습니다.`);});}
 if(!isIntNode(a[14]))errors.push('돈 필드가 정수가 아닙니다.');else if(bi(a[14])<0n)errors.push('돈이 음수입니다.');
 if(!isIntNode(a[15]))errors.push('깨달음 필드가 정수가 아닙니다.');else if(bi(a[15])<0n)errors.push('깨달음이 음수입니다.');
 if(!isFiniteF32Node(a[17]))errors.push('이동속도가 유한한 float32 숫자가 아닙니다.');
 for(const k of [16,24,33]){if(!isIntNode(a[k]))errors.push(`GameData 필드 [${k}]가 정수가 아닙니다.`);}
 for(const k of [8,10,51]){if(!(isNil(a[k])||isStrNode(a[k])))errors.push(`GameData 필드 [${k}]가 nil 또는 문자열이 아닙니다.`);}
 if(isArr(a[21])&&a[21].v.length>5)errors.push('FollowList가 5명을 초과합니다.');
 if(isArr(a[21])&&isStrNode(a[9])&&a[9].v!==''&&a[21].v.some(x=>sv(x)===a[9].v))errors.push('FollowList에 주인공(playerid)이 포함되어 있습니다.');
 if(isArr(a[19])){a[19].v.forEach((n,i)=>{if(!(isArr(n)&&n.v.length>=2)){errors.push(`아이템 ${i} 구조가 올바르지 않습니다.`);return;}const p=n.v,iid=isStrNode(p[0])?p[0].v:'';if(!isStrNode(p[0])||p[0].v==='')errors.push(`아이템 ${i} ID가 비어 있습니다.`);if(!isIntNode(p[1]))errors.push(`아이템 ${i} 수량이 정수가 아닙니다.`);else if(bi(p[1])<0n)errors.push(`아이템 ${i} 수량이 음수입니다.`);if(iid&&!this.catalogs.resolveItem(iid)&&iid!=='999')warnings.push(`아이템 ${i} ID가 카탈로그에 없습니다: ${iid}`);});}
 if(!isArr(a[3])||a[3].v.length===0)errors.push('simpleCharaDatas 필드가 배열이 아닙니다.');
 else a[3].v.forEach((c,i)=>{
  if(!isArr(c)||c.v.length!==29){errors.push(`캐릭터 ${i}의 필드 길이가 29가 아닙니다.`);return;}
  if(!isStrNode(c.v[1])||c.v[1].v==='')errors.push(`캐릭터 ${i} ID가 유효한 문자열이 아닙니다.`);
  if(isArr(c.v[15]))c.v[15].v.forEach((n,j)=>{if(isStrNode(n)&&splitCsv(n.v).length!==5)errors.push(`캐릭터 ${i} 무공 ${j} CSV 필드 수가 5가 아닙니다.`);});
  if(isArr(c.v[22]))c.v[22].v.forEach((n,j)=>{if(isStrNode(n)){const p=n.v.split('|');if(p.length<2||!(p[0].length===1&&p[0]>='1'&&p[0]<='9'))errors.push(`캐릭터 ${i} 장착 특성 ${j} 슬롯 범위(1~9)가 올바르지 않습니다.`);}});
  for(const k of [15,16,18,19,20,22]){if(!(isNil(c.v[k])||(isArr(c.v[k])&&c.v[k].v.every(isStrNode))))errors.push(`캐릭터 ${i} 필드 [${k}]가 nil 또는 문자열 배열이 아닙니다.`);}
  if(!isFiniteF32Node(c.v[6]))errors.push(`캐릭터 ${i}의 HP가 유한한 float32 숫자가 아닙니다.`);if(!isFiniteF32Node(c.v[7]))errors.push(`캐릭터 ${i}의 MP가 유한한 float32 숫자가 아닙니다.`);
  for(const k of [9,10,11,13,28]){if(!isIntNode(c.v[k]))errors.push(`캐릭터 ${i} 필드 [${k}]가 정수가 아닙니다.`);}
  for(const k of [8,24,25,26]){if(!(isNil(c.v[k])||isStrNode(c.v[k])))errors.push(`캐릭터 ${i} 필드 [${k}]가 nil 또는 문자열이 아닙니다.`);}
  if(isArr(c.v[18]))c.v[18].v.forEach((n,j)=>{const raw=sv(n),p=splitCsv(raw);if(p.length>9)errors.push(`캐릭터 ${i} 스탯 ${j}에 쉼표로 인한 초과 필드가 있습니다.`);else if(p.length<9)warnings.push(`캐릭터 ${i} 스탯 ${j}의 필드 수가 9 미만입니다.`);});
  if(isArr(c.v[20])&&c.v[20].v.length!==3)errors.push(`캐릭터 ${i}의 장비 슬롯이 3개가 아닙니다.`);
  (isArr(c.v[20])?c.v[20].v:[]).forEach((n,j)=>{if(!isStrNode(n)||n.v==='')errors.push(`캐릭터 ${i} 장비 슬롯 ${j}가 비어 있습니다.`);else if(sv(n)!=='0'&&!this.catalogs.resolveItem(sv(n))&&/^[A-Za-z0-9_.-]+$/.test(sv(n)))warnings.push(`캐릭터 ${i} 장비 슬롯 ${j} 아이템 ID가 카탈로그에 없습니다: ${sv(n)}`);});
  kungfuList(c).forEach((n,j)=>{const st=parseKfRaw(sv(n));if(!this.catalogs.resolveKungfu(st.id)&&/^[A-Za-z0-9_.-]+$/.test(s(st.id)))warnings.push(`캐릭터 ${i} 무공 ${j} ID가 카탈로그에 없습니다: ${st.id}`);});
  (isArr(c.v[19])?c.v[19].v:[]).forEach((n,j)=>{if(!this.catalogs.resolveTrait(sv(n))&&/^[A-Za-z0-9_.-]+$/.test(sv(n)))warnings.push(`캐릭터 ${i} 특성 ${j} ID가 카탈로그에 없습니다: ${sv(n)}`);});
 });
 return{valid:errors.length===0,errors,warnings};
};
Session.prototype.toPlainJson=function(){return WokMsgPack.astToPlain(this.ast);};
Session.prototype.encodeSync=function(){const v=this.validate();if(!v.valid)throw new Error('세이브 검증 실패: '+v.errors.join(' / '));return WokMsgPack.encodeDatSync(this.ast);};
Session.prototype.encodeAsync=function(){const v=this.validate();if(!v.valid)return Promise.reject(new Error('세이브 검증 실패: '+v.errors.join(' / ')));return Promise.resolve(WokMsgPack.encodeDat(this.ast));};
function makeChara(id,level,kungfuIds,traitIds,statRows,heroNameValue){
 const c=[
  WokMsgPack.makeStr('b01'),WokMsgPack.makeStr(s(id)),WokMsgPack.makeStr(''),WokMsgPack.makeStr(''),
  WokMsgPack.makeStr(''),WokMsgPack.makeStr(''),WokMsgPack.makeFloat32(100),WokMsgPack.makeFloat32(100),
  WokMsgPack.makeStr('0'),WokMsgPack.makeInt(level),WokMsgPack.makeInt(0),WokMsgPack.makeInt(0),
  WokMsgPack.makeInt(0),WokMsgPack.makeInt(0),WokMsgPack.makeArr([]),WokMsgPack.makeArr((kungfuIds||[]).map(x=>WokMsgPack.makeStr(kfRaw(x,1,0,0,false)))),
  WokMsgPack.makeArr((kungfuIds||[]).map(x=>WokMsgPack.makeStr(x))),WokMsgPack.makeArr([]),WokMsgPack.makeArr((statRows||[]).map(x=>WokMsgPack.makeStr(x))),
  WokMsgPack.makeArr((traitIds||[]).map(x=>WokMsgPack.makeStr(x))),WokMsgPack.makeArr([WokMsgPack.makeStr('0'),WokMsgPack.makeStr('0'),WokMsgPack.makeStr('0')]),
  WokMsgPack.makeArr([]),WokMsgPack.makeArr(emptyEquipTraits().map(x=>WokMsgPack.makeStr(x))),WokMsgPack.makeArr([]),
  WokMsgPack.makeStr(''),WokMsgPack.makeStr(heroNameValue||''),WokMsgPack.makeStr(''),WokMsgPack.makeNil(),WokMsgPack.makeInt(0)
 ];
 return WokMsgPack.makeArr(c);
}
function demoStats(heroNameValue){
 const stats=findMap(WokCatalog.stats),rows=[];
 const ordered=WokCatalog.stats.filter(x=>x&&x.id!==undefined&&x.isSave!==false);
 ordered.forEach(st=>{
  const id=s(st.id),isString=id==='12003'||s(st.type).toLowerCase().includes('string');
  rows.push(statRaw({id,stringValue:id==='12003'?heroNameValue:'',bornValue:toInt(st.defVal,0),alterValue:0,fightValue:0,rollValue:0,juqingValue:0,levelupValue:0,talentValue:0}));
 });
 ['1003','1005','12003'].forEach(id=>{if(!stats.has(id)&&!rows.some(r=>r.split(',')[0]===id))rows.push(statRaw({id,stringValue:id==='12003'?heroNameValue:'',bornValue:0,alterValue:0,fightValue:0,rollValue:0,juqingValue:0,levelupValue:0,talentValue:0}));});
 for(let i=2001;i<=2006;i++){const id=String(i);if(!rows.some(r=>r.split(',')[0]===id))rows.push(statRaw({id,stringValue:'',bornValue:0,alterValue:0,fightValue:0,rollValue:0,juqingValue:0,levelupValue:0,talentValue:0}));}
 for(let i=3001;i<=3014;i++){const id=String(i);if(!rows.some(r=>r.split(',')[0]===id))rows.push(statRaw({id,stringValue:'',bornValue:0,alterValue:0,fightValue:0,rollValue:0,juqingValue:0,levelupValue:0,talentValue:0}));}
 return rows;
}
function pickCatalogId(list,preferred){const ids=(list||[]).map(x=>s(x.id));if(preferred&&ids.indexOf(s(preferred))>=0)return s(preferred);return ids[0]||'0';}
function readFirstIds(list,n,avoid){const ids=[];(list||[]).forEach(x=>{const id=s(x.id);if(id&&id!==avoid&&ids.indexOf(id)<0&&ids.length<n)ids.push(id);});return ids;}
function buildDemo(){
 const heroNameValue='청풍협',heroId='9001';
 const kfIds=readFirstIds(WokCatalog.kungfu,3,'');
 const traitIds=readFirstIds(WokCatalog.traits,3,'');
 const items=readFirstIds(WokCatalog.items,2,'999');
 const stats=demoStats(heroNameValue);
 const hero=makeChara(heroId,60,kfIds,traitIds,stats,heroNameValue);
 const c1=makeChara('105',30,[], [],demoStats(''),'');
 const c2=makeChara('312',25,[], [],demoStats(''),'');
 const root=Array.from({length:54},()=>WokMsgPack.makeNil());
 root[0]=WokMsgPack.makeStr('22ee6bbb0e58d81f532c5e993fe57aff61795c8a');
 root[1]=WokMsgPack.makeInt(0);
 root[2]=WokMsgPack.makeStr('2024-09-07 12:00:00');
 root[3]=WokMsgPack.makeArr([hero,c1,c2]);
 root[6]=WokMsgPack.makeArr([WokMsgPack.makeArr([WokMsgPack.makeStr('tutorial_done'),WokMsgPack.makeInt(1)])]);
 root[7]=WokMsgPack.makeStr('STAGE_01_0&2');
 root[8]=WokMsgPack.makeStr('1001');
 root[9]=WokMsgPack.makeStr(heroId);
 root[10]=WokMsgPack.makeStr('STAGE_01_0');
 root[13]=WokMsgPack.makeBool(true);
 root[14]=WokMsgPack.makeInt(100000);
 root[15]=WokMsgPack.makeInt(100);
 root[16]=WokMsgPack.makeInt(1);
 root[17]=WokMsgPack.makeFloat32(1);
 root[19]=WokMsgPack.makeArr([WokMsgPack.makeArr([WokMsgPack.makeStr('999'),WokMsgPack.makeInt(0)]),WokMsgPack.makeArr([WokMsgPack.makeStr(items[0]||pickCatalogId(WokCatalog.items)),WokMsgPack.makeInt(5)])]);
 root[20]=WokMsgPack.makeArr([WokMsgPack.makeStr(heroId),WokMsgPack.makeStr('105'),WokMsgPack.makeStr('312')]);
 root[21]=WokMsgPack.makeArr([WokMsgPack.makeStr('105'),WokMsgPack.makeStr('312')]);
 root[24]=WokMsgPack.makeInt(0);
 root[25]=WokMsgPack.makeInt(0);
 root[33]=WokMsgPack.makeInt(100);
 root[40]=WokMsgPack.makeArr([]);
 root[41]=WokMsgPack.makeArr([]);
 root[42]=WokMsgPack.makeArr([]);
 root[45]=WokMsgPack.makeBool(true);
 root[46]=WokMsgPack.makeNil();
 root[51]=WokMsgPack.makeStr(VERSION);
 return WokMsgPack.makeArr(root);
}
function createDemoDatSync(){return WokMsgPack.encodeDatSync(buildDemo());}
function createDemoDatAsync(){return Promise.resolve(WokMsgPack.encodeDat(buildDemo()));}
function loadSessionSync(datText,fileName){const d=WokMsgPack.decodeDatSync(datText),ast=d&&d.ast?d.ast:d;assertAst(ast);return parseWhole(ast,fileName);}
function loadSessionAsync(datText,fileName){return Promise.resolve(WokMsgPack.decodeDat(datText)).then(d=>{const ast=d&&d.ast?d.ast:d;assertAst(ast);return parseWhole(ast,fileName);});}
return{PRESETS,createDemoDatSync,createDemoDatAsync,loadSessionSync,loadSessionAsync,Session};
});
