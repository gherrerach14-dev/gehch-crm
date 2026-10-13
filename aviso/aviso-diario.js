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

  // 🔄 Renovaciones: a los 30, 15 y 5 días, el día del vencimiento y vencidas sin gestionar (hasta 60 días)
  (D.polizas||[]).filter(vigente).map(p=>({p,d:dias(p.fin)})).filter(x=>x.d!==null).sort((a,b)=>a.d-b.d).forEach(({p,d})=>{
    const t = `${nomC(cliente(p.clienteId))} · ${p.ramo||""} · ${p.aseguradora||"—"} · ${p.numero}`;
    if(d===30||d===15||d===5) L.ren.push({k:`ren:${p.id}:${p.fin}:${d}`, cid:p.clienteId, t:`En ${d} días (${f(p.fin)}): ${t}`});
    else if(d===0) L.ren.push({k:`ren:${p.id}:${p.fin}:0`, cid:p.clienteId, t:`VENCE HOY: ${t}`});
    else if(d<0 && d>=-60) L.ren.push({k:`ren:${p.id}:${p.fin}:vencida`, cid:p.clienteId, t:`Venció hace ${-d}d sin renovar: ${t}`});
  });

  // 📅 Seguimientos con fecha: recordatorios, contactos, gestiones de renovación y promesas de pago
  const seg = [];
  (D.recordatorios||[]).forEach(r=>{ if(r.completado) return; const d=dias(r.fecha); if(d===null||d>0) return; const c=cliente(r.clienteId); seg.push({d, k:`rec:${r.id}:${r.fecha}`, recId:r.id, cid:r.clienteId, t:`${cuando(d)}: ${r.hora?r.hora+" · ":""}${r.tipo?r.tipo+": ":""}${r.titulo||"Recordatorio"}${c?" — "+nomC(c):""}${r.nota?" · "+corto(r.nota):""}`}); });
  (D.contactos||[]).forEach(x=>{ const d=dias(x.fechaProxima); if(d!==0) return; seg.push({d, k:`cont:${x.id}:${x.fechaProxima}`, cid:x.clienteId, t:`Hoy: ${x.proximaAccion||"Seguimiento"} — ${nomC(cliente(x.clienteId))}`}); });
  (D.gestionesRenov||[]).forEach(g=>{ const p=poliza(g.polizaId); if(!vigente(p)) return; if(/^(renovada|no renovada)$/i.test(String(g.estado||"").trim())) return; const d=dias(g.fechaProxima); if(d===null||d>0||d<-60) return; seg.push({d, k:`gren:${g.polizaId}:${g.fechaProxima}`, cid:p.clienteId, t:`${cuando(d)}: renovación ${nomC(cliente(p.clienteId))} · ${p.numero} (${g.estado||"en gestión"})${g.nota?" · "+corto(g.nota):""}`}); });
  (D.gestionesCxC||[]).forEach(g=>{ const cu=(D.planes||[]).find(x=>String(x.id)===String(g.cuotaId)); if(!cu||cu.estado==="Pagado") return; const p=poliza(cu.polizaId); if(!p) return; const d=dias(g.promesaPago); if(d===null||d>0||d<-60) return; seg.push({d, k:`gcxc:${g.cuotaId}:${g.promesaPago}`, cid:p.clienteId, t:`${cuando(d)}: promesa de pago ${nomC(cliente(p.clienteId))} · ${p.numero} · ${mon(cu.monto,p.moneda)}`}); });
  L.seg = seg.sort((a,b)=>b.d-a.d).map(({d,...x})=>x);

  // 💰 Cuotas: 5 días antes y el día del vencimiento; las vencidas, en una sola línea
  let vencN = 0; const vencT = {};
  (D.planes||[]).forEach(cu=>{
    if(cu.estado==="Pagado") return; const p=poliza(cu.polizaId); if(!vigente(p)) return; const d=dias(cu.fecha); if(d===null) return;
    if(d===5||d===0) L.cuo.push({k:`cuo:${cu.id}:${cu.fecha}:${d}`, cid:p.clienteId, t:`${d===0?"Vence hoy":"En 5 días"}: ${nomC(cliente(p.clienteId))} · ${p.numero} · ${cu.facturaNumero?`factura ${cu.facturaNumero} pago ${cu.numero}/${cu.total}`:`cuota ${cu.numero}/${cu.total}`} · ${mon(cu.monto,p.moneda)}`});
    else if(d<0){ vencN++; vencT[p.moneda]=(vencT[p.moneda]||0)+Number(cu.monto||0); }
  });
  // 🧾 Pólizas declarativas: toca declarar cuando pasa el período sin factura nueva
  const masMeses = (iso,n) => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||"")); if(!m) return null; const t=new Date(Date.UTC(+m[1],+m[2]-1+n,1)); const dim=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate(); return t.getUTCFullYear()+"-"+String(t.getUTCMonth()+1).padStart(2,"0")+"-"+String(Math.min(+m[3],dim)).padStart(2,"0"); };
  (D.polizas||[]).filter(p=>vigente(p) && p.declarativa).forEach(p=>{
    const ult = (p.facturas||[]).map(x=>x.hasta).filter(Boolean).sort().pop();
    const ref = ult || p.inicio; if(!ref || (p.fin && ref>=p.fin)) return;
    let esp = masMeses(ref, Number(p.periodoDecl||3)); if(!esp) return; if(p.fin && esp>p.fin) esp = p.fin;
    const d = dias(esp); if(d===null || d>0) return;
    L.cuo.push({k:`decl:${p.id}:${esp}`, cid:p.clienteId, t:`Declaración pendiente: ${nomC(cliente(p.clienteId))} · ${p.numero} · ${ult?"última hasta "+f(ult):"sin facturas registradas"} (declara cada ${p.periodoDecl||3} meses)`});
  });
  if(vencN) L.cuo.push({k:`cuo:vencidas:${vencN}`, t:`Cuotas vencidas sin pagar: ${vencN} (${Object.entries(vencT).map(([m,v])=>mon(v,m)).join(" + ")})`});

  // 🚗 Reclamaciones abiertas en el CRM
  (D.reclamos||[]).forEach(r=>{ if(r.estado==="Cerrado") return; const c=cliente(r.clienteId); const pend=Object.values(r.checklist||{}).filter(v=>v&&!v.completado).length; const d=dias(r.fechaApertura);
    L.recl.push({k:`recl:${r.id}:${r.estado}`, cid:r.clienteId, t:`${nomC(c)} · reclamo ${r.numeroReclamo||"s/n"} · ${r.estado}${d!==null?" · "+(-d)+" días abierto":""}${pend?" · "+pend+" documento(s) pendiente(s)":""}`}); });

  // 🩺 Reembolsos del portal
  const PLAZOS = { "Seguros Reservas": { Local: 90, Extranjero: 180 } };
  let enTramite = 0; const port = L.port;
  (D.rc||[]).forEach(r=>{
    const ui = r.estado==="Documentos adicionales" ? (r.origenDocs==="aseguradora" ? "Solicitado por aseguradora" : "Incompleto") : r.estado;
    const quien = `${r.clienteNombre||""}${r.paciente&&r.paciente.nombre?" / "+r.paciente.nombre:""}`;
    const cerrado = r.estado==="Pagado" || r.estado==="Rechazado";
    if(!cerrado) enTramite++;
    if(r.estado==="Recibido" && !r.visto) port.push({k:`rc:${r.key||""}/${r.id}:nuevo`, t:`NUEVO ${r.id}: ${quien}`});
    if(r.estado==="Documentos adicionales" && r.adicionalesEnviados && !r.adicionalesVistos) port.push({k:`rc:${r.key||""}/${r.id}:docs:${r.adicionalesEnviados}`, t:`Documentos recibidos ${r.id}: ${quien}`});
    if(r.estado==="Aprobado"){ const hist=(r.historial||[]).filter(h=>h.estado==="Aprobado").map(h=>h.fecha); const ms=r.aprobadoMs||(hist.length?Math.max(...hist):null); if(ms){ const iso=new Date(ms-4*3600000).toISOString().slice(0,10); const dd=dias(iso); if(dd!==null && dd<=-2) port.push({k:`rc:${r.key||""}/${r.id}:aprobado`, t:`Aprobado hace ${-dd} días sin confirmar el pago ${r.id}: ${quien}`}); } }
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
