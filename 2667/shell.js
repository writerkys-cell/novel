/* ============================================================
   껍데기(Shell) — 세 앱이 함께 쓰는 살림살이

   이 파일이 맡는 일은 다섯입니다.
   1) 오프라인   — 서비스 워커를 등록해 인터넷 없이도 앱이 열리게 한다
   2) 갱신 알림  — 새 판이 올라오면 알리고, 눌렀을 때 갈아 끼운다
   3) 창 잠금    — 같은 앱이 두 창에 열리면 나중 창은 읽기만 하게 한다
   4) 영구 저장  — 브라우저에 "이 데이터는 지우지 말아 달라"고 등록한다
   5) 파일 연결  — 아이클라우드 폴더의 파일 하나에 저장할 때마다 함께 쓴다

   앱은 Shell.init({...})로 자기를 소개하고, 저장할 때마다 Shell.touch()를
   부르기만 하면 됩니다.
   ============================================================ */
(function(){
'use strict';
const S={};
let cfg=null, reg=null, fileHandle=null;
let readOnly=false, persisted=false, dirty=false, lastWrite=0;
let writeTimer=null, installEvent=null, reloading=false;
let updateReady=false, filePerm='none', barsEl=null;

/* ---------- 작은 열쇠-값 창고 (파일 손잡이를 넣어 둔다) ---------- */
function kvDB(){
  return new Promise((res,rej)=>{
    const q=indexedDB.open('shell-'+cfg.name,1);
    q.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    q.onsuccess=e=>res(e.target.result);
    q.onerror=e=>rej(e.target.error);
  });
}
async function kvGet(k){
  const d=await kvDB();
  return new Promise((res,rej)=>{
    const r=d.transaction('kv').objectStore('kv').get(k);
    r.onsuccess=()=>res(r.result); r.onerror=e=>rej(e.target.error);
  });
}
async function kvSet(k,v){
  const d=await kvDB();
  return new Promise((res,rej)=>{
    const t=d.transaction('kv','readwrite');
    t.objectStore('kv').put(v,k);
    t.oncomplete=()=>res(); t.onerror=e=>rej(e.target.error);
  });
}

/* ---------- 1·2) 오프라인과 갱신 ---------- */
function initSW(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(r=>{
    reg=r;
    if(r.waiting) notifyUpdate();
    r.addEventListener('updatefound',()=>{
      const nw=r.installing; if(!nw) return;
      nw.addEventListener('statechange',()=>{
        /* 이미 쓰고 있던 판이 있을 때만 '새 판'이다 — 첫 설치는 알리지 않는다 */
        if(nw.state==='installed'&&navigator.serviceWorker.controller) notifyUpdate();
      });
    });
    const look=()=>{ if(!document.hidden) r.update().catch(()=>{}) };
    document.addEventListener('visibilitychange',look);
    setInterval(look, 60*60*1000);
  }).catch(()=>{});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading) return; reloading=true; location.reload();
  });
}
function notifyUpdate(){ updateReady=true; S.refresh(); if(cfg&&cfg.onUpdate) cfg.onUpdate(); }
S.applyUpdate=()=>{
  if(reg&&reg.waiting){ reg.waiting.postMessage({type:'SKIP_WAITING'}); }
  else location.reload();
};

/* ---------- 3) 창 잠금 ----------
   먼저 열린 창이 자물쇠를 쥐고 놓지 않는다.
   나중 창은 자물쇠를 못 잡으니 스스로 읽기 전용이 된다. */
function claimLock(){
  if(!navigator.locks||!navigator.locks.request) return Promise.resolve(true);
  return new Promise(resolve=>{
    let settled=false;
    navigator.locks.request(cfg.name+'-writer',{mode:'exclusive',ifAvailable:true},lock=>{
      if(!lock){ settled=true; resolve(false); return; }
      settled=true; resolve(true);
      return new Promise(()=>{});      /* 창이 살아 있는 동안 계속 쥔다 */
    }).catch(()=>{ if(!settled) resolve(true); });
    setTimeout(()=>{ if(!settled){settled=true;resolve(true)} },1500);
  });
}
S.isReadOnly=()=>readOnly;
S.retryLock=async()=>{
  if(!readOnly) return true;
  const ok=await claimLock();
  if(ok){ readOnly=false; if(cfg.onReadOnly) cfg.onReadOnly(false); S.refresh(); }
  return ok;
};

/* ---------- 4) 영구 저장 ---------- */
async function initPersist(){
  try{
    if(navigator.storage&&navigator.storage.persist){
      persisted=await navigator.storage.persisted();
      if(!persisted) persisted=await navigator.storage.persist();
    }
  }catch(e){}
}
S.askPersist=async()=>{
  try{ persisted=await navigator.storage.persist(); }catch(e){}
  S.refresh(); return persisted;
};

/* ---------- 5) 파일 연결 ---------- */
S.canFile=()=>typeof window.showSaveFilePicker==='function';
S.linkFile=async()=>{
  const h=await window.showSaveFilePicker({
    suggestedName:cfg.fileName,
    types:[{description:'밑작업 자료',accept:{'application/json':['.json']}}]
  });
  fileHandle=h; await kvSet('fileHandle',h);
  await writeNow(true); S.refresh();
  return h.name;
};
S.unlinkFile=async()=>{ fileHandle=null; await kvSet('fileHandle',null); S.refresh(); };
S.fileName=()=>fileHandle?fileHandle.name:'';
async function perm(interactive){
  if(!fileHandle){ filePerm='none'; return false; }
  const o={mode:'readwrite'};
  try{
    filePerm=await fileHandle.queryPermission(o);
    if(filePerm==='granted') return true;
    if(!interactive) return false;
    filePerm=await fileHandle.requestPermission(o);
    return filePerm==='granted';
  }catch(e){ filePerm='prompt'; return false; }
}
S.grantFile=async()=>{ const ok=await perm(true); if(ok) await writeNow(true); S.refresh(); return ok; };
async function writeNow(force){
  if(!fileHandle||readOnly) return false;
  if(!await perm(false)) return false;
  try{
    const data=await cfg.exportAll();
    const w=await fileHandle.createWritable();
    await w.write(JSON.stringify(data,null,2));
    await w.close();
    lastWrite=Date.now(); dirty=false;
    await kvSet('lastWrite',lastWrite);
    S.refresh();
    return true;
  }catch(e){ return false; }
}
/* 앱이 저장할 때마다 부른다. 곧바로 쓰지 않고 잠시 모았다가 쓴다. */
S.touch=()=>{
  if(!fileHandle||readOnly) return;
  dirty=true;
  clearTimeout(writeTimer);
  writeTimer=setTimeout(()=>writeNow(),6000);
};
S.flush=()=>writeNow(true);
S.restoreFromFile=async()=>{
  if(!fileHandle) return null;
  if(!await perm(true)) return null;
  const f=await fileHandle.getFile();
  return JSON.parse(await f.text());
};

/* ---------- 설치 ---------- */
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault(); installEvent=e; S.refresh();
});
window.addEventListener('appinstalled',()=>{ installEvent=null; S.refresh(); });
S.canInstall=()=>!!installEvent;
S.install=async()=>{
  if(!installEvent) return false;
  installEvent.prompt();
  const r=await installEvent.userChoice;
  installEvent=null; S.refresh();
  return r.outcome==='accepted';
};

/* ---------- 알림 띠 ----------
   읽기 전용, 새 판, 파일 권한 — 세 가지만 화면 맨 위에 알린다. */
S.mountBars=el=>{ barsEl=el; renderBars(); };
function renderBars(){
  if(!barsEl) return;
  const out=[];
  if(readOnly) out.push(
    '<div class="bar readonly"><span class="grow">이 앱이 <b>다른 창에서 열려 있습니다.</b> '+
    '여기서 고치면 서로 덮어쓰게 되므로 읽기만 됩니다.</span>'+
    '<button data-shell="retry">그 창을 닫았습니다</button></div>');
  if(updateReady) out.push(
    '<div class="bar update"><span class="grow"><b>새 판이 올라왔습니다.</b></span>'+
    '<button data-shell="update">새 판으로 열기</button></div>');
  if(fileHandle&&filePerm!=='granted') out.push(
    '<div class="bar warn"><span class="grow">연결해 둔 파일 <b>'+esc(fileHandle.name)+'</b>에 '+
    '아직 쓸 수 없습니다.</span><button data-shell="grant">허용하기</button></div>');
  barsEl.innerHTML=out.join('');
  /* 띠가 차지한 높이를 알려 준다 — 머리글이 그 아래로 내려앉게 */
  requestAnimationFrame(()=>{
    document.documentElement.style.setProperty('--barsH', barsEl.offsetHeight+'px');
  });
  barsEl.querySelectorAll('[data-shell]').forEach(b=>{
    const k=b.dataset.shell;
    b.onclick=async()=>{
      if(k==='retry'){ const ok=await S.retryLock(); if(!ok) b.textContent='아직 열려 있습니다'; }
      if(k==='update') S.applyUpdate();
      if(k==='grant') await S.grantFile();
    };
  });
}
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- 상태 ---------- */
S.refresh=()=>{ renderBars(); if(cfg&&cfg.onStatus) cfg.onStatus(); };
S.status=async()=>{
  let usage=0,quota=0;
  try{
    if(navigator.storage&&navigator.storage.estimate){
      const e=await navigator.storage.estimate();
      usage=e.usage||0; quota=e.quota||0;
    }
  }catch(e){}
  let p='none';
  if(fileHandle){ try{ p=await fileHandle.queryPermission({mode:'readwrite'}); }catch(e){ p='prompt'; } filePerm=p; }
  return {
    version:cfg?cfg.version:'', readOnly, persisted, usage, quota,
    file:fileHandle?fileHandle.name:'', filePerm:p, lastWrite,
    canFile:S.canFile(), canInstall:!!installEvent,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    offline: !!(navigator.serviceWorker&&navigator.serviceWorker.controller),
    online: navigator.onLine
  };
};
S.fmtBytes=n=>{
  if(!n) return '0';
  const u=['B','KB','MB','GB','TB']; let i=0;
  while(n>=1024&&i<u.length-1){n/=1024;i++}
  return (n<10&&i>0?n.toFixed(1):Math.round(n))+u[i];
};

/* ---------- 시작 ---------- */
S.init=async c=>{
  cfg=c;
  initSW();
  readOnly=!(await claimLock());
  if(readOnly&&cfg.onReadOnly) cfg.onReadOnly(true);
  if(!readOnly) initPersist();
  try{
    fileHandle=(await kvGet('fileHandle'))||null;
    lastWrite=(await kvGet('lastWrite'))||0;
    if(fileHandle) await perm(false);
  }catch(e){}
  if(cfg.barsEl) S.mountBars(cfg.barsEl);
  /* 창을 덮거나 떠날 때 아직 못 쓴 것을 마저 쓴다 */
  const bail=()=>{ if(dirty) writeNow(true); };
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) bail(); });
  window.addEventListener('pagehide',bail);
  window.addEventListener('online',S.refresh);
  window.addEventListener('offline',S.refresh);
  S.refresh();
  return {readOnly};
};

window.Shell=S;
})();
