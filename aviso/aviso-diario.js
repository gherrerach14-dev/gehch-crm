// ── Agenda diaria GEHCH + motor de Cobros (copia exacta del CRM v101; misma lógica en el CRM y en el aviso de las 8:00) ──
// ── Cobros de hoy: qué toca hacer con cada cliente (misma lógica en el CRM y en el aviso de las 8:00) ──
// Los clientes pagan directo a la aseguradora; GEHCH da seguimiento. Gracia por aseguradora (config.cobros.gracia, 30 días por defecto).
const COB_ETAPAS = {
  llamar:      { p:1, i:"🚨", l:"Llamar: a punto de cancelar",        c:"#b91c1c", msg:"riesgo" },
  promesaRota: { p:2, i:"⚠️", l:"Promesa incumplida",                c:"#b91c1c", msg:"promesaRota" },
  inicial:     { p:3, i:"⏳", l:"Inicial sin pagar (Ley 146-02: 10 días)", c:"#b91c1c", msg:"inicial" },
  riesgo:      { p:4, i:"🔴", l:"Riesgo de cancelación",             c:"#c2410c", msg:"riesgo" },
  seg:         { p:5, i:"🟠", l:"Seguimiento: vencida",               c:"#c2410c", msg:"seg" },
  promesaHoy:  { p:6, i:"📅", l:"Promesa de pago para hoy",          c:"#7c3aed", msg:"promesaHoy" },
  cargo:       { p:7, i:"💳", l:"Confirmar cargo automático",        c:"#0369a1", msg:"cargo" },
  vence:       { p:8, i:"🟡", l:"Vence hoy",                         c:"#a16207", msg:"vence" },
  pre:         { p:9, i:"🔔", l:"Recordatorio: vence pronto",        c:"#15803d", msg:"pre" },
};
const COB_PERFIL = { puntual:{i:"🟢",l:"Puntual"}, irregular:{i:"🟡",l:"Irregular"}, moroso:{i:"🔴",l:"Moroso"}, nuevo:{i:"⚪",l:"Sin historial"} };
function gehchCobrosHoy(D, hoyISO){
  const [Y,M,DD] = hoyISO.split("-").map(Number); const base = Date.UTC(Y,M-1,DD);
  const dias = (iso) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return null; return Math.round((Date.UTC(+m[1],+m[2]-1,+m[3])-base)/86400000); };
  const entre = (a,b) => { const A=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(a||"")), B=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(b||"")); if(!A||!B) return null; return Math.round((Date.UTC(+B[1],+B[2]-1,+B[3])-Date.UTC(+A[1],+A[2]-1,+A[3]))/86400000); };
  const mas = (iso,n) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return ""; return new Date(Date.UTC(+m[1],+m[2]-1,+m[3]+n)).toISOString().slice(0,10); };
  const cfg = (D.config&&D.config.cobros) || {}; const GR = cfg.gracia || {};
  const gracia = (aseg) => Number(GR[aseg]) > 0 ? Number(GR[aseg]) : (Number(GR._def) > 0 ? Number(GR._def) : 30);
  const vig = (p) => !!p && ["Vigente","Por Renovar"].includes(p.estado);
  const polMap = {}; (D.polizas||[]).forEach(p=>{ polMap[String(p.id)] = p; });
  const gesMap = {}; (D.gestionesCxC||[]).forEach(g=>{ if(g && g.cuotaId!==undefined && !g.log) gesMap[String(g.cuotaId)] = g; });
  const saldo = (cu) => cu.estado==="Pagado" ? 0 : Math.round((Number(cu.monto||0) - (cu.parcial ? Number(cu.montoPagado||0) : 0))*100)/100;
  // Perfil de pago del cliente: con sus últimas 12 cuotas pagadas
  const hist = {};
  (D.planes||[]).forEach(cu=>{ const p=polMap[String(cu.polizaId)]; if(!p) return; const k=String(p.clienteId);
    if(cu.estado==="Pagado" && cu.fechaPago){ const a=entre(cu.fecha, cu.fechaPago); if(a!==null) (hist[k]=hist[k]||[]).push({f:cu.fecha, a:Math.max(0,a)}); } });
  const perfilDe = (cid, maxVenc) => {
    const h=(hist[String(cid)]||[]).sort((x,y)=>String(y.f).localeCompare(String(x.f))).slice(0,12);
    if(maxVenc>30) return "moroso";
    if(h.length<2) return "nuevo";
    const prom=h.reduce((s,x)=>s+x.a,0)/h.length, mx=Math.max(...h.map(x=>x.a));
    if(prom>15 || mx>30) return "moroso";
    if(prom<=3 && mx<=10) return "puntual";
    return "irregular";
  };
  // Cuotas pendientes por cliente
  const C = {};
  (D.planes||[]).forEach(cu=>{
    if(cu.estado==="Pagado") return; const p=polMap[String(cu.polizaId)]; if(!vig(p)) return;
    const s=saldo(cu); if(!(s>0.009)) return; const d=dias(cu.fecha); if(d===null) return;
    const k=String(p.clienteId); const g=C[k]||(C[k]={cid:p.clienteId, cuotas:[], maxVenc:0});
    g.cuotas.push({cu, p, d, s}); if(d<0) g.maxVenc=Math.max(g.maxVenc,-d);
  });
  const acciones = [];
  Object.values(C).forEach(g=>{
    const perfil = perfilDe(g.cid, g.maxVenc);
    const items = [];
    g.cuotas.forEach(x=>{
      const {cu,p,d} = x; const v=-d; const G=gracia(p.aseguradora); const ges=gesMap[String(cu.id)]||{}; const hechas=ges.etapas||{};
      const esInicial = Number(cu.numero)===1 && p.inicio && Math.abs(entre(p.inicio, cu.fecha)||0)<=3;
      const limite = esInicial ? mas(p.inicio,10) : mas(cu.fecha,G);
      let e=null, key=null;
      const prom = ges.promesaPago; const dp = prom ? dias(prom) : null;
      if(dp!==null && dp>0 && d<=0){ x.espera=prom; return; } // esperando la fecha que prometió: no molestar
      if(dp===0 && !hechas["promesaHoy:"+prom]){ e="promesaHoy"; key="promesaHoy:"+prom; }
      else if(dp!==null && dp<0 && d<0 && !hechas["promesaRota:"+prom]){ if(Number(ges.reprog||0)>=1){ e="llamar"; } else { e="promesaRota"; key="promesaRota:"+prom; } }
      if(!e){
        if(p.cargoAutomatico && d<=0 && v<3){ e="cargo"; }
        else if(esInicial && d<=0){ e = v>=7 ? "llamar" : v>=3 ? "inicial" : "vence"; }
        else if(d>0){ if(d<=3 || (perfil!=="puntual" && d<=7)){ e="pre"; key = d<=3 ? "pre" : "pre7"; } }
        else if(v<3){ e="vence"; }
        else if(v<7){ e = perfil==="moroso" ? "llamar" : "seg"; }
        else if(v < G-5){ e="riesgo"; }
        else { e="llamar"; }
      }
      if(!e) return;
      key = key || e;
      if(e==="llamar"){ const ult=hechas.llamar; if(ult && dias(ult)!==null && dias(ult)>-3) return; }
      else if(hechas[key]) return;
      items.push({ ...x, e, key, limite, G, esInicial });
    });
    if(!items.length) return;
    items.sort((a,b)=>COB_ETAPAS[a.e].p-COB_ETAPAS[b.e].p);
    const e = items[0].e;
    // El mensaje incluye todo lo pendiente del cliente que vence en 15 días o ya venció
    const incluir = g.cuotas.filter(x=>x.d<=15).sort((a,b)=>String(a.cu.fecha).localeCompare(String(b.cu.fecha)));
    const tot={}; incluir.forEach(x=>{ tot[x.p.moneda]=(tot[x.p.moneda]||0)+x.s; });
    const conCargo = g.cuotas.some(x=>x.p.cargoAutomatico);
    acciones.push({ cid:g.cid, cliente:(D.clientes||[]).find(c=>String(c.id)===String(g.cid)), e, items, incluir, tot, perfil, maxVenc:g.maxVenc,
      limite: items.map(x=>x.limite).filter(Boolean).sort()[0]||"", sugerirCargo: !conCargo && (perfil==="irregular"||perfil==="moroso") });
  });
  acciones.sort((a,b)=>(COB_ETAPAS[a.e].p-COB_ETAPAS[b.e].p) || (b.maxVenc-a.maxVenc));
  // Conciliación mensual por aseguradora
  const conc = (D.config&&D.config.conciliaciones) || {};
  const nPorAseg = {}; Object.values(C).forEach(g=>g.cuotas.forEach(x=>{ const a=x.p.aseguradora; if(a) nPorAseg[a]=(nPorAseg[a]||0)+1; }));
  const asegs = Object.keys(nPorAseg).filter(a=>nPorAseg[a]>=3); // solo aseguradoras con cartera pendiente relevante
  const conciliar = asegs.map(a=>{ const r=conc[a]; const ult=r&&(r.cargado||r.fechaCorte)||""; const dd=ult?-dias(ult):null; return { aseg:a, ultima:ult, dias:dd }; })
    .filter(x=>x.dias===null || x.dias>30).sort((a,b)=>(b.dias===null?9999:b.dias)-(a.dias===null?9999:a.dias));
  return { acciones, conciliar, perfiles: Object.fromEntries(Object.values(C).map(g=>[String(g.cid), perfilDe(g.cid,g.maxVenc)])) };
}
// Indicadores de cobranza (mes en curso y últimos 90 días). Montos en RD$ (US$ × tasa de config.cobros.tasa, 60 por defecto) solo para los %.
function gehchCobrosKPI(D, hoyISO){
  const [Y,M,DD] = hoyISO.split("-").map(Number); const base = Date.UTC(Y,M-1,DD);
  const dias = (iso) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return null; return Math.round((Date.UTC(+m[1],+m[2]-1,+m[3])-base)/86400000); };
  const entre = (a,b) => { const A=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(a||"")), B=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(b||"")); if(!A||!B) return null; return Math.round((Date.UTC(+B[1],+B[2]-1,+B[3])-Date.UTC(+A[1],+A[2]-1,+A[3]))/86400000); };
  const tasa = Number(D.config&&D.config.cobros&&D.config.cobros.tasa) || 60; const rd = (v,m) => m==="USD" ? v*tasa : v;
  const mes = hoyISO.slice(0,7); const finMes = new Date(Date.UTC(Y,M,0)).toISOString().slice(0,10);
  const polMap = {}; (D.polizas||[]).forEach(p=>{ polMap[String(p.id)] = p; });
  const vig = (p) => !!p && ["Vigente","Por Renovar"].includes(p.estado);
  const add = (o,m,v) => { o[m]=(o[m]||0)+v; };
  const cobradoMes={}, porCobrarMes={}, pendiente={}, vencido={}; const A={};
  let nATiempo=0, nPag90=0, sumAtraso=0, recuperado=0, vencidoNoPag=0;
  (D.planes||[]).forEach(cu=>{
    const p=polMap[String(cu.polizaId)]; if(!p) return; const m=p.moneda||"RD$"; const a=p.aseguradora||"—";
    const X = A[a] || (A[a]={pend:0, venc:0, nPag:0, atraso:0, aTiempo:0});
    if(cu.estado==="Pagado"){
      const mp = Number(cu.montoPagado ?? cu.monto)||0;
      if(String(cu.fechaPago||"").slice(0,7)===mes) add(cobradoMes,m,mp);
      const df = dias(cu.fecha); const at = entre(cu.fecha, cu.fechaPago);
      if(df!==null && df<=0 && df>=-90 && at!==null){ nPag90++; X.nPag++; const a2=Math.max(0,at); sumAtraso+=a2; X.atraso+=a2; if(at<=0){ nATiempo++; X.aTiempo++; } else recuperado+=rd(mp,m); }
      return;
    }
    if(!vig(p)) return;
    const s = Number(cu.monto||0) - (cu.parcial ? Number(cu.montoPagado||0) : 0); if(!(s>0.009)) return;
    if(cu.parcial && String((cu.abonos||[]).slice(-1)[0]?.fecha||"").slice(0,7)===mes) add(cobradoMes,m,Number(cu.montoPagado||0));
    add(pendiente,m,s); X.pend+=rd(s,m);
    if(String(cu.fecha)<=finMes) add(porCobrarMes,m,s);
    const d=dias(cu.fecha); if(d!==null && d<0){ add(vencido,m,s); X.venc+=rd(s,m); vencidoNoPag+=rd(s,m); }
  });
  const totRD = (o) => Object.entries(o).reduce((s,[m,v])=>s+rd(v,m),0);
  const resProm = (g) => g.resultado && g.resultado!=="reprogramada" ? g.resultado : (!g.resultado && g.promesa && String(g.promesa)<hoyISO ? "incumplida" : null);
  const prom = (D.gestionesCxC||[]).filter(g=>g && g.log && g.tipo==="promesa" && resProm(g));
  const promCumplidas = prom.filter(g=>resProm(g)==="cumplida").length;
  const porAseg = Object.entries(A).filter(([,x])=>x.pend>0||x.nPag>0).map(([a,x])=>({ aseg:a, pendRD:Math.round(x.pend), vencRD:Math.round(x.venc), morosidad: x.pend>0?Math.round(x.venc/x.pend*1000)/10:0, atrasoProm: x.nPag?Math.round(x.atraso/x.nPag*10)/10:null, aTiempo: x.nPag?Math.round(x.aTiempo/x.nPag*1000)/10:null }))
    .sort((a,b)=>b.vencRD-a.vencRD);
  return {
    mes, cobradoMes, porCobrarMes, pendiente, vencido,
    pctATiempo: nPag90 ? Math.round(nATiempo/nPag90*1000)/10 : null,
    atrasoProm: nPag90 ? Math.round(sumAtraso/nPag90*10)/10 : null,
    morosidad: totRD(pendiente) ? Math.round(totRD(vencido)/totRD(pendiente)*1000)/10 : 0,
    recuperacion: (recuperado+vencidoNoPag) ? Math.round(recuperado/(recuperado+vencidoNoPag)*1000)/10 : null,
    promesas: { total: prom.length, cumplidas: promCumplidas, pct: prom.length ? Math.round(promCumplidas/prom.length*1000)/10 : null },
    porAseg, tasa
  };
}
function gehchCobrosInforme(D, hoyISO){
  const k = gehchCobrosKPI(D, hoyISO); const h = gehchCobrosHoy(D, hoyISO);
  const mon = (n,m) => (m==="USD"?"US$ ":"RD$ ") + Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const t = (o) => Object.entries(o).map(([m,v])=>mon(v,m)).join(" + ") || "—";
  const n = (e) => h.acciones.filter(a=>a.e===e).length;
  return [
    `📊 INFORME SEMANAL DE COBROS · ${hoyISO.split("-").reverse().join("/")}`,
    ``,
    `Cobrado este mes: ${t(k.cobradoMes)}`,
    `Por cobrar hasta fin de mes: ${t(k.porCobrarMes)}`,
    `Vencido: ${t(k.vencido)} · morosidad ${k.morosidad}%`,
    `Pagado a tiempo (90 días): ${k.pctATiempo===null?"—":k.pctATiempo+"%"} · atraso promedio ${k.atrasoProm===null?"—":k.atrasoProm+" días"}`,
    `Recuperación de vencidas: ${k.recuperacion===null?"—":k.recuperacion+"%"} · promesas cumplidas ${k.promesas.pct===null?"—":k.promesas.pct+"% ("+k.promesas.cumplidas+"/"+k.promesas.total+")"}`,
    ``,
    `Acciones abiertas: ${h.acciones.length} (🚨 ${n("llamar")} llamadas · ⏳ ${n("inicial")} iniciales · 🔴 ${n("riesgo")} en riesgo · ⚠️ ${n("promesaRota")} promesas incumplidas)`,
    h.conciliar.length ? `Conciliación pendiente: ${h.conciliar.map(c=>c.aseg).join(", ")}` : `Conciliación al día`,
    ``,
    `Morosidad por aseguradora:`,
    ...k.porAseg.filter(a=>a.vencRD>0).slice(0,8).map(a=>`• ${a.aseg}: ${a.morosidad}% vencido${a.atrasoProm===null?"":" · atraso prom. "+a.atrasoProm+" días"}`)
  ].join("\n");
}

// ── Agenda diaria GEHCH: lo que hay que atender hoy (misma lógica en el CRM y en el aviso de las 8:00) ──
function gehchAgenda(D, hoyISO){
  const [Y,M,DD] = hoyISO.split("-").map(Number);
  const base = Date.UTC(Y,M-1,DD);
  const dias = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return null; return Math.round((Date.UTC(+m[1],+m[2]-1,+m[3]) - base)/86400000); };
  const norm = (s) => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim();
  const mismo = (a,b) => { const A=norm(a).split(" ").filter(Boolean), B=norm(b).split(" ").filter(Boolean); if(!A.length||!B.length) return false; const [m,Mx]=A.length<=B.length?[A,B]:[B,A]; return m.length>=2 && m.every(w=>Mx.includes(w)); };
  const nomC = (c) => c ? `${c.nombre||""} ${c.apellido||""}`.replace(/\s+/g," ").trim() : "—";
  const cliente = (id) => (D.clientes||[]).find(c=>String(c.id)===String(id));
  const poliza = (id) => (D.polizas||[]).find(p=>String(p.id)===String(id));
  const vigente = (p) => !!p && ["Vigente","Por Renovar"].includes(p.estado);
  const f = (iso) => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : "";
  const mon = (n,m) => (m==="USD"?"US$ ":"RD$ ") + Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const corto = (s) => { s=String(s||"").replace(/\s+/g," ").trim(); return s.length>70 ? s.slice(0,67)+"…" : s; };
  const cuando = (d) => d===0 ? "Hoy" : `Atrasado ${-d}d`;
  const bisiesto = (Y%4===0 && Y%100!==0) || Y%400===0;
  const esCumple = (nac) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(nac||"")); if(!m) return false; let mm=+m[2], dd=+m[3]; if(mm===2 && dd===29 && !bisiesto) dd=28; return mm===M && dd===DD; };
  const edad = (nac) => Y - Number(String(nac).slice(0,4));
  const L = { cumple:[], ren:[], seg:[], cuo:[], recl:[], port:[] };

  // 🎂 Cumpleaños de hoy: clientes y asegurados de los listados (sin repetir)
  const yaNombres = [];
  (D.clientes||[]).forEach(c=>{ if(c.tipoCliente!=="Empresa" && esCumple(c.nacimiento)){ L.cumple.push({k:`cumple:c${c.id}:${Y}`, cid:c.id, t:`${nomC(c)} — cumple ${edad(c.nacimiento)}${c.telPrincipal?" · "+c.telPrincipal:""}`}); } });
  const nombresCli = (D.clientes||[]).map(nomC);
  (D.unidades||[]).forEach(u=>{
    if(!u.nombre || !esCumple(u.nacimiento)) return;
    const p = poliza(u.polizaId); if(!vigente(p)) return;
    if(nombresCli.some(n=>mismo(n,u.nombre)) || yaNombres.some(n=>mismo(n,u.nombre))) return;
    yaNombres.push(u.nombre);
    const tit = (u.titular && !mismo(u.titular,u.nombre)) ? u.titular : nomC(cliente(p.clienteId));
    L.cumple.push({k:`cumple:u${norm(u.nombre)}:${Y}`, cid:p.clienteId, t:`${u.nombre} — cumple ${edad(u.nacimiento)} · asegurado de ${tit}`});
  });

  // 🔄 Renovaciones: lote mensual en 5 pasos; la agenda avisa solo cuando un paso se atrasa

  const renovEsFlota = (p, nV) => { if(nV>3) return true; if(/salud|vida|accidente/i.test(p.ramo||"")) return false; const fx = p.moneda==="USD" ? 60 : 1; return Number(p.prima||0)*fx>=150000 || Number(p.sumaAsegurada||0)*fx>=10000000; };
  const renovInfo = (p, hoyISO, nV) => {
    if(!p || !["Vigente","Por Renovar"].includes(p.estado) || !p.fin) return null;
    const [Y,M,DD] = hoyISO.split("-").map(Number); const adel = renovEsFlota(p,nV) ? 2 : 1;
    const lim = new Date(Date.UTC(Y, M-1+adel+1, 0)).toISOString().slice(0,10);
    const fin = String(p.fin).slice(0,10); if(fin > lim) return null;
    const d = Math.round((Date.UTC(+fin.slice(0,4), +fin.slice(5,7)-1, +fin.slice(8,10)) - Date.UTC(Y, M-1, DD))/86400000);
    const r = p.renov || {}; const prima = Number(p.prima)||0; const nueva = Number(r.primaNueva)||0;
    const varPct = (nueva>0 && prima>0) ? Math.round((nueva-prima)/prima*1000)/10 : null;
    const etapa = r.decision ? "decidido" : r.presentada ? "presentada" : (nueva>0 && r.ajusteSolicitado && !r.ajusteResultado) ? "negociando" : nueva>0 ? (varPct>0 ? ((r.cotizado||r.noCotizar) ? "cotizada" : "subio") : "igual") : r.pedida ? "esperando" : "porGestionar";
    return { d, etapa, varPct, flota: adel===2, lote: fin.slice(0,7), r };
  };
  const MESN = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const PASO = { porGestionar:"sin pedir", esperando:"esperando la renovación", subio:"subió, sin cotizar", negociando:"negociando con la aseguradora", igual:"sin notificar", cotizada:"cotizada, sin notificar", presentada:"sin decisión del cliente" };
  const nVeh = (pid) => (D.unidades||[]).filter(u=>String(u.polizaId)===String(pid) && (u.chasis||u.marca)).length;
  const lotes = {};
  (D.polizas||[]).filter(vigente).map(p=>({p,inf:renovInfo(p,hoyISO,nVeh(p.id))})).filter(x=>x.inf).sort((a,b)=>a.inf.d-b.inf.d).forEach(({p,inf})=>{
    const { d, etapa, varPct, r } = inf;
    const t = `${nomC(cliente(p.clienteId))} · ${p.ramo||""} · ${p.aseguradora||"—"} · ${p.numero}`;
    const k = (x) => `ren:${p.id}:${p.fin}:${x}`;
    if(etapa==="porGestionar" && d>=0) lotes[inf.lote] = (lotes[inf.lote]||0) + 1;
    if(d<0){ if(d>=-60) L.ren.push({k:k("vencida"), cid:p.clienteId, t:`Venció hace ${-d}d sin renovar: ${t}`}); return; }
    if(etapa==="decidido"){ if(d===0) L.ren.push({k:k("0"), cid:p.clienteId, t:`VENCE HOY (${r.decision}): ${t}`}); return; }
    if(d===0){ L.ren.push({k:k("0"), cid:p.clienteId, t:`VENCE HOY sin cerrar (${PASO[etapa]}): ${t}`}); return; }
    if(d<=7){ L.ren.push({k:k("urg:"+hoyISO), cid:p.clienteId, t:`🚨 Vence en ${d} día(s) sin cerrar (${PASO[etapa]}): ${t}`}); return; }
    if(etapa==="porGestionar" && d<=21) L.ren.push({k:k("sinpedir:"+hoyISO), cid:p.clienteId, t:`Paso 1 atrasado · sin pedir y vence en ${d} días: ${t}`});
    if(etapa==="esperando"){ const dp=dias(r.pedida); if(dp!==null && dp<=-15) L.ren.push({k:k("repedir:"+hoyISO), cid:p.clienteId, t:`Paso 2 · renovación no recibida (pedida hace ${-dp} días), pedirla de nuevo: ${t}`}); }
    if(etapa==="negociando"){ const da=dias(r.ajusteSolicitado); if(da!==null && da<=-5) L.ren.push({k:k("negocia:"+hoyISO), cid:p.clienteId, t:`Seguimiento a ${p.aseguradora||"la aseguradora"}: ajuste solicitado hace ${-da} días sin respuesta · ${t}`}); }
    if(etapa==="subio") L.ren.push({k:k("subio:"+hoyISO), cid:p.clienteId, t:`Paso 3 · subió +${varPct}%: cotizar y preparar comparativo · ${t}`});
    if((etapa==="igual"||etapa==="cotizada") && d<=21) L.ren.push({k:k("notif:"+hoyISO), cid:p.clienteId, t:`Paso 4 · notificar al cliente (vence en ${d} días)${etapa==="igual"?(varPct<0?" · bajó "+(-varPct)+"%":" · sin aumento"):(r.noCotizar&&!r.cotizado?" · ajuste de +"+varPct+"%, sin cotizar":" · enviar comparativo")}: ${t}`});
    if(etapa==="presentada" && d<=14) L.ren.push({k:k("decide:"+hoyISO), cid:p.clienteId, t:`Paso 5 · cliente sin decidir (vence en ${d} días): ${t}`});
  });
  Object.keys(lotes).sort().reverse().forEach(m=>{ L.ren.unshift({k:`ren:lote:${m}:${hoyISO}`, t:`📦 Renovaciones de ${MESN[+m.slice(5,7)-1]}: ${lotes[m]} póliza(s) por pedir a las aseguradoras (menú Renovaciones)`}); });

  // 📅 Seguimientos con fecha: recordatorios, contactos, gestiones de renovación y promesas de pago
  const seg = [];
  (D.recordatorios||[]).forEach(r=>{ if(r.completado) return; const d=dias(r.fecha); if(d===null||d>0) return; const c=cliente(r.clienteId); seg.push({d, k:`rec:${r.id}:${r.fecha}`, recId:r.id, cid:r.clienteId, t:`${cuando(d)}: ${r.hora?r.hora+" · ":""}${r.tipo?r.tipo+": ":""}${r.titulo||"Recordatorio"}${c?" — "+nomC(c):""}${r.nota?" · "+corto(r.nota):""}`}); });
  (D.contactos||[]).forEach(x=>{ const d=dias(x.fechaProxima); if(d!==0) return; seg.push({d, k:`cont:${x.id}:${x.fechaProxima}`, cid:x.clienteId, t:`Hoy: ${x.proximaAccion||"Seguimiento"} — ${nomC(cliente(x.clienteId))}`}); });
  (D.gestionesRenov||[]).forEach(g=>{ const p=poliza(g.polizaId); if(!vigente(p)) return; if(/^(renovada|no renovada)$/i.test(String(g.estado||"").trim())) return; const d=dias(g.fechaProxima); if(d===null||d>0||d<-60) return; seg.push({d, k:`gren:${g.polizaId}:${g.fechaProxima}`, cid:p.clienteId, t:`${cuando(d)}: renovación ${nomC(cliente(p.clienteId))} · ${p.numero} (${g.estado||"en gestión"})${g.nota?" · "+corto(g.nota):""}`}); });
  /* promesas de pago: ver sección Cobros */
  L.seg = seg.sort((a,b)=>b.d-a.d).map(({d,...x})=>x);

  // 💰 Cobros de hoy: llamadas urgentes con nombre; el resto de mensajes en una línea; conciliación mensual; los lunes, el informe semanal
  const CH = gehchCobrosHoy(D, hoyISO);
  const urg = CH.acciones.filter(a=>["llamar","promesaRota","inicial"].includes(a.e));
  urg.forEach(a=>{ L.cuo.push({k:`cob:${a.cid}:${a.e}:${hoyISO}`, cid:a.cid, t:`${COB_ETAPAS[a.e].i} ${COB_ETAPAS[a.e].l}: ${nomC(a.cliente)}${a.cliente&&a.cliente.telPrincipal?" · "+a.cliente.telPrincipal:""} · ${Object.entries(a.tot).map(([m,v])=>mon(v,m)).join(" + ")}${a.limite?" · puede cancelar desde el "+f(a.limite):""}`}); });
  const resto = CH.acciones.length - urg.length;
  if(resto) L.cuo.push({k:`cob:resto:${hoyISO}:${resto}`, t:`💬 ${resto} mensaje(s) de cobro por enviar hoy (recordatorios, vencidas, promesas) · menú Cobros → Cobros de hoy`});
  if(CH.conciliar.length) L.cuo.push({k:`cob:conc:${CH.conciliar.map(c=>c.aseg).join(",")}:${hoyISO.slice(0,7)}`, t:`⚖️ Conciliación mensual pendiente: ${CH.conciliar.map(c=>`${c.aseg} (${c.ultima?"hace "+c.dias+" días":"nunca"})`).join(", ")}`});
  if(new Date(base).getUTCDay()===1) L.cuo.push({k:`cob:informe:${hoyISO}`, t: gehchCobrosInforme(D, hoyISO)});
  // 🧾 Pólizas declarativas: toca declarar cuando pasa el período sin factura nueva
  const masMeses = (iso,n) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return null; const t=new Date(Date.UTC(+m[1],+m[2]-1+n,1)); const dim=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate(); return t.getUTCFullYear()+"-"+String(t.getUTCMonth()+1).padStart(2,"0")+"-"+String(Math.min(+m[3],dim)).padStart(2,"0"); };
  (D.polizas||[]).filter(p=>vigente(p) && p.declarativa).forEach(p=>{
    const ult = (p.facturas||[]).map(x=>x.hasta).filter(Boolean).sort().pop();
    const ref = ult || p.inicio; if(!ref || (p.fin && ref>=p.fin)) return;
    let esp = masMeses(ref, Number(p.periodoDecl||3)); if(!esp) return; if(p.fin && esp>p.fin) esp = p.fin;
    const d = dias(esp); if(d===null || d>0) return;
    L.cuo.push({k:`decl:${p.id}:${esp}`, cid:p.clienteId, t:`Declaración pendiente: ${nomC(cliente(p.clienteId))} · ${p.numero} · ${ult?"última hasta "+f(ult):"sin facturas registradas"} (declara cada ${p.periodoDecl||3} meses)`});
  });

  // 🚗 Reclamaciones abiertas en el CRM
  const AP = { sinNumero:2, docsCada:3, inspeccion:5, aprobacion:7, sinMov:3, carta:2, piezasCada:3, tallerCada:2, rentadoAviso:3 };
  const masDias = (iso,n) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return ""; return new Date(Date.UTC(+m[1],+m[2]-1,+m[3]+n)).toISOString().slice(0,10); };
  (D.reclamos||[]).forEach(r=>{ const a=r.auto; if(!a || r.estado==="Cerrado" || (a.alterno&&a.alterno.tipo)) return;
    const c=cliente(r.clienteId); const p=poliza(r.polizaId); const who=`${nomC(c)} · reclamo ${r.numeroReclamo||"s/n"}${p?" · "+(p.aseguradora||""):""}`; const F=a.fechas||{}; const kk=(x)=>`rauto:${r.id}:${x}`; let n=0; const add=(x,t)=>{ L.recl.push({k:kk(x), cid:r.clienteId, t}); n++; };
    const R=a.rentado;
    if(R && R.activo && R.inicio && !R.devuelto && a.etapa!=="entregado"){
      const total=Number(R.diasPoliza)||15; const finCob=masDias(R.inicio,total-1); const hasta=((R.cartas||[]).map(x=>x.hasta).filter(Boolean).sort().pop())||null;
      const nC=(R.cartas||[]).filter(x=>x.hasta).length; const dh=hasta?dias(hasta):null; const df=dias(finCob);
      if(!hasta){ const di=dias(R.inicio); if(di!==null && di<=0) add("sincarta:"+hoyISO, `🚨 Vehículo rentado SIN carta de autorización registrada: ${who}`); }
      else if(hasta<finCob){
        if(dh<0) add("cartavencida:"+hoyISO, `🚨 Venció hace ${-dh} día(s) la carta ${nC} del vehículo rentado y no hay carta nueva: ${who}`);
        else if(dh===0) add("cartahoy:"+hasta, `🚨 HOY vence la carta ${nC} del vehículo rentado: pedir la carta ${nC+1} YA · ${who}`);
        else if(dh<=AP.carta) add("cartapedir:"+hasta, `🔔 Pedir a ${p?p.aseguradora:"la aseguradora"} la carta ${nC+1} del vehículo rentado (la actual vence el ${f(hasta)}): ${who}`);
      }
      if(df!==null && df>=0 && df<=AP.rentadoAviso) add("rentfin:"+finCob, `🔔 Quedan ${df+1} día(s) de vehículo rentado de ${total} (hasta ${f(finCob)}): avisar al cliente y apurar al taller · ${who}`);
      else if(df!==null && df<0) add("rentagotado:"+hoyISO, `🚨 Se agotó el vehículo rentado (${total} días) y el carro no ha sido entregado: coordinar con el cliente · ${who}`);
    }
    const dE=(k)=>{ const x=F[k]?dias(F[k]):null; return x===null?null:-x; };
    const pend=(a.docs||[]).filter(x=>!x.entregado).map(x=>x.doc);
    if(a.etapa==="reportado" && !r.numeroReclamo && (dE("reportado")??0)>=AP.sinNumero) add("sinnum:"+hoyISO, `Reclamo sin número hace ${dE("reportado")} días: pedirlo a ${p?p.aseguradora:"la aseguradora"} · ${who}`);
    if((a.etapa==="documentos"||a.etapa==="abierto") && pend.length){ const dd=dE("documentos")??dE("abierto")??0; if(dd>=AP.docsCada && dd%AP.docsCada===0) add("docs:"+hoyISO, `Pedir al cliente: ${pend.join(", ")} (pendiente hace ${dd} días) · ${who}`); }
    if(a.etapa==="entregados" && (dE("entregados")??0)>=AP.inspeccion) add("insp:"+hoyISO, `${dE("entregados")} días con documentos entregados y sin inspección: llamar a ${p?p.aseguradora:"la aseguradora"} · ${who}`);
    if(a.etapa==="inspeccion" && (dE("inspeccion")??0)>=AP.aprobacion) add("aprob:"+hoyISO, `${dE("inspeccion")} días en inspección sin aprobación: dar seguimiento · ${who}`);
    if(a.etapa==="piezas" && a.llegadaEstimada){ const dl=dias(a.llegadaEstimada); if(dl===0) add("piezashoy:"+a.llegadaEstimada, `Hoy deben llegar las piezas: confirmar con el taller · ${who}`); else if(dl<0 && (-dl)%AP.piezasCada===0) add("piezastarde:"+hoyISO, `Piezas atrasadas ${-dl} días (debían llegar el ${f(a.llegadaEstimada)}) · ${who}`); }
    if(a.etapa==="taller" && F.taller && Number(a.diasTaller)>0){ const fin=masDias(F.taller,Number(a.diasTaller)); const dt=dias(fin); if(dt===0) add("tallerhoy:"+fin, `Hoy se cumple el plazo del taller (${a.diasTaller} días): confirmar entrega · ${who}`); else if(dt<0 && (-dt)%AP.tallerCada===0) add("tallertarde:"+hoyISO, `El taller pasó ${-dt} días del plazo de entrega · ${who}`); }
    if(!n){ const fs=[r.fechaApertura,r.actualizado,...Object.values(F),...((R&&R.cartas)||[]).map(x=>x.registrada||x.desde),...(r.historial||[]).map(h=>h.fecha)].filter(x=>/^\d{4}-\d{2}-\d{2}/.test(String(x||""))).map(x=>String(x).slice(0,10)).sort(); const ult=fs[fs.length-1]; const du=ult?-dias(ult):0; if(du>=AP.sinMov) add("sinmov:"+hoyISO, `${du} días sin movimiento (${a.etapa}) · ${who}`); }
  });
  (D.reclamos||[]).forEach(r=>{ if(r.estado==="Cerrado" || r.auto) return; const c=cliente(r.clienteId); const pend=Object.values(r.checklist||{}).filter(v=>v&&!v.completado).length; const d=dias(r.fechaApertura);
    L.recl.push({k:`recl:${r.id}:${r.estado}`, cid:r.clienteId, t:`${nomC(c)} · reclamo ${r.numeroReclamo||"s/n"} · ${r.estado}${d!==null?" · "+(-d)+" días abierto":""}${pend?" · "+pend+" documento(s) pendiente(s)":""}`}); });

  // 🩺 Reembolsos del portal
  const PLAZOS = { "Seguros Reservas": { Local: 90, Extranjero: 180 } };
  let enTramite = 0; const port = L.port; const ahoraMs = Number(D.ahoraMs)||Date.now();
  (D.rc||[]).forEach(r=>{
    const ui = r.estado==="Documentos adicionales" ? (r.origenDocs==="aseguradora" ? "Solicitado por aseguradora" : "Incompleto") : r.estado;
    const quien = `${r.clienteNombre||""}${r.paciente&&r.paciente.nombre?" / "+r.paciente.nombre:""}`;
    const cerrado = r.estado==="Pagado" || r.estado==="Rechazado";
    if(!cerrado) enTramite++;
    if(r.estado==="Recibido" && !r.visto) port.push({k:`rc:${r.key||""}/${r.id}:nuevo`, t:`NUEVO ${r.id}: ${quien}`});
    if(r.estado==="Documentos adicionales" && r.adicionalesEnviados && !r.adicionalesVistos) port.push({k:`rc:${r.key||""}/${r.id}:docs:${r.adicionalesEnviados}`, t:`Documentos recibidos ${r.id}: ${quien}`});
    // Sin movimiento: todo reclamo abierto que pase 24 horas sin actualizarse sale en la agenda cada día hasta que se actualice
    if(!cerrado){
      const ult = Math.max(Number(r.creadoMs)||0, Number(r.actualizado)||0, Number(r.aprobadoMs)||0, Number(r.adicionalesEnviados)||0, ...(r.historial||[]).map(h=>Number(h.fecha)||0));
      const horas = ult ? (ahoraMs-ult)/3600000 : 0;
      if(horas>=24){
        const nd = Math.floor(horas/24), dtx = nd===1 ? "1 día" : nd+" días";
        const aseg = (r.poliza&&r.poliza.aseguradora) || "la aseguradora";
        const txt = r.estado==="Recibido" ? `Lleva ${dtx} sin enviar a ${aseg}`
          : r.estado==="Enviado a aseguradora" ? `${dtx} sin respuesta de ${aseg} · llamar`
          : r.estado==="Documentos adicionales" ? (r.origenDocs==="aseguradora" ? `${dtx} esperando documentos que pidió ${aseg}` : `${dtx} esperando documentos del cliente`)
          : r.estado==="Aprobado" ? `Aprobado hace ${dtx} · confirmar el pago con ${aseg}`
          : `${dtx} sin actualizar (${ui})`;
        port.push({k:`rc:${r.key||""}/${r.id}:sinmov:${hoyISO}`, t:`${quien} · ${r.id} — ${txt}`});
      }
    }
    if(!cerrado && r.estado!=="Aprobado"){ const pl=(PLAZOS[r.poliza&&r.poliza.aseguradora]||{})[r.origen]; if(pl){ const ds=(r.procedimientos||[]).map(x=>dias(x.fecha)).filter(x=>x!==null).map(x=>pl+x); if(ds.length){ const m=Math.min(...ds); if(m<=15) port.push({k:`rc:${r.key||""}/${r.id}:plazo:${m<0?"vencido":m<=5?"5":"15"}`, t:`Plazo ${m<0?"VENCIDO":"de "+m+" días"} ${r.id}: ${quien}`}); } } }
    if(r.estado!=="Recibido" && r.avisoEstado!==ui) port.push({k:`rc:${r.key||""}/${r.id}:aviso:${ui}`, t:`Sin notificar al cliente (${ui}) ${r.id}: ${quien}`});
  });
  if(enTramite) port.push({k:`rc:tramite:${enTramite}`, t:`Reembolsos en trámite: ${enTramite}`});

  // Hechos y pospuestos (se marcan en el CRM): lo hecho no vuelve; lo pospuesto reaparece en su nueva fecha
  const E = D.agendaEstado || {};
  const SECC = [["cumple","🎂","Cumpleaños de hoy"],["ren","🔄","Renovaciones"],["seg","📅","Seguimientos y recordatorios"],["cuo","💰","Cobros"],["recl","🚗","Reclamaciones abiertas"],["port","🩺","Reembolsos del portal"]];
  const generados = new Set();
  Object.values(L).forEach(arr=>arr.forEach(it=>generados.add(it.k)));
  Object.entries(E).forEach(([k,e])=>{ if(e && e.estado==="pospuesto" && e.hasta<=hoyISO && !generados.has(k) && L[e.seccion]) L[e.seccion].push({k, t:e.texto||k}); });
  const S = [];
  SECC.forEach(([id,icono,titulo])=>{
    const items = L[id].filter(it=>{ const e=E[it.k]; if(!e) return true; if(e.estado==="hecho") return false; if(e.estado==="pospuesto") return e.hasta<=hoyISO; return true; })
      .map(it=>{ const e=E[it.k]; return { ...it, seccion:id, t: (e&&e.estado==="pospuesto" ? "⏰ " : "") + it.t }; });
    if(items.length) S.push({ id, icono, titulo, items });
  });

  const lineas = [];
  S.forEach(s=>{ lineas.push(`${s.icono} ${s.titulo.toUpperCase()} (${s.items.length})`); s.items.slice(0,12).forEach(i=>lineas.push("• "+i.t)); if(s.items.length>12) lineas.push(`• … y ${s.items.length-12} más (ver CRM)`); lineas.push(""); });
  let texto = lineas.join("\n").trim() || "✅ Sin pendientes para hoy.";
  if(texto.length>3900) texto = texto.slice(0,3880)+"\n… (ver CRM)";
  return { secciones:S, texto, total:S.reduce((a,s)=>a+s.items.length,0), fecha:hoyISO };
}

// ── Envío automático (GitHub Actions: varios intentos cada mañana, se envía un solo aviso por día) ──
// Lee los datos del CRM (proyecto crm-gehch) y de los reembolsos (proyecto gehch-reclamos) con llaves
// guardadas como secretos de GitHub, arma la agenda del día y la manda al canal privado de ntfy.
// No imprime datos de clientes en el registro de GitHub: solo cantidades.
const admin = require("firebase-admin");
async function main(){
  if(!process.env.FIREBASE_CRM) throw new Error("Falta el secreto FIREBASE_CRM");
  const crm = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CRM)) }, "crm");
  const db = crm.firestore();
  const leer = async (k, def) => { const s = await db.collection("gehch").doc(k).get(); return s.exists ? JSON.parse(s.data().data) : def; };
  const K = ["clientes","polizas","planes","recordatorios","gestionesRenov","gestionesCxC","contactos","reclamos","unidades"];
  const D = {};
  for(const k of K) D[k] = await leer("gehch2:"+k, []);
  D.agendaEstado = await leer("gehch2:agendaEstado", {});
  const config = await leer("gehch2:config", {});
  D.config = config;
  const tema = process.env.NTFY_TEMA || config.ntfyTema;
  if(!tema) throw new Error("No hay canal de ntfy: créelo en el CRM (Dashboard → Aviso al celular)");
  D.rc = [];
  if(process.env.FIREBASE_RECLAMOS){
    const rcApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_RECLAMOS)) }, "rc");
    const s = await rcApp.firestore().collectionGroup("reclamos").get();
    D.rc = s.docs.map(d=>({ ...d.data(), id:d.id, key:d.ref.parent.parent.id }));
  }
  // Fecha de hoy en República Dominicana (UTC-4, sin horario de verano)
  const rd = new Date(Date.now() - 4*3600*1000);
  const hoy = rd.toISOString().slice(0,10);
  // Un solo aviso por día: GitHub corre varios intentos cada mañana; el primero que llega envía y los demás no.
  // (Si se corre a mano con "Run workflow", envía siempre.)
  const marca = db.collection("gehch").doc("avisoDiario");
  const manual = process.env.EVENTO === "workflow_dispatch";
  if(!manual){
    const tomado = await db.runTransaction(async t=>{ const s=await t.get(marca); if(s.exists && s.data().fecha===hoy) return false; t.set(marca,{ fecha:hoy, estado:"enviando", hora:new Date().toISOString() }); return true; });
    if(!tomado){ console.log(`El aviso de hoy (${hoy}) ya se había enviado. Este intento no envía nada.`); return; }
  }
  const ag = gehchAgenda(D, hoy);
  const r = await fetch("https://ntfy.sh/", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
    topic: tema, title: `GEHCH · Agenda del ${hoy.split("-").reverse().join("/")}${ag.total?` (${ag.total})`:""}`,
    message: ag.texto, tags:["calendar"], click: "https://gherrerach14-dev.github.io/gehch-crm/ultimo.html" }) });
  if(!r.ok){ if(!manual) await marca.set({ fecha:"", estado:"falló", hora:new Date().toISOString() }); throw new Error("ntfy respondió "+r.status); }
  await marca.set({ fecha:hoy, estado:"enviado", hora:new Date().toISOString(), manual });
  // Recordatorios de hoy con hora: aviso a esa hora exacta (los creados en el celular ya lo traen programado)
  let programados = 0;
  for(const x of (D.recordatorios||[])){
    if(x.completado || x.fecha!==hoy || !x.hora || x.avisoProgramado) continue;
    const ts = Math.floor(Date.parse(`${x.fecha}T${x.hora}:00-04:00`)/1000);
    if(!(ts > Date.now()/1000 + 60)) continue;
    const c = (D.clientes||[]).find(k=>String(k.id)===String(x.clienteId));
    const rr = await fetch("https://ntfy.sh/", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
      topic: tema, title: `⏰ ${x.hora} · ${x.tipo||"Recordatorio"}`, message: `${x.titulo||""}${c?"\n"+`${c.nombre||""} ${c.apellido||""}`.trim()+(c.telPrincipal?" · "+c.telPrincipal:""):""}`,
      tags:["alarm_clock"], delay: String(ts), click: "https://gherrerach14-dev.github.io/gehch-crm/ultimo.html" }) });
    if(rr.ok) programados++;
  }
  console.log(`Aviso enviado: ${ag.total} punto(s) en ${ag.secciones.length} sección(es). Reembolsos leídos: ${D.rc.length}. Avisos con hora programados: ${programados}.`);
}
main().catch(e=>{ console.error("Error:", e.message); process.exit(1); });
