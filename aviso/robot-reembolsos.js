// ── Robot de reembolsos · Seguros Reservas (Just – Reembolso) ──
// Toma los reclamos de salud que los clientes envían por el portal de GEHCH (estado «Recibido», aseguradora Seguros Reservas),
// los somete en https://app.segurosreservas.com/RefundJust con la cédula del titular, guarda el número de solicitud
// en el portal (estado «Enviado a aseguradora») y avisa a Guillermo al celular con el mensaje para el cliente.
//
// Modos (variable MODO):
//   prueba → llena todo, toma una foto y NO envía. Es lo que hace «Run workflow» por defecto.
//   real   → envía. Las corridas automáticas solo envían si en GitHub la variable ROBOT_MODO = real.
//   (cualquier otro valor) → no hace nada.
// Seguridad: si algo no cuadra NO envía nada a medias: anota el motivo en el reclamo y avisa.
// Nunca reintenta un envío dudoso (para no duplicar solicitudes en Reservas).
// No imprime datos de clientes en el registro de GitHub: solo cantidades y códigos.

const admin = require("firebase-admin");
const { chromium } = require("playwright");

const VERSION = 3;   // si el robot se corrige, los reclamos que fallaron con una versión anterior se reintentan solos
const MODO = String(process.env.MODO || "").trim().toLowerCase();
const URL_JUST = process.env.JUST_URL || "https://app.segurosreservas.com/RefundJust/home/index?idnumber=";
const MAX_ARCHIVO = 5 * 1024 * 1024, MAX_TOTAL = 25 * 1024 * 1024;
const SOLO = String(process.env.SOLO_RECLAMO || "").trim();   // opcional: probar un solo reclamo por su id
// Solo reclamos creados desde esta fecha: los anteriores pudieron haberse sometido a mano y no deben duplicarse
const DESDE = Date.parse((process.env.ROBOT_DESDE || "2026-11-23") + "T00:00:00-04:00");

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const dig = (s) => String(s || "").replace(/\D/g, "");
const tokens = (s) => norm(s).split(" ").filter(t => t.length > 1 && !["DE", "DEL", "LA", "LOS", "LAS", "Y"].includes(t));
const mon = (n, m) => (m === "USD" ? "US$ " : "RD$ ") + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fF = (s) => String(s || "").slice(0, 10).split("-").reverse().join("/");

class Alto extends Error {}   // motivo claro para no enviar

async function ntfy(tema, titulo, mensaje, extra = {}) {
  try { await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: tema, title: titulo, message: mensaje, click: "https://gherrerach14-dev.github.io/gehch-crm/ultimo.html", ...extra }) }); } catch (e) { console.log("ntfy falló:", e.message); }
}
async function ntfyFoto(tema, nombre, png) {
  try { await fetch("https://ntfy.sh/" + tema, { method: "PUT", headers: { "Filename": nombre }, body: png }); } catch (e) { console.log("ntfy foto falló:", e.message); }
}

// El paciente del portal → la opción de Reservas con más palabras en común (debe ser clara, si no, se detiene)
function elegirPaciente(nombre, opciones) {
  const A = new Set(tokens(nombre)); if (!A.size) return null;
  const pts = opciones.map(o => { const B = new Set(tokens(o)); const inter = [...A].filter(t => B.has(t)).length; return { o, inter, sc: inter / Math.max(1, Math.min(A.size, B.size)) }; })
    .filter(x => x.inter >= 2 && x.sc >= 0.6).sort((a, b) => b.sc - a.sc || b.inter - a.inter);
  if (!pts.length) return null;
  if (pts.length > 1 && pts[1].sc === pts[0].sc && pts[1].inter === pts[0].inter) return null;   // empate: ambiguo
  return pts[0].o;
}
const elegirTexto = (txt, opciones) => { const t = norm(txt); return opciones.find(o => norm(o) === t) || opciones.find(o => norm(o).startsWith(t) || t.startsWith(norm(o))) || null; };

async function opcionesDe(page, sel) { return page.$$eval(`${sel} option`, os => os.map(o => ({ v: o.value, t: (o.textContent || "").trim() })).filter(o => o.v && o.v !== "value" && o.t && !/^seleccionar/i.test(o.t))); }
async function esperarOpciones(page, sel, ms = 20000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const o = await opcionesDe(page, sel); if (o.length) return o; await page.waitForTimeout(400); }
  return [];
}
async function elegir(page, sel, valor) { await page.selectOption(sel, valor); await page.dispatchEvent(sel, "change"); await page.waitForTimeout(700); }

// Documentos del reclamo (el portal los guarda en trozos de texto base64)
async function archivosDe(ref) {
  const s = await ref.collection("archivos").get(); const out = [];
  for (const d of s.docs) {
    const a = d.data(); let data = a.data || "";
    for (let i = 1; i < (a.partes || 1); i++) { const p = await d.ref.collection("partes").doc(String(i)).get(); if (!p.exists) throw new Alto(`falta una parte del documento «${a.nombre || d.id}» (el cliente debe volver a subirlo)`); data += p.data().data || ""; }
    // El portal guarda el contenido en base64 puro (sin el prefijo «data:»); se aceptan ambas formas
    const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(data);
    const b64 = (m ? m[2] : data).replace(/\s/g, "");
    const buffer = Buffer.from(b64, "base64");
    const firma = buffer.slice(0, 4).toString("binary");
    const valido = buffer.length > 100 && (firma.startsWith("%PDF") || (buffer[0] === 0xFF && buffer[1] === 0xD8) || firma.startsWith("\x89PNG") || firma.startsWith("GIF8"));
    if (!valido) throw new Alto(`el documento «${a.nombre || d.id}» no se pudo leer (el cliente debe volver a subirlo)`);
    const mime = a.mime || (m && m[1]) || (firma.startsWith("%PDF") ? "application/pdf" : "image/jpeg");
    let nombre = String(a.nombre || d.id).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, "_"); const ext = mime.includes("pdf") ? ".pdf" : mime.includes("png") ? ".png" : ".jpg";
    if (!/\.[a-z0-9]{2,4}$/i.test(nombre)) nombre += ext;
    out.push({ name: `${d.id}-${nombre}`.slice(0, 90), mimeType: mime, buffer, procIdx: a.procIdx, tipoDoc: a.tipoDoc });
  }
  return out.sort((x, y) => String(x.name).localeCompare(String(y.name)));
}

// Foto y estado de los campos cuando algo falla (para corregir sin adivinar)
async function diagnostico(page) {
  const foto = await page.screenshot({ fullPage: true }).catch(() => null);
  const estado = await page.evaluate(() => {
    const q = (s) => document.querySelector(s); const v = (s) => q(s) ? `${q(s).disabled ? "🔒" : "✏️"}${q(s).value ? "=" + String(q(s).value).slice(0, 25) : ""}` : "—";
    return `Campos: póliza ${v("#policy-affected")} · origen ${v("#original-location-list")} · paciente ${v("#customer-affected") ? "✓" : "—"} · proc ${v("#medical-treatment-list")} · fecha ${v("#date-service")} · monto ${v("#cost")} · pago ${v("#pay-method-list")} · banco ${v("#bank-list")}\nServicios añadidos: ${q("#card-container") ? q("#card-container").children.length + " → " + q("#card-container").innerText.replace(/\s+/g, " ").slice(0, 200) : "—"}`;
  }).catch(() => "");
  return { foto, estado };
}

async function someter(browser, rec, cedula, archivos, real, antesDeEnviar) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "es-DO", timezoneId: "America/Santo_Domingo" });
  const page = await ctx.newPage(); const alertas = []; page.setDefaultTimeout(15000);
  if (process.env.DEBUG) { page.on("pageerror", e => console.log("  PAGEERROR", e.message)); page.on("console", m => console.log("  CONSOLE", m.text())); }
  const t0 = Date.now(); const paso = (t) => { if (process.env.DEBUG) console.log("  ·", t, Math.round((Date.now() - t0) / 1000) + "s"); };
  page.on("dialog", async d => { alertas.push(d.message()); await d.accept().catch(() => {}); });
  try {
    await page.goto(URL_JUST + cedula, { waitUntil: "networkidle", timeout: 60000 });
    paso("póliza"); // 1. Póliza
    const pols = await esperarOpciones(page, "#policy-affected");
    if (!pols.length) throw new Alto("Just – Reembolso no mostró pólizas para la cédula del titular (¿cédula incorrecta o Reservas bloqueó el acceso?)");
    const pol = pols.find(o => dig(o.v) === dig(rec.poliza && rec.poliza.numero));
    if (!pol) throw new Alto(`la póliza ${rec.poliza && rec.poliza.numero} no aparece en Just – Reembolso (Reservas muestra: ${pols.map(o => o.t).join(", ")})`);
    await elegir(page, "#policy-affected", pol.v);
    paso("origen"); // 2. Origen
    const origen = rec.origen === "Extranjero" ? "Extranjero" : "Local";
    await elegir(page, "#original-location-list", origen);
    paso("paciente"); // 3. Paciente
    const pacs = await esperarOpciones(page, "#customer-affected");
    const pac = elegirPaciente(rec.paciente && rec.paciente.nombre, pacs.map(o => o.t));
    if (!pac) throw new Alto(`no encontré con seguridad al paciente «${rec.paciente && rec.paciente.nombre}» en la lista de Reservas (${pacs.map(o => o.t).join(" · ")}). Corrija el nombre del asegurado en el portal.`);
    await elegir(page, "#customer-affected", pacs.find(o => o.t === pac).v);
    paso("procedimientos"); // 4. Procedimientos (uno por factura)
    const procs = rec.procedimientos || [];
    if (!procs.length) throw new Alto("el reclamo no tiene servicios");
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      const tr = await esperarOpciones(page, "#medical-treatment-list");
      if (!tr.length) throw new Alto("Reservas no cargó la lista de procedimientos");
      const t = elegirTexto(p.tipo, tr.map(o => o.t)); if (!t) throw new Alto(`el servicio «${p.tipo}» no existe en la lista de Reservas (${tr.map(o => o.t).join(", ")})`);
      await elegir(page, "#medical-treatment-list", tr.find(o => o.t === t).v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || ""))) throw new Alto(`el servicio ${i + 1} no tiene fecha válida`);
      await page.fill("#date-service", p.fecha); await page.dispatchEvent("#date-service", "change");
      const chk = p.moneda === "USD" ? "#usd-currency" : "#dop-currency", otro = p.moneda === "USD" ? "#dop-currency" : "#usd-currency";
      if (await page.isChecked(otro)) await page.uncheck(otro, { force: true });
      if (!(await page.isChecked(chk))) await page.check(chk, { force: true });
      await page.waitForFunction(() => !document.querySelector("#cost").disabled, null, { timeout: 10000 }).catch(() => {});
      const monto = Number(p.monto); if (!(monto > 0)) throw new Alto(`el servicio ${i + 1} no tiene monto`);
      await page.fill("#cost", monto.toFixed(2));
      const antes = await page.$$eval("#card-container > *", e => e.length);
      const nAl = alertas.length;
      await page.$eval(".btn-add", b => b.click());
      await page.waitForFunction(n => document.querySelectorAll("#card-container > *").length > n, antes, { timeout: 10000 }).catch(() => {});
      const despues = await page.$$eval("#card-container > *", e => e.length);
      if (despues <= antes) throw new Alto(`Reservas no aceptó el servicio ${i + 1} (${p.tipo}, ${fF(p.fecha)}, ${mon(monto, p.moneda)})${alertas.length > nAl ? ": " + alertas.slice(nAl).join(" ") : ""}`);
    }
    paso("pago"); // 5. Forma de pago
    const P = rec.pago || {};
    await page.waitForFunction(() => !document.querySelector("#pay-method-list").disabled, null, { timeout: 10000 }).catch(() => {});
    if (await page.$eval("#pay-method-list", e => e.disabled)) {
      if (real && !process.env.FORZAR) throw new Alto("después de añadir los servicios, Reservas no habilitó «Forma de pago». No se envió nada; se necesita revisar el formulario (corra el robot en modo prueba con este reclamo para ver la foto)");
      await page.$eval("#pay-method-list", e => { e.disabled = false; });   // prueba: se desbloquea para ver el resto del formulario
    }
    if (P.forma === "Cheque") await elegir(page, "#pay-method-list", "Cheque");
    else {
      await elegir(page, "#pay-method-list", "Depósito");
      const bancos = await esperarOpciones(page, "#bank-list");
      if (!bancos.length) throw new Alto("Reservas no cargó la lista de bancos");
      if (P.cuentaRegistrada) {
        // Cuenta ya registrada en Reservas: se busca banco por banco; si hay más de una cuenta, no se adivina
        const halladas = [];
        for (const b of bancos) { await elegir(page, "#bank-list", b.v); const cs = await opcionesDe(page, "#registered-accounts"); cs.forEach(c => halladas.push({ b, c })); }
        if (!halladas.length) throw new Alto("el cliente marcó «cuenta registrada», pero Reservas no muestra ninguna cuenta guardada para el titular");
        if (halladas.length > 1) throw new Alto(`el titular tiene ${halladas.length} cuentas registradas en Reservas; elija una a mano`);
        await elegir(page, "#bank-list", halladas[0].b.v); await elegir(page, "#registered-accounts", halladas[0].c.v);
      } else {
        const b = elegirTexto(P.banco, bancos.map(o => o.t)) || bancos.find(o => tokens(P.banco).every(t => norm(o.t).includes(t)))?.t;
        if (!b) throw new Alto(`el banco «${P.banco}» no está en la lista de Reservas`);
        await elegir(page, "#bank-list", bancos.find(o => o.t === b).v);
        if (!(await page.isChecked("#other-account"))) await page.check("#other-account", { force: true });
        await page.waitForTimeout(500);
        if (dig(P.numero).length < 6) throw new Alto("falta el número de cuenta del cliente");
        await page.fill("#account-number", dig(P.numero));
        const tipos = await esperarOpciones(page, "#account-type-list", 8000);
        const tp = tipos.find(o => norm(o.t).includes(norm(P.tipoCuenta || "Ahorro").slice(0, 5))); if (!tp) throw new Alto(`el tipo de cuenta «${P.tipoCuenta}» no está en la lista de Reservas`);
        await elegir(page, "#account-type-list", tp.v);
        const mons = await esperarOpciones(page, "#currency-type-list", 8000);
        const quiere = /d[oó]lar/i.test(P.monedaCuenta || "") ? "DOL" : "PES";
        const mc = mons.find(o => norm(o.t).startsWith(quiere)) || mons.find(o => norm(o.t).includes(quiere === "DOL" ? "US" : "DOP"));
        if (mons.length && !mc) throw new Alto(`la moneda de cuenta «${P.monedaCuenta}» no está en la lista de Reservas`);
        if (mc) await elegir(page, "#currency-type-list", mc.v);
      }
    }
    paso("documentos"); // 6. Documentos
    if (!archivos.length) throw new Alto("el reclamo no tiene documentos");
    const grande = archivos.find(a => a.buffer.length > MAX_ARCHIVO); if (grande) throw new Alto(`un documento pesa más de 5 MB (${(grande.buffer.length / 1048576).toFixed(1)} MB), el límite de Reservas`);
    const total = archivos.reduce((s, a) => s + a.buffer.length, 0); if (total > MAX_TOTAL) throw new Alto(`los documentos suman ${(total / 1048576).toFixed(1)} MB y Reservas acepta hasta 25 MB`);
    await page.setInputFiles("input.dz-hidden-input", archivos.map(a => ({ name: a.name, mimeType: a.mimeType, buffer: a.buffer })));
    await page.waitForTimeout(3000 + archivos.length * 800);
    const foto = await page.screenshot({ fullPage: true });
    if (!real) return { prueba: true, foto, estado: (await diagnostico(page)).estado };
    paso("enviar"); // 7. Enviar y leer el número de solicitud
    const nAl = alertas.length;
    await antesDeEnviar();   // queda anotado ANTES de pulsar: si algo se corta después, nunca se reintenta (no duplicar)
    await page.$eval("#send-data", b => b.click());   // clic directo al botón (sin depender de su posición en pantalla)
    let numero = null; const fin = Date.now() + 120000;
    while (Date.now() < fin && !numero) {
      const txt = (await page.evaluate(() => document.body.innerText).catch(() => "")) + " " + alertas.slice(nAl).join(" ");
      const m = /bajo el n[oº°]\.?\s*(\d{3,})/i.exec(txt); if (m) numero = m[1];
      else await page.waitForTimeout(1500);
    }
    const foto2 = await page.screenshot({ fullPage: false });
    if (!numero) return { dudoso: true, foto: foto2, motivo: alertas.slice(nAl).join(" ") || "no apareció la confirmación con el número de solicitud" };
    return { numero, foto: foto2 };
  } catch (e) { const dg = await diagnostico(page); e.foto = dg.foto; e.estado = dg.estado; throw e; }
  finally { await ctx.close().catch(() => {}); }
}

async function main() {
  if (!["prueba", "real"].includes(MODO)) { console.log(`Robot en pausa (MODO=${MODO || "vacío"}). Para activarlo: en GitHub, Settings → Variables → ROBOT_MODO = real.`); return; }
  if (!process.env.FIREBASE_CRM || !process.env.FIREBASE_RECLAMOS) throw new Error("Faltan los secretos FIREBASE_CRM o FIREBASE_RECLAMOS");
  const crm = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CRM)) }, "crm").firestore();
  const rc = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_RECLAMOS)) }, "rc").firestore();
  const leer = async (k, def) => { const s = await crm.collection("gehch").doc(k).get(); return s.exists ? JSON.parse(s.data().data) : def; };
  const config = await leer("gehch2:config", {}); const tema = process.env.NTFY_TEMA || config.ntfyTema;
  const clientes = await leer("gehch2:clientes", []);

  const snap = await rc.collectionGroup("reclamos").get();
  const cand = snap.docs.filter(d => {
    const r = d.data(); if (SOLO && d.id !== SOLO) return false;
    if (r.estado !== "Recibido" || !/reservas/i.test(String(r.poliza && r.poliza.aseguradora || ""))) return false;
    if (MODO === "real" && !(Number(r.creadoMs || 0) >= DESDE) && !SOLO) return false;
    if (MODO === "real" && /\bprueba\b/i.test(String(r.comentario || ""))) return false;   // reclamos de prueba: nunca se envían (la prueba sí los revisa)
    const R = r.robot || {};
    if (["dudoso", "enviado", "enviando"].includes(R.estado)) return false;                                   // nunca repetir
    if (R.estado === "error" && (R.version || 1) === VERSION && !(Number(r.actualizado || 0) > Number(R.fecha || 0)) && !SOLO) return false; // espera a que se corrija
    if (MODO === "prueba" && R.prueba && !SOLO) return false;                                              // una sola prueba por reclamo
    return true;
  });
  console.log(`Modo ${MODO}. Reclamos de Reservas por someter: ${cand.length}.`);
  if (!cand.length) { if (MODO === "prueba") await ntfy(tema, "🧪 Prueba del robot de reembolsos", "El robot corrió bien, pero no hay reclamos de Seguros Reservas en «Recibido» para probar. Envíe uno de prueba desde su portal (escriba PRUEBA en el comentario) y vuelva a correrlo.", { tags: ["test_tube"] }); return; }
  const browser = await chromium.launch();
  let ok = 0, mal = 0;
  try {
    for (const d of cand) {
      const r = d.data(); const ref = d.ref; const ahora = Date.now();
      const cliRC = (await ref.parent.parent.get()).data() || {};
      const cliCRM = clientes.find(c => String(c.id) === String(r.crmId || cliRC.crmId));
      const nomCli = r.clienteNombre || cliRC.nombre || (cliCRM ? `${cliCRM.nombre || ""} ${cliCRM.apellido || ""}`.trim() : "cliente");
      const totales = {}; (r.procedimientos || []).forEach(p => { totales[p.moneda] = (totales[p.moneda] || 0) + Number(p.monto || 0); });
      const totTxt = Object.entries(totales).map(([m, v]) => mon(v, m)).join(" + ");
      try {
        const cedula = dig(cliCRM && cliCRM.documento);
        if (cedula.length !== 11) throw new Alto("el titular no tiene cédula válida en el CRM (se necesita para entrar a Just – Reembolso)");
        const archivos = await archivosDe(ref);
        let pulsado = false;
        const res = await someter(browser, r, cedula, archivos, MODO === "real", async () => { pulsado = true; await ref.update({ robot: { estado: "enviando", fecha: Date.now() } }); }).catch(e => { e.pulsado = pulsado; throw e; });
        if (res.prueba) {
          await ref.update({ "robot.prueba": ahora });
          await ntfy(tema, `🧪 Prueba del robot: reclamo ${d.id}`, `${nomCli} · ${r.paciente && r.paciente.nombre}\n${(r.procedimientos || []).length} servicio(s) · ${totTxt} · ${archivos.length} documento(s)\n\nSe llenó todo en Just – Reembolso SIN enviar. Revise la foto que llega a continuación.\n\n${res.estado || ""}`, { tags: ["test_tube"] });
          await ntfyFoto(tema, `prueba-${d.id}.png`, res.foto); ok++;
        } else if (res.numero) {
          const nota = `Sometido en Just – Reembolso de Seguros Reservas, solicitud No. ${res.numero} (robot GEHCH).`;
          await ref.update({ estado: "Enviado a aseguradora", liquidacion: { numeroAseg: res.numero }, notaAdmin: nota, actualizado: ahora,
            historial: admin.firestore.FieldValue.arrayUnion({ estado: "Enviado a aseguradora", nota, fecha: ahora }), robot: { estado: "enviado", numero: res.numero, fecha: ahora } });
          const nombrePila = String(nomCli).split(" ")[0];
          const msgCli = `Hola, ${nombrePila}. Su reclamo de reembolso fue sometido a Seguros Reservas con la solicitud No. ${res.numero} (${totTxt}). Reservas responde normalmente en 48 horas laborables; le avisamos en cuanto lo aprueben. También puede ver el estado en su portal de GEHCH.`;
          await ntfy(tema, `✅ Reembolso sometido a Reservas · No. ${res.numero}`, `${nomCli} · paciente ${r.paciente && r.paciente.nombre}\n${(r.procedimientos || []).length} servicio(s) · ${totTxt}\n\nMensaje para el cliente (WhatsApp):\n${msgCli}`, { tags: ["white_check_mark"] });
          ok++;
        } else {
          await ref.update({ robot: { estado: "dudoso", motivo: res.motivo, fecha: ahora } });
          await ntfy(tema, `⚠️ Reembolso de ${nomCli}: revisar en Reservas`, `El robot pulsó «Enviar» pero no vio el número de solicitud (${res.motivo}).\n\nNO se reintenta para no duplicarlo. Revise en Reservas si entró; si entró, ponga el número en el CRM; si no, sométalo a mano.`, { tags: ["warning"], priority: 4 });
          await ntfyFoto(tema, `dudoso-${d.id}.png`, res.foto); mal++;
        }
      } catch (e) {
        const motivo = e instanceof Alto ? e.message : "error técnico del robot: " + String(e.message || e).split("\n")[0].slice(0, 200);
        if (e.pulsado) {   // ya se había pulsado «Enviar»: no se sabe si entró → dudoso, sin reintento
          await ref.update({ robot: { estado: "dudoso", motivo, fecha: ahora } }).catch(() => {});
          await ntfy(tema, `⚠️ Reembolso de ${nomCli}: revisar en Reservas`, `El robot pulsó «Enviar» y luego falló (${motivo}).\n\nNO se reintenta para no duplicarlo. Revise en Reservas si entró; si entró, ponga el número en el CRM; si no, sométalo a mano.`, { tags: ["warning"], priority: 4 });
          mal++; continue;
        }
        if (MODO === "real") await ref.update({ robot: { estado: "error", motivo, fecha: ahora, version: VERSION } }).catch(() => {});
        if (e.foto) await ntfyFoto(tema, `error-${d.id}.png`, e.foto);
        await ntfy(tema, `🤖 No sometí el reembolso de ${nomCli}`, `${MODO === "prueba" ? "(Prueba) " : ""}Motivo: ${motivo}${e.estado ? "\n\n" + e.estado : ""}\n\nNo se envió nada a Reservas. El reclamo sigue en «Recibido» en el CRM: corríjalo o sométalo a mano. Si lo corrige en el portal, el robot lo vuelve a intentar solo.`, { tags: ["robot"], priority: 4 });
        mal++; console.log(`Reclamo ${d.id}: no enviado (${e instanceof Alto ? "motivo de negocio" : "error técnico"}).`);
      }
    }
  } finally { await browser.close(); }
  console.log(`Listo: ${ok} correcto(s), ${mal} con aviso.`);
}
main().catch(e => { console.error("Error:", e.message); process.exit(1); });
