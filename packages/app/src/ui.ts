// Start screen for the local app. Single self-contained page: drop a .dsd,
// watch it run, open the results. No build step, no framework, no CDN.

export const START_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>감사보고서 검토</title>
<style>
:root{--ink900:#191919;--ink800:#3D3D3D;--ink700:#777;--ink300:#E0E0E0;--ink200:#EFEFEF;--ink100:#F7F7F7;
--blue:#1D4ED8;--bluebg:#EAF1FE;--green:#137A45;--greenbg:#E9F6EE;--red:#E5342F;--redbg:#FDECEB}
*{box-sizing:border-box}
body{margin:0;font-family:Pretendard,-apple-system,"Helvetica Neue",sans-serif;letter-spacing:-.01em;
color:var(--ink900);background:#fff;font-size:15px;line-height:1.6}
.wrap{max-width:820px;margin:0 auto;padding:56px 24px 64px}
h1{font-size:34px;font-weight:900;letter-spacing:-.03em;margin:0 0 6px}
h1 .ic{font-size:30px;margin-right:8px}
.sub{color:var(--ink800);font-size:16px;margin:0 0 4px}
.meta{color:var(--ink700);font-size:13px;margin:0 0 32px}
.drop{border:2px dashed var(--ink300);border-radius:10px;padding:44px 24px;text-align:center;
background:var(--ink100);transition:.15s;cursor:pointer}
.drop.over{border-color:var(--blue);background:var(--bluebg)}
.drop .big{font-size:17px;font-weight:800;margin-bottom:6px}
.drop .small{color:var(--ink700);font-size:13px}
.btn{display:inline-block;margin-top:14px;background:var(--ink900);color:#fff;border:0;border-radius:6px;
padding:11px 22px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}
.btn:disabled{background:var(--ink300);cursor:default}
.file{margin-top:16px;font-size:14px;color:var(--ink800)}
.file b{font-weight:800}
#log{margin-top:22px;display:none}
.step{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14px;color:var(--ink700)}
.step.done{color:var(--green);font-weight:700}
.step.run{color:var(--blue);font-weight:700}
.step .dot{width:9px;height:9px;border-radius:50%;background:var(--ink300);flex:none}
.step.done .dot{background:var(--green)} .step.run .dot{background:var(--blue)}
#result{margin-top:26px;display:none}
.card{border:1px solid var(--ink300);border-radius:8px;padding:18px 20px;background:#fff}
.sum{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 18px}
.sum div{background:var(--ink100);border-radius:6px;padding:12px 14px}
.sum .l{font-size:12px;color:var(--ink700);font-weight:700}
.sum .v{font-size:24px;font-weight:800;letter-spacing:-.02em}
.sum .v.red{color:var(--red)} .sum .v.green{color:var(--green)}
.dl{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.dl a{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ink300);border-radius:6px;
padding:10px 16px;text-decoration:none;color:var(--ink900);font-weight:700;font-size:14px}
.dl a.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.dl a:hover{border-color:var(--ink900)}
.err{background:var(--redbg);border:1px solid var(--red);color:var(--red);border-radius:8px;padding:14px 16px;
margin-top:20px;display:none;font-size:14px;white-space:pre-wrap}
.foot{margin-top:44px;padding-top:16px;border-top:1px solid var(--ink200);color:var(--ink700);font-size:12.5px}
.foot b{color:var(--ink800)}
</style></head><body><div class="wrap">

<h1><span class="ic">📋</span>감사보고서 검토</h1>
<p class="sub">DSD 파일을 넣으면 전수 대사·증감분석·심리 예상 질의를 자동으로 만들어 드립니다.</p>
<p class="meta">모든 처리는 <b>내 PC에서만</b> 이루어집니다 · 원본 파일은 변경되지 않습니다</p>

<div class="drop" id="drop">
  <div class="big">여기에 DSD 파일을 끌어다 놓으세요</div>
  <div class="small">또는 클릭해서 파일 선택 · 감사보고서 .dsd (연결·별도 모두 가능)</div>
  <input type="file" id="pick" accept=".dsd" style="display:none">
  <div class="file" id="fname"></div>
</div>

<button class="btn" id="run" disabled>검토 시작</button>

<div id="log">
  <div class="step" data-k="parse"><span class="dot"></span><span>DSD 파일 읽는 중</span></div>
  <div class="step" data-k="aom"><span class="dot"></span><span>재무제표·주석 구조 분석</span></div>
  <div class="step" data-k="engine"><span class="dot"></span><span>합계·참조·정합성 검증</span></div>
  <div class="step" data-k="report"><span class="dot"></span><span>결과 문서 생성</span></div>
</div>

<div class="err" id="err"></div>

<div id="result">
  <div class="card">
    <div style="font-size:17px;font-weight:800" id="rtitle">검토 완료</div>
    <div class="sum" id="rsum"></div>
    <div style="font-size:13px;color:var(--ink700);font-weight:700;margin-bottom:8px">결과 문서</div>
    <div class="dl" id="rdl"></div>
  </div>
</div>

<div class="foot">
  <b>감사보고서 검토 (ARI)</b> · 전수 대사 결과와 근거를 함께 제공합니다.<br>
  기계 검증은 오류를 단정하지 않으며, 확인이 필요한 항목을 근거와 함께 제시합니다.
</div>

</div>
<script>
const drop=document.getElementById('drop'), pick=document.getElementById('pick'),
      run=document.getElementById('run'), fname=document.getElementById('fname'),
      log=document.getElementById('log'), err=document.getElementById('err'),
      result=document.getElementById('result');
let file=null;

function setFile(f){
  if(!f) return;
  if(!/\\.dsd$/i.test(f.name)){ showErr('DSD 파일(.dsd)만 넣을 수 있습니다: '+f.name); return; }
  file=f; fname.innerHTML='선택된 파일: <b>'+f.name+'</b>'; run.disabled=false; err.style.display='none';
}
function showErr(m){ err.textContent=m; err.style.display='block'; }
function step(k,s){ const el=document.querySelector('[data-k="'+k+'"]'); if(el) el.className='step '+s; }

drop.addEventListener('click',()=>pick.click());
pick.addEventListener('change',e=>setFile(e.target.files[0]));
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',e=>setFile(e.dataTransfer.files[0]));

run.addEventListener('click',async()=>{
  if(!file) return;
  run.disabled=true; result.style.display='none'; err.style.display='none'; log.style.display='block';
  ['parse','aom','engine','report'].forEach(k=>step(k,''));
  step('parse','run');
  try{
    const buf=await file.arrayBuffer();
    const res=await fetch('/api/review?name='+encodeURIComponent(file.name),
      {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:buf});
    const data=await res.json();
    if(!res.ok||data.error) throw new Error(data.error||('서버 오류 '+res.status));
    ['parse','aom','engine','report'].forEach(k=>step(k,'done'));

    document.getElementById('rtitle').textContent=data.company+' · '+data.docName+' 검토 완료';
    document.getElementById('rsum').innerHTML=
      card('검증 일치율',data.score+'%','green')+
      card('확인 필요',data.review+'건',data.review>0?'':'green')+
      card('불일치',data.mismatch+'건',data.mismatch>0?'red':'green')+
      card('수행한 검증',data.total+'건','');
    document.getElementById('rdl').innerHTML=
      link('/out/'+data.id+'/dashboard.html','검토 결과 보기','primary',true)+
      link('/out/'+data.id+'/workbook.xlsx','엑셀 워크북','',false)+
      link('/out/'+data.id+'/report.docx','워드 리포트','',false)+
      link('/out/'+data.id+'/report.md','텍스트','',false);
    result.style.display='block';
    window.open('/out/'+data.id+'/dashboard.html','_blank');
  }catch(e){
    ['parse','aom','engine','report'].forEach(k=>{const el=document.querySelector('[data-k="'+k+'"]');
      if(el&&el.className.indexOf('done')<0) el.className='step';});
    showErr('검토 중 오류가 발생했습니다.\\n\\n'+e.message);
  }
  run.disabled=false;
});
function card(l,v,c){ return '<div><div class="l">'+l+'</div><div class="v '+c+'">'+v+'</div></div>'; }
function link(href,text,cls,blank){ return '<a href="'+href+'" '+(blank?'target="_blank"':'download')+' class="'+cls+'">'+text+'</a>'; }
</script></body></html>`;
