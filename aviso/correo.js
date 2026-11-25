// ═══ Asistente de correo GEHCH ═══════════════════════════════════════════════════════════════
// Lee (SOLO LECTURA) el correo de GEHCH por IMAP y:
//   1. Reembolsos de Just (Seguros Reservas): aprobado / rechazado / pide documentos → actualiza el
//      reclamo en el portal y avisa por ntfy con el mensaje para el cliente.
//   2. Documentos de aseguradoras (facturas, renovaciones, condiciones, listados) → aviso por ntfy.
//   3. Correos de personas sin responder hace más de 24 horas → resumen para el aviso de las 8:00
//      (y aviso inmediato si el correo es urgente).
// Nunca borra, mueve, marca ni responde correos (abre el buzón en modo lectura).
// El repositorio es público: el registro de GitHub solo muestra cantidades, nunca remitentes ni asuntos.
const VERSION = 2;
const HORAS_SIN_RESPUESTA = 24;
const DIAS_REVISION = 21;

const ASEGURADORAS = [
  [/segurosreservas\.com|banreservas\.com/, "Seguros Reservas"], [/humano\.com\.do/, "Humano"], [/lacolonial\.com\.do/, "La Colonial"],
  [/universal\.com\.do/, "Universal"], [/mapfre/, "Mapfre BHD"], [/bupa/, "Bupa"], [/bmi(icl)?\.com|bmicos/, "BMI"],
  [/generaldeseguros|lageneral/, "General de Seguros"], [/crecer/, "Seguros Crecer"], [/coopseguros/, "Coop Seguros"],
  [/onealliance|one-alliance/, "One Alliance"], [/morganwhite|mwgi/, "Morgan White"], [/multiseguros/, "Multiseguros"],
];
const AUTOMATICO = /no-?reply|noreply|donotreply|do-not-reply|mailer-daemon|postmaster|notificaci|notification|newsletter|boletin|marketing|news@|info@.*(linkedin|facebook|google)|@.*(linkedin|facebook|google|microsoft|apple|amazon|paypal|github|ntfy|cron-job)\./i;
const URGENTE = /urgente|urgencia|lo antes posible|hoy mismo|a la mayor brevedad|favor (de )?(enviar|remitir|confirmar|completar)|pendiente|vence|vencimiento|plazo|fecha l[ií]mite|cancelaci/i;
const DOC_ASEG = /factur|renovaci|condicion|listado|endoso|p[oó]liza|cotizaci|estado de cuenta|aviso de cobro|carnet/i;

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const asuntoBase = (s) => norm(s).replace(/^\s*((re|rv|fw|fwd|reenviar|respuesta|aw|tr)\s*:\s*)+/g, "").replace(/\s+/g, " ").trim();
const aseguradoraDe = (correo) => { const d = norm(correo).split("@")[1] || ""; const m = ASEGURADORAS.find(([re]) => re.test(d)); return m ? m[1] : null; };
const dd = (ms) => new Date(ms - 4 * 3600e3).toISOString().slice(0, 10).split("-").reverse().join("/");

function adjuntosDe(nodo, out = []) {
  if (!nodo) return out;
  const nom = (nodo.dispositionParameters && nodo.dispositionParameters.filename) || (nodo.parameters && nodo.parameters.name);
  if (nom && (nodo.disposition === "attachment" || /pdf|image|excel|sheet|word|octet/i.test(nodo.type || ""))) out.push(String(nom));
  (nodo.childNodes || []).forEach((c) => adjuntosDe(c, out));
  return out;
}

// Estado que informa un correo de Just – Reembolso
function avisoJust(m) {
  if (!/segurosreservas|banreservas/.test(norm(m.de))) return null;
  const t = norm(m.asunto + " " + m.texto);
  if (!/reembolso|just|atencion ambulatoria/.test(t)) return null;
  const num = (t.match(/solicitud(?: de reembolso)?\s*(?:no|num|numero|nro)?\.?\s*:?\s*(\d{5,8})/) || t.match(/bajo el (?:no|num|numero|nro)\.?\s*:?\s*(\d{5,8})/) || [])[1];
  if (!num) return { num: null, estado: null };   // otro aviso automático de Just: no es un pendiente
  if (/hemos recibido|ha sido recibida|proceso de evaluacion/.test(t) && !/aprobad|rechaz|declinad/.test(t)) return { num, estado: null };
  if (/rechazad|declinad|no procede|no cubiert|no aplica/.test(t)) return { num, estado: "Rechazado" };
  if (/aprobad/.test(t)) return { num, estado: "Aprobado" };
  if (/documento|informacion adicional|completar|requerimos|favor enviar/.test(t)) return { num, estado: "Documentos adicionales" };
  return { num, estado: null };
}

// Lee el buzón y devuelve los correos (sin tocar nada)
async function leerBuzon(client, yo) {
  const desde = new Date(Date.now() - DIAS_REVISION * 86400e3);
  const lista = await client.list();
  const enviados = lista.find((b) => b.specialUse === "\\Sent") || lista.find((b) => /(^|\.|\/)(sent|enviados?|sent items|elementos enviados)$/i.test(b.path));
  const { simpleParser } = require("mailparser");
  const entrada = [];
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  try {
    for await (const msg of client.fetch({ since: desde }, { uid: true, envelope: true, flags: true, bodyStructure: true, headers: ["list-unsubscribe", "precedence", "auto-submitted", "x-autoreply", "x-autorespond"], source: { start: 0, maxLength: 60000 } })) {
      const env = msg.envelope || {};
      const de = ((env.from || [])[0] || {});
      let texto = "";
      try { const p = await simpleParser(msg.source); texto = (p.text || "").slice(0, 4000); } catch (e) { /* correo dañado o truncado: se sigue con el asunto */ }
      const h = String(msg.headers || "");
      entrada.push({
        uid: msg.uid, id: env.messageId || `uid-${msg.uid}`, fecha: +new Date(env.date || Date.now()),
        de: norm(de.address), nombre: de.name || "", asunto: env.subject || "(sin asunto)", texto,
        para: (env.to || []).map((x) => norm(x.address)), respondido: msg.flags && msg.flags.has("\\Answered"),
        masivo: /list-unsubscribe|precedence:\s*(bulk|list|junk)|auto-submitted:\s*auto|x-autore/i.test(h),
        adjuntos: adjuntosDe(msg.bodyStructure),
      });
    }
  } finally { lock.release(); }
  const salida = [];
  if (enviados) {
    const l2 = await client.getMailboxLock(enviados.path, { readOnly: true });
    try {
      for await (const msg of client.fetch({ since: desde }, { envelope: true })) {
        const env = msg.envelope || {};
        salida.push({ fecha: +new Date(env.date || 0), para: [...(env.to || []), ...(env.cc || [])].map((x) => norm(x.address)), asunto: asuntoBase(env.subject), inReplyTo: env.inReplyTo || "" });
      }
    } finally { l2.release(); }
  }
  return { entrada, salida, hayEnviados: !!enviados };
}

// Decide qué hacer con cada correo (función pura: se prueba sin servidor)
function analizar({ entrada, salida }, yo, contactos, ahora = Date.now()) {
  const just = [], docs = [], pend = [];
  const semana = { recibidos: 0, respondidos: 0 };
  const hilos = new Map();
  entrada.sort((a, b) => a.fecha - b.fecha).forEach((m) => {
    if (!m.de || m.de === yo) return;
    const j = avisoJust(m);
    if (j) { if (j.estado) just.push({ ...j, id: m.id, fecha: m.fecha, texto: m.texto }); return; }
    const aseg = aseguradoraDe(m.de);
    if (aseg && m.adjuntos.length && (DOC_ASEG.test(m.asunto) || m.adjuntos.some((a) => DOC_ASEG.test(a)))) docs.push({ id: m.id, aseg, asunto: m.asunto, adjuntos: m.adjuntos, fecha: m.fecha });
    if (m.masivo || AUTOMATICO.test(m.de)) return;
    if (m.para.length && !m.para.includes(yo)) return;                 // solo copiado (CC): no se cuenta como pendiente suyo
    hilos.set(m.de + "|" + asuntoBase(m.asunto), m);                     // del mismo hilo queda el más reciente
  });
  for (const m of hilos.values()) {
    const base = asuntoBase(m.asunto);
    const resp = m.respondido || salida.some((s) => s.fecha > m.fecha && (s.inReplyTo === m.id || (s.para.includes(m.de) && (s.asunto === base || (base.length > 8 && (s.asunto.includes(base) || base.includes(s.asunto)))))));
    if (ahora - m.fecha <= 7 * 86400e3) { semana.recibidos++; if (resp) semana.respondidos++; }
    if (resp) continue;
    const horas = (ahora - m.fecha) / 3600e3;
    if (horas < HORAS_SIN_RESPUESTA) continue;
    const c = contactos[m.de];
    const aseg = aseguradoraDe(m.de);
    pend.push({ id: m.id, correo: m.de, nombre: c || m.nombre || m.de, asunto: m.asunto, dias: Math.floor(horas / 24), cat: c ? "cliente" : aseg ? "aseguradora" : "otro", aseg, urgente: URGENTE.test(m.asunto + " " + m.texto.slice(0, 1500)), fecha: m.fecha });
  }
  pend.sort((a, b) => (b.urgente - a.urgente) || (a.fecha - b.fecha));
  return { just, docs, pend, semana };
}

async function ntfy(tema, titulo, mensaje, extra = {}) {
  try { const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: tema, title: titulo, message: mensaje, click: "https://gherrerach14-dev.github.io/gehch-crm/ultimo.html", ...extra }) }); return r.ok; } catch (e) { console.log("ntfy falló:", e.message); return false; }
}

async function main() {
  const usuario = process.env.CORREO_USUARIO, clave = process.env.CORREO_CLAVE;
  if (!usuario || !clave) { console.log("Asistente de correo: no hay secretos CORREO_USUARIO / CORREO_CLAVE; no hace nada."); return; }
  const servidor = process.env.CORREO_SERVIDOR || "mail." + usuario.split("@")[1];
  const admin = require("firebase-admin");
  const crm = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CRM)) }, "crm").firestore();
  const rc = process.env.FIREBASE_RECLAMOS ? admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_RECLAMOS)) }, "rc").firestore() : null;
  const leer = async (k, def) => { const s = await crm.collection("gehch").doc(k).get(); return s.exists ? JSON.parse(s.data().data) : def; };
  const config = await leer("gehch2:config", {}); const tema = process.env.NTFY_TEMA || config.ntfyTema;
  const clientes = await leer("gehch2:clientes", []); const contactosCRM = await leer("gehch2:contactos", []);
  const contactos = {};
  clientes.forEach((c) => { const e = norm(c.email).trim(); if (e.includes("@")) contactos[e] = `${c.nombre || ""} ${c.apellido || ""}`.replace(/\s+/g, " ").trim(); });
  contactosCRM.forEach((c) => { const e = norm(c.email || c.correo).trim(); if (e.includes("@") && !contactos[e]) contactos[e] = String(c.nombre || e).trim(); });

  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({ host: servidor, port: Number(process.env.CORREO_PUERTO || 993), secure: !process.env.CORREO_SIN_TLS, doSTARTTLS: process.env.CORREO_SIN_TLS ? false : undefined, auth: { user: usuario, pass: clave }, logger: false });
  let buzon;
  try { await client.connect(); buzon = await leerBuzon(client, norm(usuario)); }
  catch (e) {
    // Motivo en palabras simples (sin datos de la cuenta: el registro de GitHub es público)
    const txt = String(e.responseText || e.message || ""), code = String(e.code || (e.cause && e.cause.code) || "");
    let motivo;
    if (e.authenticationFailed || /authenticat|login|credential|password|LOGIN/i.test(txt)) motivo = "el servidor rechazó el usuario o la contraseña. Revise que CORREO_USUARIO sea el correo completo y que CORREO_CLAVE sea la misma contraseña del webmail";
    else if (/ENOTFOUND|EAI_AGAIN/.test(code + txt)) motivo = `no existe el servidor «${servidor}». Hay que poner el nombre correcto en la variable CORREO_SERVIDOR`;
    else if (/CERT|certificate|altnames|self.signed|SSL|TLS/i.test(code + txt)) {
      let cn = ""; try { const tls = require("tls"); cn = await new Promise((ok) => { const s = tls.connect({ host: servidor, port: 993, rejectUnauthorized: false, servername: servidor }, () => { const c = s.getPeerCertificate() || {}; ok((c.subject && c.subject.CN) || ""); s.end(); }); s.on("error", () => ok("")); setTimeout(() => ok(""), 8000); }); } catch (x) { }
      motivo = `el certificado de seguridad del servidor no es para «${servidor}»${cn ? `; el servidor se llama «${cn}»: hay que ponerlo en la variable CORREO_SERVIDOR` : ""}`;
    }
    else if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|timeout/i.test(code + txt)) motivo = `el servidor «${servidor}» no acepta la conexión desde GitHub por el puerto 993 (puede estar bloqueado por el hosting)`;
    else motivo = `error del servidor (${(code || txt).slice(0, 80)})`;
    const est = await crm.collection("gehch").doc("correoEstado").get(); const ya = est.exists ? est.data() : {};
    if (ya.errorMotivo !== motivo) await ntfy(tema, "📧 No pude leer el correo de GEHCH", `El asistente de correo no pudo entrar al buzón: ${motivo}.\n\nLo vuelve a intentar solo cada 15 minutos; no le aviso de nuevo hasta que cambie el motivo.`, { tags: ["warning"] });
    await crm.collection("gehch").doc("correoEstado").set({ errorAvisado: true, errorMotivo: motivo, error: txt.slice(0, 200) }, { merge: true });
    console.log("Asistente de correo: no pudo entrar al buzón. Motivo: " + motivo.replace(servidor, "[servidor]") + ". Se intenta de nuevo en la próxima corrida.");
    return;   // sin marcar la corrida como fallida: así GitHub no manda un correo de error cada 15 minutos
  } finally { try { await client.logout(); } catch (e) { } }

  const est = crm.collection("gehch").doc("correoEstado");
  const E = (await est.get()).data() || {};
  const avisados = E.avisados || {};
  const primeraVez = !E.fecha;   // la primera vez solo toma nota de documentos y urgentes viejos: no avisa todo de golpe
  const { just, docs, pend, semana } = analizar(buzon, norm(usuario), contactos);
  let nJust = 0, nDocs = 0, nUrg = 0;

  // 1. Reembolsos de Just
  if (rc && just.length) {
    const snap = await rc.collectionGroup("reclamos").get();
    for (const j of just) {
      const clave = `just:${j.num}:${j.estado}`; if (avisados[clave]) continue;
      const d = snap.docs.find((x) => String((x.data().liquidacion || {}).numeroAseg || "") === j.num);
      if (!d) { avisados[clave] = Date.now(); continue; }   // solicitud que no vino del portal: no se toca
      const r = d.data();
      // Solo avanza: nunca devuelve un reclamo aprobado/rechazado/pagado a un estado anterior
      const DESDE = { "Aprobado": ["Recibido", "Enviado a aseguradora", "Documentos adicionales"], "Rechazado": ["Recibido", "Enviado a aseguradora", "Documentos adicionales", "Aprobado"], "Documentos adicionales": ["Recibido", "Enviado a aseguradora"] };
      if (!(DESDE[j.estado] || []).includes(r.estado)) { avisados[clave] = Date.now(); continue; }
      const nota = `Aviso de Just – Reembolso recibido por correo el ${dd(j.fecha)} (solicitud No. ${j.num}).`;
      const cambio = { estado: j.estado, actualizado: Date.now(), historial: admin.firestore.FieldValue.arrayUnion({ estado: j.estado, nota, fecha: Date.now() }) };
      if (j.estado === "Documentos adicionales") cambio.origenDocs = "aseguradora";
      await d.ref.update(cambio); r.estado = j.estado;
      const cli = clientes.find((c) => String(c.id) === String(r.crmId));
      const nom = ((cli && cli.nombre) || r.clienteNombre || "").trim().split(/\s+/)[0] || "";
      const pac = (r.paciente && r.paciente.nombre) || "";
      const detalle = j.texto.replace(/\s+/g, " ").slice(0, 400);
      let titulo, msg, tags = ["envelope"], prio = 3;
      if (j.estado === "Aprobado") { titulo = `✅ Reservas aprobó el reembolso No. ${j.num}`; msg = `${r.clienteNombre || ""} · paciente ${pac}\nYa quedó «Aprobado» en el CRM y en el portal.\n\nMensaje para el cliente (WhatsApp):\nHola, ${nom}. Le informamos que Seguros Reservas aprobó su reembolso No. ${j.num}. Ya están gestionando el pago, que normalmente llega a su cuenta en 24 a 48 horas laborables. Cualquier duda, estamos a la orden.`; }
      else if (j.estado === "Rechazado") { titulo = `❌ Reservas rechazó el reembolso No. ${j.num}`; msg = `${r.clienteNombre || ""} · paciente ${pac}\nQuedó «Rechazado» en el CRM. Revise el motivo antes de avisar al cliente:\n\n${detalle}`; prio = 4; }
      else { titulo = `📎 Reservas pide documentos · reembolso No. ${j.num}`; msg = `${r.clienteNombre || ""} · paciente ${pac}\nQuedó «Solicitado por aseguradora» en el CRM. Lo que piden:\n\n${detalle}`; prio = 4; }
      if (await ntfy(tema, titulo, msg, { tags, priority: prio })) { avisados[clave] = Date.now(); nJust++; }
    }
  }
  // 2. Documentos de aseguradoras
  for (const x of docs) {
    const clave = "doc:" + x.id; if (avisados[clave]) continue;
    if (primeraVez || Date.now() - x.fecha > 3 * 86400e3) { avisados[clave] = Date.now(); continue; }   // la primera vez no avisa de lo viejo
    if (await ntfy(tema, `📄 ${x.aseg} envió documentos`, `${x.asunto}\nAdjuntos: ${x.adjuntos.slice(0, 4).join(", ")}${x.adjuntos.length > 4 ? "…" : ""}\n\nPáselos a Claude para cargarlos al CRM.`, { tags: ["page_facing_up"] })) { avisados[clave] = Date.now(); nDocs++; }
  }
  // 3. Urgentes sin responder: aviso inmediato (una sola vez por correo)
  for (const p of pend.filter((p) => p.urgente)) {
    const clave = "urg:" + p.id; if (avisados[clave]) continue;
    if (primeraVez || p.dias > 3) { avisados[clave] = Date.now(); continue; }
    if (await ntfy(tema, `📧 Sin responder (${p.dias} día${p.dias === 1 ? "" : "s"}): ${p.nombre}`, `${p.asunto}\n${p.cat === "cliente" ? "Cliente del CRM" : p.aseg || p.correo}\n\nParece urgente y aún no lo ha respondido.`, { tags: ["envelope"], priority: 4 })) { avisados[clave] = Date.now(); nUrg++; }
  }
  // Limpia avisos de más de 60 días y guarda el resumen para el aviso de las 8:00
  Object.keys(avisados).forEach((k) => { if (Date.now() - avisados[k] > 60 * 86400e3) delete avisados[k]; });
  await est.set({ version: VERSION, fecha: Date.now(), avisados, errorAvisado: false, errorMotivo: null, error: null, hayEnviados: buzon.hayEnviados,
    resumen: { fecha: Date.now(), semana, pendientes: pend.slice(0, 40).map(({ id, texto, ...p }) => p) } });
  console.log(`Correo revisado: ${buzon.entrada.length} recibidos, ${buzon.salida.length} enviados (${DIAS_REVISION} días). Sin responder: ${pend.length}. Avisos: ${nJust} de Just, ${nDocs} de documentos, ${nUrg} urgentes.`);
}

module.exports = { leerBuzon, analizar, avisoJust, asuntoBase, aseguradoraDe, adjuntosDe };
if (require.main === module) main().catch((e) => { console.error("Error del asistente de correo:", e.message.replace(/[\w.+-]+@[\w.-]+/g, "[correo]")); process.exit(1); });
