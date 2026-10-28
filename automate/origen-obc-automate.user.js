// ==UserScript==
// @name         ORIGEN → OBC (automate de saisie des achats)
// @namespace    https://nabiouague-cpu.github.io/eco-traca/
// @version      0.3.0
// @description  Renseigne l'ERP OBC (onpointsunrise.com) à partir d'un lot copié depuis ORIGEN : compte tiers, coopérative, transporteur, producteur, connaissement brousse, données livraison, pesée, bordereau. Cherche avant de créer, remplit chaque écran et s'arrête avant « Enregistrer » pour validation.
// @author       ECORIGINE — ORIGEN
// @match        https://onpointsunrise.com/*
// @match        https://www.onpointsunrise.com/*
// @updateURL    https://nabiouague-cpu.github.io/eco-traca/automate/origen-obc-automate.user.js
// @downloadURL  https://nabiouague-cpu.github.io/eco-traca/automate/origen-obc-automate.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const VERSION = '0.3.0';
  const CLE = 'origen_obc_etat';
  const ORIGEN_URL = 'https://nabiouague-cpu.github.io/eco-traca/index.html';
  const API = 'https://sfjvtwzrnzjvyhfqxswm.supabase.co/functions/v1/obc-file';   // file d'attente ORIGEN (lecture des lots, retour des résultats)
  const CLE_FILE = 'origen_obc_file';
  const ENTITE = '1';                 // ECORIGINE
  const ATTENTE_MAX = 20000;
  const NB_ETAPES = 10;
  const COMPTE_GENERAL = '401100000';   // « 401100000 - Fournisseurs » : compte général des coopératives (validé par l'utilisateur)
  const ETAPES = ['Compte tiers gros traitant', 'Gros traitant', 'Compte tiers coopérative', 'Coopérative', 'Transporteur', 'Producteur', 'Connaissement brousse', 'Données livraison', 'Pesée', 'Bordereau de réception'];
  const PAGES = ['/PlanComptableTiersEntite/Index', '/Fournisseur/Index', '/PlanComptableTiersEntite/Index', '/Fournisseur/Index', '/AgroParametrage/ParametrageTransporteur', '/AgroAchatProducteur/Index', '/AgroAchatConnaissementBrousse/Index', '/AgroAchatConnaissementUsine/Index', '/AgroAchatPeseeBrousse/Index', '/AgroAchatBordereauReception/Index'];
  const BTN_NOUVEAU = ['#btnCreatePlanComptableEntiteIndex', 'a[href="/Fournisseur/Create"]', '#btnCreatePlanComptableEntiteIndex', 'a[href="/Fournisseur/Create"]', 'a[href="/AgroParametrageTransporteur/Create"]', 'a[href="/AgroAchatProducteur/Create"]', 'a[href="/AgroAchatConnaissementBrousse/Create"]', 'a[href="/AgroAchatConnaissementUsine/Create"]', 'a[href="/AgroAchatPeseeBrousse/Create"]', 'a[href="/AgroAchatBordereauReception/Create"]'];
  const FORMS = ['#formCreatePlanComptableTiersEntite', '#formCreateEditFournisseur', '#formCreatePlanComptableTiersEntite', '#formCreateEditFournisseur', '#frmAgroParametrageTransporteurCreate', '#frmAgroAchatProducteurCreate', '#frmAgroAchatConnaissementBrousseCreate', '#frmAgroAchatConnaissementUsineCreate', '#frmAgroAchatPeseeBrousseCreate', '#frmAgroAchatBordereauReceptionCreate'];

  const N = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const PLAQUE = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // ---------- anti-veille : Chrome ralentit les onglets cachés (1 action/s, puis 1/min après 5 min) ----------
  // Les attentes passent par un Web Worker (non bridé), l'onglet garde un verrou Web Locks (ni gelé ni déchargé),
  // un son inaudible et un verrou d'écran empêchent la mise en veille ; chaque pièce est facultative et se replie sans erreur.
  const veille = (function () {
    let worker = null, seq = 0, demarre = false; const attente = new Map();
    try {
      const src = 'self.onmessage=function(e){var id=e.data.id;setTimeout(function(){self.postMessage(id)},e.data.ms)}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (ev) => { const x = attente.get(ev.data); if (x) { attente.delete(ev.data); x.r(); } };
      worker.onerror = () => { const l = [...attente.values()]; attente.clear(); worker = null; l.forEach((x) => setTimeout(x.r, x.ms)); };
    } catch (er) { worker = null; }
    const dormir = (ms) => new Promise((r) => {
      if (!worker) return setTimeout(r, ms);
      const id = ++seq; attente.set(id, { r, ms });
      try { worker.postMessage({ id, ms }); } catch (er) { attente.delete(id); setTimeout(r, ms); }
    });
    function demarrer() {
      if (demarre) return; demarre = true;
      try { if (navigator.locks) navigator.locks.request('origen-noah-actif', () => new Promise(() => {})); } catch (er) { /* ignoré */ }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ctx = new AC(), o = ctx.createOscillator(), g = ctx.createGain();
          g.gain.value = 0.0001; o.frequency.value = 30; o.connect(g); g.connect(ctx.destination); o.start();
          const reprendre = () => { try { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); } catch (er) { /* ignoré */ } };
          reprendre(); ['click', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, reprendre, { capture: true, passive: true })); setInterval(reprendre, 5000);
        }
      } catch (er) { /* ignoré */ }
      try {
        if (navigator.wakeLock) {
          const verrou = () => navigator.wakeLock.request('screen').catch(() => {});
          verrou(); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verrou(); });
        }
      } catch (er) { /* ignoré */ }
    }
    return { dormir, demarrer };
  })();
  const dormir = veille.dormir;
  const num = (v) => { const t = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.'); if (t === '') return ''; const n = Number(t); return isFinite(n) ? String(n) : ''; };
  const isoDate = (fr) => { const m = String(fr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
  const $ = () => window.jQuery;

  // ---------- état (localStorage) ----------
  function lireEtat() {
    try {
      const e = JSON.parse(localStorage.getItem(CLE) || 'null');
      // lot lancé avec une ancienne version (7 ou 8 étapes) : on décale les étapes d'un cran
      if (e && !e.v10) { const d = e.v8 ? 2 : 3; e.v10 = true; e.etape = (e.etape || 1) + d; const f = {}; Object.keys(e.fait || {}).forEach((k) => { f[Number(k) + d] = e.fait[k]; }); e.fait = f; localStorage.setItem(CLE, JSON.stringify(e)); }
      return e;
    } catch (e) { return null; }
  }
  function ecrireEtat(e) { localStorage.setItem(CLE, JSON.stringify(e)); }
  function effacerEtat() { localStorage.removeItem(CLE); }
  function journal(e, texte) { e.journal = (e.journal || []).concat([new Date().toLocaleTimeString('fr-FR') + ' ' + texte]).slice(-60); ecrireEtat(e); afficherEtat(); }

  // ---------- file d'attente ORIGEN ----------
  function lireFile() { try { return JSON.parse(localStorage.getItem(CLE_FILE) || 'null') || {}; } catch (e) { return {}; } }
  function ecrireFile(f) { localStorage.setItem(CLE_FILE, JSON.stringify(f)); }
  async function api(action, data) {
    let derniere = null;
    for (let essai = 0; essai < 3; essai++) {
      try {
        const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: lireFile().token, action }, data || {})) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) throw new Error('Code de liaison invalide : copie-le à nouveau depuis ORIGEN (onglet Saisie OBC › 🔑 Code de liaison)');
        if (!r.ok) throw new Error(j.erreur || 'HTTP ' + r.status);
        return j;
      } catch (err) { derniere = err; if (/Code de liaison/.test(err.message)) throw err; await dormir(2500); }
    }
    throw new Error('ORIGEN injoignable (' + (derniere && derniere.message ? derniere.message : 'réseau') + ')');
  }
  async function rapporter(achatId, statut, message, numero) {
    for (let i = 0; i < 5; i++) { try { await api('resultat', { achat_id: achatId, statut, message, bordereau_numero: numero }); return true; } catch (err) { if (/Code de liaison/.test(err.message)) break; await dormir(4000); } }
    const f = lireFile(); f.enAttenteRapport = (f.enAttenteRapport || []).concat([{ achat_id: achatId, statut, message, bordereau_numero: numero }]); ecrireFile(f); return false;
  }
  async function viderRapports() {
    const f = lireFile(); const l = f.enAttenteRapport || []; if (!l.length) return;
    f.enAttenteRapport = []; ecrireFile(f);
    for (const r of l) await rapporter(r.achat_id, r.statut, r.message, r.bordereau_numero);
  }
  const fileActive = () => !!lireFile().actif;
  const transitoire = (m) => /session OBC expirée|ne répond pas|Failed to fetch|NetworkError|HTTP 5\d\d|Connecte-toi/i.test(m || '');
  async function suivantFile() {
    const f = lireFile(); if (!f.actif || f.pause) return false;
    await viderRapports();
    let r;
    try { r = await api('prochain'); }
    catch (err) { const g = lireFile(); g.erreurApi = err.message; if (/Code de liaison/.test(err.message)) g.actif = false; else dormir(20000).then(boucle); ecrireFile(g); afficherFile(); return false; }
    const g = lireFile();
    if (!r.lot) { g.actif = false; g.erreurApi = null; g.dernier = 'File terminée : ' + (g.saisis || 0) + ' saisi(s), ' + (g.echecs || 0) + ' échec(s). Les résultats sont dans ORIGEN › Saisie OBC.'; ecrireFile(g); afficherFile(); return false; }
    g.erreurApi = null; ecrireFile(g);
    ecrireEtat({ v10: true, lot: r.lot, etape: 1, statut: 'a_faire', ids: {}, fait: {}, journal: [], pause: false, erreur: null, note: '', enFile: true });
    afficherEtat(); afficherFile(); return true;
  }
  async function finLotFile(e) {
    const f = lireFile(); const num = (e.lot.bordereau && e.lot.bordereau.numero) || '';
    await rapporter(e.lot.achat_id, 'saisi', '', num);
    f.saisis = (f.saisis || 0) + 1; f.consecutifs = 0; ecrireFile(f);
    effacerEtat(); afficherEtat(); afficherFile(); dormir(600).then(boucle);
  }
  async function echecLot(e, msg) {
    const f = lireFile(); const texte = ETAPES[e.etape - 1] + ' : ' + msg;
    await rapporter(e.lot.achat_id, 'echec', texte, '');
    f.echecs = (f.echecs || 0) + 1; f.consecutifs = (f.consecutifs || 0) + 1;
    if (f.consecutifs >= 3) { f.actif = false; f.dernier = 'File arrêtée : 3 échecs de suite. Dernier : ' + texte; }
    ecrireFile(f); effacerEtat(); afficherEtat(); afficherFile(); dormir(600).then(boucle);
  }
  // Bouton « Enregistrer » du formulaire de l'étape k (dans la fenêtre modale qui le contient).
  function boutonEnregistrer(k) {
    const f = q(FORMS[k - 1]); const zone = (f && f.closest('.modal')) || document;
    const cand = [...zone.querySelectorAll('button, input[type=submit], input[type=button], a.btn')].filter((b) => b.offsetParent !== null && /enregistrer/i.test(b.textContent || b.value || ''));
    return cand.find((b) => /btn(Create|Save|Add)/i.test(b.id)) || cand[0] || null;
  }
  function erreurVisible() { return [...document.querySelectorAll('.toast-error .toast-message, .toast-error, .alert-danger, .swal2-html-container, .field-validation-error, .validation-summary-errors, .text-danger, .has-error .help-block, .invalid-feedback, .toast-warning, .toast-info')].filter((x) => x.offsetParent !== null).map((x) => x.textContent.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 220); }
  // Si OBC demande une confirmation après « Enregistrer » (boîte SweetAlert / Bootbox), on l'accepte.
  function confirmerBoite() { let n = 0; const t = setInterval(() => { const b = [...document.querySelectorAll('.swal2-confirm, .swal-button--confirm, .bootbox-accept, .sweet-alert .confirm')].find((x) => x.offsetParent !== null); if (b) { clearInterval(t); try { b.click(); } catch (er) { /* ignoré */ } } if (++n > 12) clearInterval(t); }, 400); }
  async function enregistrerAuto(e) {
    if (/⚠/.test(e.note || '')) { await echecLot(e, 'contrôle non concordant, rien n\'a été enregistré. ' + e.note); return false; }
    const b = await attendre(() => boutonEnregistrer(e.etape), 8000, 300);
    if (!b) { await echecLot(e, 'bouton « Enregistrer » introuvable'); return false; }
    await attendre(() => !b.disabled, 6000, 300);
    if (b.disabled) { await echecLot(e, 'bouton « Enregistrer » inactif (champ obligatoire non rempli). ' + erreurVisible()); return false; }
    e.t_save = Date.now(); e.cliques = (e.cliques || 0) + 1; ecrireEtat(e);
    journal(e, ETAPES[e.etape - 1] + ' : enregistrement automatique');
    b.click(); confirmerBoite(); return true;
  }

  // ---------- panneau ----------
  let panneau, zoneTexte, zoneEtat;
  function creerPanneau() {
    if (document.getElementById('origen-obc')) return;
    panneau = document.createElement('div');
    panneau.id = 'origen-obc';
    panneau.style.cssText = 'position:fixed;top:60px;right:12px;z-index:2147483647;width:360px;background:#fff;border:1px solid #cfd8d4;border-radius:12px;box-shadow:0 10px 30px rgba(14,59,54,.18);font:13px/1.45 Arial,Helvetica,sans-serif;color:#1e2b29;';
    panneau.innerHTML = '<div style="background:#0E3B36;color:#fff;padding:10px 14px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;" id="oo-tete"><span>🤖 Noah 1 · ORIGEN → OBC <small style="font-weight:400;opacity:.75">v' + VERSION + '</small></span><span id="oo-ferme" style="cursor:pointer;opacity:.8;">✕</span></div>'
      + '<div style="padding:12px 14px;">'
      + '<div id="oo-etat" style="margin-bottom:10px;white-space:pre-wrap;max-height:260px;overflow:auto;"></div>'
      + '<div id="oo-version" style="display:none;background:#fdecea;border:1px solid #B3261E;border-radius:8px;padding:6px 8px;margin-bottom:8px;font-size:12px;"></div>'
      + '<div id="oo-file" style="border:1px solid #cfd8d4;border-radius:8px;padding:8px;margin-bottom:8px;background:#f6faf8;">'
      + '<div style="font-weight:700;">🤖 File ORIGEN <span id="oo-file-etat" style="font-weight:400;color:#5b6b68;"></span></div>'
      + '<input id="oo-token" placeholder="Code de liaison (ORIGEN › Saisie OBC › 🔑) — une seule fois" style="width:100%;box-sizing:border-box;border:1px solid #cfd8d4;border-radius:6px;padding:5px;margin:6px 0;font:12px monospace;">'
      + '<label style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="checkbox" id="oo-auto" checked> Enregistrer automatiquement</label>'
      + '<button id="oo-file-go" style="background:#0E3B36;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">▶ Lancer la file</button> '
      + '<button id="oo-file-stop" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">⏹ Arrêter la file</button></div>'
      + '<textarea id="oo-lot" placeholder="Colle ici le lot copié depuis ORIGEN (bouton « Saisir dans OBC »)" style="width:100%;box-sizing:border-box;height:60px;border:1px solid #cfd8d4;border-radius:8px;padding:6px;font:12px monospace;"></textarea>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'
      + '<button id="oo-demarrer" style="background:#F2B705;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Démarrer</button>'
      + '<button id="oo-continuer" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Continuer</button>'
      + '<button id="oo-pause" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Pause</button>'
      + '<button id="oo-journal" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Copier le journal</button>'
      + '<button id="oo-stop" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;color:#B3261E;">Effacer le lot</button>'
      + '</div></div>';
    document.body.appendChild(panneau);
    zoneTexte = panneau.querySelector('#oo-lot'); zoneEtat = panneau.querySelector('#oo-etat');
    // Onglet « ORIGEN » toujours visible : « × » réduit seulement le panneau, un clic sur l'onglet le rouvre (un double-clic le remet à sa place d'origine).
    const onglet = document.createElement('div');
    onglet.id = 'origen-obc-onglet'; onglet.textContent = '🤖 Noah 1'; onglet.title = 'Ouvrir l\'automate (double-clic : remettre à sa place)';
    onglet.style.cssText = 'position:fixed;right:0;bottom:120px;z-index:2147483646;background:#0E3B36;color:#fff;padding:8px 12px;border-radius:10px 0 0 10px;font:700 12px Arial,Helvetica,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);display:none;';
    document.body.appendChild(onglet);
    const ranger = () => { panneau.style.display = 'none'; onglet.style.display = 'block'; };
    const rouvrir = () => { panneau.style.display = ''; onglet.style.display = 'none'; const r = panneau.getBoundingClientRect(); if (r.right < 80 || r.left > innerWidth - 80 || r.top < 0 || r.top > innerHeight - 40) { panneau.style.left = 'auto'; panneau.style.right = '12px'; panneau.style.top = '60px'; } };
    onglet.onclick = rouvrir;
    onglet.ondblclick = () => { rouvrir(); panneau.style.left = 'auto'; panneau.style.right = '12px'; panneau.style.top = '60px'; };
    panneau.querySelector('#oo-ferme').onclick = ranger;
    panneau.querySelector('#oo-demarrer').onclick = demarrer;
    panneau.querySelector('#oo-file-go').onclick = async () => {
      const f = lireFile(); const t = panneau.querySelector('#oo-token').value.trim(); if (t) f.token = t;
      if (!f.token) { alert('Colle d\'abord le code de liaison (ORIGEN › Saisie OBC › 🔑 Code de liaison).'); return; }
      f.auto = panneau.querySelector('#oo-auto').checked; f.actif = true; f.pause = false; f.saisis = 0; f.echecs = 0; f.consecutifs = 0; f.dernier = ''; f.erreurApi = null; ecrireFile(f);
      try { await api('liberer'); } catch (err) { f.actif = false; f.erreurApi = err.message; ecrireFile(f); afficherFile(); return; }
      afficherFile(); boucle();
    };
    panneau.querySelector('#oo-file-stop').onclick = () => { const f = lireFile(); f.actif = false; ecrireFile(f); afficherFile(); };
    panneau.querySelector('#oo-auto').onchange = (ev) => { const f = lireFile(); f.auto = ev.target.checked; ecrireFile(f); };
    panneau.querySelector('#oo-continuer').onclick = () => { const e = lireEtat(); if (!e) return; e.pause = false; e.erreur = null; if (e.statut === 'attente_enregistrement') e.statut = 'verifier'; ecrireEtat(e); boucle(); };
    panneau.querySelector('#oo-pause').onclick = () => { const e = lireEtat(); if (!e) return; e.pause = !e.pause; ecrireEtat(e); afficherEtat(); if (!e.pause) boucle(); };
    panneau.querySelector('#oo-journal').onclick = () => { const e = lireEtat(); navigator.clipboard.writeText(JSON.stringify({ origen_obc_journal: true, etape: e && e.etape, statut: e && e.statut, ids: e && e.ids, journal: e && e.journal }, null, 1)); };
    panneau.querySelector('#oo-stop').onclick = () => { if (confirm('Effacer le lot en cours ? (Ce qui est déjà enregistré dans OBC reste enregistré.)')) { effacerEtat(); afficherEtat(); } };
    // déplaçable
    let dx = 0, dy = 0, drag = false; const tete = panneau.querySelector('#oo-tete');
    tete.onmousedown = (ev) => { drag = true; dx = ev.clientX - panneau.offsetLeft; dy = ev.clientY - panneau.offsetTop; ev.preventDefault(); };
    document.addEventListener('mousemove', (ev) => { if (!drag) return; panneau.style.left = Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx)) + 'px'; panneau.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px'; panneau.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { drag = false; });
    afficherEtat(); afficherFile(); verifierVersion();
  }
  // Prévient quand une version plus récente de l'automate est publiée (Tampermonkey met parfois des heures à la voir).
  async function verifierVersion() {
    try {
      const r = await fetch('https://nabiouague-cpu.github.io/eco-traca/automate/origen-obc-automate.user.js?t=' + Date.now(), { cache: 'no-store' }); const t = await r.text();
      const m = t.match(/@version\s+([0-9.]+)/); if (!m || m[1] === VERSION) return;
      const z = document.getElementById('oo-version'); if (!z) return;
      z.style.display = 'block'; z.innerHTML = '⚠ Version ' + m[1] + ' disponible (tu as ' + VERSION + ') : <a href="https://nabiouague-cpu.github.io/eco-traca/automate/origen-obc-automate.user.js" target="_blank" style="color:#B3261E;font-weight:700">cliquer ici pour mettre à jour</a>, puis recharger cette page.';
    } catch (er) { /* hors ligne : pas de bannière */ }
  }
  function afficherFile() {
    const z = document.getElementById('oo-file-etat'); if (!z) return; const f = lireFile();
    const tok = document.getElementById('oo-token'); if (tok) tok.style.display = f.token ? 'none' : '';
    const auto = document.getElementById('oo-auto'); if (auto && f.auto === false) auto.checked = false;
    z.innerHTML = (f.actif ? '<b style="color:#1f7a4d">en marche</b> — ' + (f.saisis || 0) + ' saisi(s), ' + (f.echecs || 0) + ' échec(s)' : 'arrêtée' + (f.token ? ' — liaison ✓' : '')) + (f.erreurApi ? '<div style="color:#B3261E">⚠ ' + f.erreurApi + '</div>' : '') + (f.dernier ? '<div style="color:#0E3B36;font-weight:700">' + f.dernier + '</div>' : '');
  }
  function afficherEtat() {
    if (!zoneEtat) return;
    const e = lireEtat();
    if (!e) { zoneEtat.innerHTML = '<span style="color:#5b6b68">Aucun lot. Colle un lot ORIGEN puis « Démarrer ».</span>'; return; }
    const lignes = ETAPES.map((n, i) => {
      const k = i + 1; let s = '○';
      if (k < e.etape) s = '✓'; else if (k === e.etape) s = e.statut === 'attente_enregistrement' ? '✎' : '▶';
      return (k === e.etape ? '<b>' : '') + s + ' ' + k + '. ' + n + (e.fait && e.fait[k] ? ' <span style="color:#5b6b68">(' + e.fait[k] + ')</span>' : '') + (k === e.etape ? '</b>' : '');
    });
    const tete = '<div style="font-weight:700;margin-bottom:4px;">' + (e.lot.connaissement.numero || '') + ' — ' + (e.lot.cooperative.sigle || '') + '</div>';
    let message = '';
    if (e.erreur) message = '<div style="color:#B3261E;margin-top:8px;">⚠ ' + e.erreur + '</div>';
    else if (e.pause) message = '<div style="color:#8a6d00;margin-top:8px;">⏸ En pause.</div>';
    else if (e.statut === 'attente_enregistrement') message = '<div style="color:#0E3B36;margin-top:8px;background:#fff6d6;padding:6px 8px;border-radius:8px;">✎ Formulaire rempli : <b>vérifie, puis clique « Enregistrer » dans OBC</b>. Le robot vérifie l\'enregistrement et enchaîne tout seul. ' + (e.note || '') + '</div>';
    else if (e.statut === 'termine') message = '<div style="color:#1f7a4d;margin-top:8px;font-weight:700;">✓ Les 10 étapes sont faites. ' + (e.note || '') + '</div>' + (e.lot && e.lot.achat_id ? '<div style="margin-top:6px;"><a href="' + ORIGEN_URL + '#bordereau=' + encodeURIComponent(e.lot.achat_id) + '" target="_blank" style="color:#0E3B36;font-weight:700;">🖨 Imprimer le bordereau (ORIGEN)</a></div>' : '');
    else if (e.note) message = '<div style="color:#5b6b68;margin-top:8px;">' + e.note + '</div>';
    zoneEtat.innerHTML = tete + lignes.join('<br>') + message + (e.journal && e.journal.length ? '<div style="color:#5b6b68;margin-top:6px;font-size:11px;">' + e.journal[e.journal.length - 1] + '</div>' : '');
  }
  function demarrer() {
    let lot; try { lot = JSON.parse(zoneTexte.value.trim()); } catch (e) { alert('Le texte collé n\'est pas un lot ORIGEN valide.'); return; }
    if (!lot || !lot.origen_obc_lot) { alert('Ce n\'est pas un lot « Saisir dans OBC » d\'ORIGEN.'); return; }
    ecrireEtat({ v10: true, lot, etape: 1, statut: 'a_faire', ids: {}, fait: {}, journal: [], pause: false, erreur: null, note: '' });
    zoneTexte.value = '';
    afficherEtat(); boucle();
  }

  // ---------- accès OBC ----------
  // OBC répond parfois lentement ou coupe la connexion (« Failed to fetch ») : délai de 30 s par essai et 3 essais avant d'abandonner.
  async function obcFetch(url) {
    let derniere = null;
    for (let essai = 0; essai < 3; essai++) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
      try { const r = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: ctl.signal }); clearTimeout(t); if (r.status >= 500 && essai < 2) { derniere = new Error('HTTP ' + r.status); await dormir(3000); continue; } return r; }
      catch (err) { clearTimeout(t); derniere = err; await dormir(3000); }
    }
    throw new Error('OBC ne répond pas (' + (derniere && derniere.message ? derniere.message : 'réseau') + ') sur ' + url.split('?')[0] + ' : patiente un instant puis « Continuer »');
  }
  async function getJson(url) { const r = await obcFetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url.split('?')[0] + (r.status === 403 || r.status === 401 ? ' — session OBC expirée : reconnecte-toi puis « Continuer »' : '')); const j = await r.json(); if (Array.isArray(j)) return j; if (j && typeof j === 'object') { const arr = Object.values(j).find(Array.isArray); if (arr) return arr; } return []; }
  const jsonVal = (x) => x == null ? '' : String(x.Value ?? x.value ?? x.producteur_id ?? x.Id ?? x.id ?? ''); const jsonTxt = (x) => x == null ? '' : String(x.Text ?? x.text ?? x.producteur_nom_long ?? x.Nom ?? x.nom ?? x.Name ?? x.name ?? '');
  async function getHtml(url) { const r = await obcFetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url.split('?')[0]); return new DOMParser().parseFromString(await r.text(), 'text/html'); }
  const lignesTable = (doc) => [...doc.querySelectorAll('table tbody tr')].map((tr) => ({ tr, c: [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()) })).filter((l) => l.c.length > 3);
  function connecte() { return !/\/Account\/Login/i.test(location.pathname) && !!document.querySelector('#logoutForm'); }

  async function attendre(fn, max, pas) { const t0 = Date.now(); while (Date.now() - t0 < (max || ATTENTE_MAX)) { const v = fn(); if (v) return v; await dormir(pas || 250); } return null; }
  // test : RegExp (sur le texte brut), fonction (texte normalisé → bool) ou chaîne (contenue, sans accents ni casse)
  function optionParTexte(sel, test) { if (!sel) return null; const f = test instanceof RegExp ? (t) => test.test(t) : typeof test === 'function' ? (t) => test(N(t)) : (t) => N(t).includes(N(test)); return [...sel.options].find((o) => o.value !== '' && f(o.text)) || null; }
  const exact = (v) => { const n = N(v); return (t) => t === n; };
  async function attendreOption(sel, test) { return attendre(() => optionParTexte(sel, test), ATTENTE_MAX, 300); }
  function setInput(el, v) { if (!el) return; el.value = v == null ? '' : String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('focusout', { bubbles: true })); try { if (el.type !== 'hidden' && !el.readOnly && !el.disabled) { el.focus(); el.blur(); } } catch (e) { /* ignoré */ } /* OBC recalcule poids brut, net, sacs manquants… quand on quitte le champ */ }
  // Redessine les listes à choix d'OBC (elles remplissent leur valeur sans toujours rafraîchir l'affichage).
  function rafraichirListes(form) { const jq = $(); if (!jq || !jq.fn || !jq.fn.selectpicker || !form) return; [...form.querySelectorAll('select')].forEach((s) => { try { jq(s).selectpicker('refresh'); } catch (e) { /* liste non initialisée */ } }); }
  function setSelect(el, value) {
    if (!el) return false;
    const v = String(value);
    const opt = [...el.options].find((o) => o.value === v); if (!opt) return false;
    [...el.options].forEach((o) => { o.selected = (o === opt); }); el.value = v;
    const jq = $();
    if (jq && jq.fn && jq.fn.selectpicker) { try { jq(el).selectpicker('val', v); } catch (e) { /* liste non initialisée */ } try { jq(el).selectpicker('refresh'); } catch (e) { /* idem */ } }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (jq) { try { jq(el).trigger('change'); } catch (e) { /* ignoré */ } }
    // mémorise la valeur voulue : OBC réinitialise parfois ses listes après coup, on la réapplique (voir reappliquer)
    el.dataset.origenVal = v;
    return true;
  }
  // Réapplique les valeurs voulues sur les listes du formulaire après un délai (si OBC les a réinitialisées) ; renvoie ce qui manque encore.
  async function reappliquer(form, ms) {
    let manques = [];
    rafraichirListes(form);
    for (let passe = 0; passe < 2; passe++) {
      await dormir(ms || 800); manques = [];
      [...form.querySelectorAll('select[data-origen-val]')].forEach((el) => { const v = el.dataset.origenVal; if (el.value !== v) { if (!setSelect(el, v)) manques.push(el.id); } });
    }
    await dormir(300);
    [...form.querySelectorAll('select[data-origen-val]')].forEach((el) => { if (el.value !== el.dataset.origenVal && !manques.includes(el.id)) manques.push(el.id); });
    rafraichirListes(form);
    return manques;
  }
  async function setSelectTexte(el, test, libelle, affiche) { const o = await attendreOption(el, test); if (!o) throw new Error(libelle + ' : « ' + (affiche || (test instanceof RegExp ? test.source : typeof test === 'function' ? '?' : test)) + ' » non reconnu dans la liste OBC' + (/^(Origine|Destination)$/.test(libelle) ? ' : cette liste est un référentiel d\'OBC qui ne se remplit pas toute seule. Ajoute « ' + (affiche || '') + ' » dans OBC (Agro > Paramétrage > ' + libelle + '), puis « Continuer ».' : '')); setSelect(el, o.value); return o; }
  // Entité : déjà ECORIGINE dans OBC ; la changer déclenche le rechargement de toutes les listes (et efface les sélections).
  function setEntite(el) { if (!el) return; if (String(el.value) !== ENTITE) setSelect(el, ENTITE); }
  // Attend qu'une liste ait fini de se (re)charger : nombre d'options stable pendant 1,2 s et au moins une valeur.
  async function listeStable(el) { let n = -1, stableDepuis = 0; const t0 = Date.now(); while (Date.now() - t0 < ATTENTE_MAX) { const m = el ? el.options.length : 0; if (m === n && m > 1) { if (Date.now() - stableDepuis > 800) return true; } else { n = m; stableDepuis = Date.now(); } await dormir(200); } return el && el.options.length > 1; }
  function setRadio(id) { const el = document.getElementById(id); if (!el) return; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  const q = (s) => document.querySelector(s);

  // Ouvre le formulaire de création de l'étape k sur la page courante (ou navigue d'abord vers la bonne page).
  // NB : la page /Create ouverte seule est un formulaire brut (sans les scripts d'OBC : listes en cascade absentes) : on passe toujours par le bouton « Nouveau » de la page Historique.
  async function ouvrirFormulaire(k) {
    if (q(FORMS[k - 1])) return q(FORMS[k - 1]);
    if (!location.pathname.toLowerCase().startsWith(PAGES[k - 1].toLowerCase())) { location.href = PAGES[k - 1]; return null; }
    const enErreur = () => /Une erreur est survenue/.test((document.body && document.body.innerText) || '');
    const btn = await attendre(() => q(BTN_NOUVEAU[k - 1]) || (enErreur() ? 'erreur' : null), 10000);
    if (btn === 'erreur') throw new Error('La page « ' + ETAPES[k - 1] + ' » d\'OBC est en erreur : OBC plante à l\'affichage de sa liste (un enregistrement a une donnée vide, souvent une parcelle sans code). Corrige cet enregistrement dans OBC, puis « Continuer ».');
    if (!btn) throw new Error('Bouton « Nouveau » introuvable sur ' + PAGES[k - 1]);
    btn.click();
    const f = await attendre(() => q(FORMS[k - 1]), ATTENTE_MAX);
    if (!f) throw new Error('Le formulaire ne s\'est pas ouvert (' + FORMS[k - 1] + ')');
    await dormir(500);
    return f;
  }

  // ---------- recherches d'existence ----------
  async function trouverFournisseur(lot) {
    const ccc = String(lot.cooperative.ccc || '').toUpperCase();
    const parse = (doc) => lignesTable(doc).map((l) => ({ nom: l.c[2], code: l.c[3], poste: l.c[9] || '', id: (l.c[10] || '').trim() })).filter((r) => r.id);
    const mot = N(lot.cooperative.sigle).split(' ').find((m) => m.length >= 3) || N(lot.cooperative.sigle).split(' ')[0] || '';
    let rows = parse(await getHtml('/Fournisseur/Index?isProjetProv=0&filterEntite=' + ENTITE + '&filtrePosteComptable=&filter=' + encodeURIComponent(mot) + '&pageSize=100'));
    let r = rows.find((x) => ccc && x.poste.toUpperCase().includes(ccc)) || rows.find((x) => N(x.code) === N(lot.cooperative.sigle) || N(x.nom) === N(lot.cooperative.nom_complet));
    if (!r && ccc) { rows = parse(await getHtml('/Fournisseur/Index?isProjetProv=0&filterEntite=' + ENTITE + '&filtrePosteComptable=&filter=&pageSize=5000')); r = rows.find((x) => x.poste.toUpperCase().includes(ccc)); }
    return r || null;
  }
  async function listerTransporteurs(nom) {
    const doc = await getHtml('/AgroParametrageTransporteur/GetAllAgroTransporteurs?id_entite=&filter=' + encodeURIComponent(nom));
    return lignesTable(doc).map((l) => ({ nom: l.c[2], code: l.c[3], veh: l.c[4], rem: l.c[5], chauffeur: l.c[6] })).filter((r) => r.nom);
  }
  function choisirTransporteur(lot, rows) {
    const base = N(lot.transporteur.nom); if (!base) return { existant: null, nouveauNom: '' };
    // OBC complète le nom du transporteur avec le dernier mot du nom du chauffeur (« ZOUNGRANA ABDOULAYE » devient « ZOUNGRANA ABDOULAYE SIAKA ») et garde le nom saisi comme CODE.
    const memeNom = rows.filter((r) => N(r.nom) === base || N(r.nom).replace(/ \d+$/, '') === base || N(r.code) === base || N(r.code).replace(/ \d+$/, '') === base || N(r.nom).startsWith(base + ' '));
    const veh = PLAQUE(lot.transporteur.immat_vehicule), rem = PLAQUE(lot.transporteur.immat_remorque), chauf = N(lot.transporteur.chauffeur);
    const existant = memeNom.find((r) => PLAQUE(r.veh) === veh && PLAQUE(r.rem) === rem) || memeNom.find((r) => N(r.code) === base && chauf && N(r.chauffeur) === chauf) || null;
    if (existant) return { existant, nouveauNom: '' };
    if (!memeNom.length) return { existant: null, nouveauNom: lot.transporteur.nom.trim() };
    const nums = memeNom.map((r) => { const m = N(r.nom).match(/ (\d+)$/); return m ? Number(m[1]) : 1; });
    return { existant: null, nouveauNom: lot.transporteur.nom.trim() + ' ' + (Math.max(...nums) + 1) };
  }
  // Campagne : lue dans la liste du formulaire déjà ouvert (aucun chargement de page supplémentaire).
  function campagneDansListe(sel, lot) {
    if (!sel) throw new Error('Liste des campagnes introuvable');
    const cle = String(lot.campagne.nom || '').match(/\d{2}\s*-\s*\d{2}/); const test = cle ? cle[0].replace(/\s/g, '') : lot.campagne.nom;
    const o = [...sel.options].find((x) => x.value && N(x.text).replace(/ /g, '').includes(N(test).replace(/ /g, '')) && !/interm/i.test(x.text) === !/interm/i.test(lot.campagne.recolte));
    if (!o) throw new Error('Campagne « ' + lot.campagne.nom + ' » introuvable dans OBC');
    return o.value;
  }
  function fixerCampagne(e) { const sel = q('#txtcampagne_idAdd'); if (!e.ids.campagne_id) e.ids.campagne_id = campagneDansListe(sel, e.lot); setSelect(sel, e.ids.campagne_id); }

  // ---------- les 10 étapes ----------
  // Étape 1 : compte tiers de la coopérative (Plan comptable tiers entité → Nouveau compte tiers).
  // N° compte = code CCC ; intitulé = sigle de la coopérative ; classe 4 ; catégorie Fournisseur ; compte général 401100000.
  async function trouverCompteTiers(ccc) {
    const plan = await getJson('/AppMethods1/LoadPlanComptableEntiteTiersFournisseurByEntiteId?EntiteId=' + ENTITE);
    return plan.find((p) => String(p.Value || '').trim().toUpperCase() === String(ccc).toUpperCase()) || null;
  }
  // Création d'un compte tiers (formulaire « Nouveau compte tiers ») : k = n° de l'étape qui porte le formulaire.
  async function creerCompteTiers(e, k, ccc, intitule) {
    const f = await ouvrirFormulaire(k); if (!f) return 'navigation';
    const ent = q('#txtid_entitePlanComptableTiersEntiteAdd');
    if (ent && !/^ECORIGINE/i.test((ent.options[ent.selectedIndex] || {}).text || '')) await setSelectTexte(ent, /^ECORIGINE/i, 'Entité');
    await setSelectTexte(q('#txtplan_comptable_entite_natureAdd'), /^CLASSE 4/i, 'Classe');
    await dormir(800); await listeStable(q('#txtplan_comptable_entite_parentAdd'));
    await setSelectTexte(q('#txtplan_comptable_entite_parentAdd'), new RegExp('^' + COMPTE_GENERAL + '\\b'), 'Compte général', COMPTE_GENERAL + ' - Fournisseurs');
    await setSelectTexte(q('#txtplan_comptable_entite_type_tiersAdd'), exact('Fournisseur'), 'Catégorie tiers', 'Fournisseur');
    setInput(q('#txtplan_comptable_entite_numeroAdd'), ccc); setInput(q('#txtplan_comptable_entite_nomAdd'), intitule);
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    return 'rempli';
  }
  // Gros traitants à créer dans OBC s'ils y manquent. Un nouveau code est donné même si l'entreprise existe déjà comme simple fournisseur (TOU002 TOUTON NEGOCE CI, SUC002 SUCDEN-CI : ces comptes restent intacts).
  const GROS_TRAITANTS = [{ cle: 'BOBBY VO', code: 'BOBB001', nom: 'BOBBY VO' }, { cle: 'SUCDEN', code: 'SUCD001', nom: 'SUCDEN' }, { cle: 'TOUTON', code: 'TOUT001', nom: 'TOUTON' }];
  function grosTraitantCible(lot) {
    const c = lot.cooperative; if (c.coop_propre) return null;
    for (const cand of (c.gros_traitants || [])) { const n = N(cand); const g = GROS_TRAITANTS.find((x) => n.includes(x.cle)); if (g) return g; }
    return null;
  }
  async function etapeGrosTraitantTiers(e) {
    const g = grosTraitantCible(e.lot);
    if (!g) { e.fait[1] = 'rien à créer'; return 'suivant'; }
    const ex = await trouverCompteTiers(g.code);
    if (ex) { e.fait[1] = 'déjà dans OBC : ' + (ex.Text || g.code); journal(e, 'Compte tiers gros traitant trouvé : ' + (ex.Text || g.code)); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const r = await creerCompteTiers(e, 1, g.code, g.nom); if (r !== 'rempli') return r;
    e.note = 'Compte tiers du gros traitant ' + g.nom + ' (' + g.code + ') : classe 4, Fournisseur, compte général ' + COMPTE_GENERAL + '.'; return 'rempli';
  }
  // Champs que la règle d'OBC exige pour activer « Enregistrer » (formulaire fournisseur) : liste de ceux qui sont vides.
  function champsFournisseurVides() { return [['txttelephone_fournisseurAdd', 'Téléphone'], ['txtmobile_fournisseurAdd', 'Mobile'], ['txtville_fournisseurAdd', 'Ville'], ['txtadresse_geographique_fournisseurAdd', 'Adresse géographique'], ['txtcode_fournisseurAdd', 'Sigle'], ['txtnom_fournisseurAdd', 'Dénomination sociale']].filter(([id]) => { const el = document.getElementById(id); return !el || !String(el.value || '').trim(); }).map((x) => x[1]); }
  async function etapeGrosTraitant(e) {
    const g = grosTraitantCible(e.lot);
    if (!g) { e.fait[2] = 'rien à créer'; return 'suivant'; }
    const doc = await getHtml('/Fournisseur/Index?isProjetProv=0&filterEntite=' + ENTITE + '&filtrePosteComptable=&filter=' + encodeURIComponent(g.nom.split(' ')[0]) + '&pageSize=100');
    const ex = lignesTable(doc).find((l) => N(l.c[3]) === N(g.code));   // par le code seulement : le même nom existe déjà sous un autre code (simple fournisseur)
    if (ex) { e.fait[2] = 'déjà dans OBC : ' + ex.c[2]; journal(e, 'Gros traitant trouvé : ' + ex.c[2]); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const plan = await trouverCompteTiers(g.code);
    if (!plan) { e.erreur = 'Le compte tiers « ' + g.code + ' – ' + g.nom + ' » n\'existe pas encore dans OBC : crée-le d\'abord, puis « Continuer ».'; return 'stop'; }
    const f = await ouvrirFormulaire(2); if (!f) return 'navigation';
    setEntite(q('#txtid_entiteAdd'));
    setInput(q('#txtnom_fournisseurAdd'), g.nom); setInput(q('#txtcode_fournisseurAdd'), g.code);   // la colonne « Code » de la liste = le sigle (ex. AWAH001)
    setSelect(q('#txtmode_reglement_fournisseurAdd'), '2'); setSelect(q('#txtsecteur_fournisseurAdd'), '1');
    setInput(q('#txtville_fournisseurAdd'), 'ABIDJAN'); setInput(q('#txtadresse_geographique_fournisseurAdd'), 'ABIDJAN');
    setRadio('txttype_fournisseur_agroAdd4');   // GROS TRAITANT
    // OBC n'active « Enregistrer » que si Téléphone ET Mobile sont renseignés : aucun numéro connu pour un gros traitant, on met un numéro à zéros (à corriger dans OBC si besoin).
    setInput(q('#txttelephone_fournisseurAdd'), '0000000000'); setInput(q('#txtmobile_fournisseurAdd'), '0000000000');
    await attendreOption(q('#txtnumero_poste_comptableAdd0'), new RegExp('^' + g.code + '\\b'));
    if (!setSelect(q('#txtnumero_poste_comptableAdd0'), g.code)) throw new Error('Poste comptable « ' + g.code + ' » non sélectionnable');
    setSelect(q('#txttype_prestation_achatAdd0'), '1');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    try { if (typeof window.validateCreateFournisseur === 'function') window.validateCreateFournisseur(); } catch (er) { /* ignoré */ }
    { const bs = q('#btnCreateFournisseur'); if (bs && bs.disabled) { const v = champsFournisseurVides(); throw new Error('« Enregistrer » reste grisé dans OBC. ' + (v.length ? 'Champs vides : ' + v.join(', ') + '. Remplis-les à la main, puis « Continuer ».' : 'Aucun champ obligatoire vide détecté : retape une lettre dans « Dénomination sociale » pour relancer le contrôle d\'OBC, puis « Continuer ».')); } }
    e.note = 'Gros traitant ' + g.nom + ' (' + g.code + ') — type GROS TRAITANT. Ville et adresse mises à « ABIDJAN », téléphone et mobile à 0000000000 par défaut (champs obligatoires) : corrige-les si besoin avant d\'enregistrer.'; return 'rempli';
  }
  async function etapeCompteTiers(e) {
    const c = e.lot.cooperative, ccc = String(c.ccc || '').trim().toUpperCase(), sigle = String(c.sigle || c.nom_complet || '').trim();
    if (!ccc) { e.erreur = 'La coopérative n\'a pas de code CCC dans ORIGEN : renseigne-le dans sa fiche, puis recopie le lot (« Saisir dans OBC »).'; return 'stop'; }
    const ex = await trouverCompteTiers(ccc);
    if (ex) { e.ids.compte_tiers = ccc; e.fait[3] = 'déjà dans OBC : ' + (ex.Text || ccc); journal(e, 'Compte tiers trouvé : ' + (ex.Text || ccc)); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const r = await creerCompteTiers(e, 3, ccc, sigle); if (r !== 'rempli') return r;
    e.note = 'Compte tiers ' + ccc + ' — ' + sigle + ' (classe 4, Fournisseur, compte général ' + COMPTE_GENERAL + ').'; return 'rempli';
  }
  async function etapeCooperative(e) {
    const lot = e.lot;
    if (!e.ids.fournisseur_id) { const r = await trouverFournisseur(lot); if (r) { e.ids.fournisseur_id = r.id; e.ids.fournisseur_nom = r.code; e.fait[4] = 'déjà dans OBC : ' + r.code; journal(e, 'Coopérative trouvée : ' + r.code + ' (id ' + r.id + ')'); return 'suivant'; } }
    else return 'suivant';
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const plan = await getJson('/AppMethods1/LoadPlanComptableEntiteTiersFournisseurByEntiteId?EntiteId=' + ENTITE);
    const poste = plan.find((p) => String(p.Value || '').toUpperCase() === String(lot.cooperative.ccc).toUpperCase());
    if (!poste) { e.erreur = 'Le poste comptable « ' + lot.cooperative.ccc + ' – ' + lot.cooperative.sigle + ' » n\'existe pas dans le plan comptable d\'OBC : crée-le d\'abord, puis « Continuer ».'; return 'stop'; }
    const f = await ouvrirFormulaire(4); if (!f) return 'navigation';
    const c = lot.cooperative;
    setEntite(q('#txtid_entiteAdd'));
    setInput(q('#txtnom_fournisseurAdd'), c.sigle); setInput(q('#txtcode_fournisseurAdd'), c.sigle); // modèle CAEZ COOP-CA : dénomination = code = sigle
    setSelect(q('#txtmode_reglement_fournisseurAdd'), '2'); setSelect(q('#txtsecteur_fournisseurAdd'), '1');
    // Coopérative créée depuis SAIGIC (fiche vide dans ORIGEN) : ville = localité du producteur, à défaut le département d'origine du connaissement ; adresse géographique = ville.
    const villeC = String(c.ville || (lot.producteur && lot.producteur.localite) || (lot.connaissement && lot.connaissement.origine) || 'ABIDJAN').toUpperCase();
    setInput(q('#txtville_fournisseurAdd'), villeC); // modèle : ni DFE, ni RCCM, ni téléphone/e-mail du fournisseur
    setInput(q('#txtadresse_postale_fournisseurAdd'), c.adresse_postale || ('BP ' + villeC)); setInput(q('#txtadresse_geographique_fournisseurAdd'), c.siege || villeC);
    setRadio('txttype_fournisseur_agroAdd2'); setInput(q('#txtnumero_agrement_ccc_fournisseur_agroAdd'), c.ccc); // code CCC demandé en plus du modèle
    // Gros traitant rattaché : le traitant du site de déchargement du lot dans ORIGEN (Awahus, Sitapa, M Bobby Vo, Coops Touton, Coops Sucden ; « Coops Ecorigine » = coopératives en propre, aucun gros traitant),
    // retrouvé par son nom dans la liste des gros traitants d'OBC. Aucun rattachement n'est inventé : sans correspondance, la liste reste vide.
    e.note = ''; let traitantNote = '';
    { const sel = q('#txtid_fournisseur_agro_gros_traitantAdd'); const gt = grosTraitantCible(lot); const cands = (gt ? [gt.nom] : []).concat(c.gros_traitants || []).map((x) => String(x || '').trim()).filter(Boolean);
      if (c.coop_propre) { traitantNote = ' Coopérative en propre (ECORIGINE) : pas de gros traitant rattaché.'; journal(e, 'Coopérative en propre : aucun gros traitant'); }
      else if (sel && cands.length) {
        await attendreOption(sel, /./).catch(() => null);
        const opts = [...sel.options].filter((o) => o.value !== '');
        let choisi = null, cand = '';
        for (const x of cands) { const cn = N(x); if (cn.length < 3) continue; choisi = opts.find((o) => N(o.text) === cn) || opts.find((o) => { const on = N(o.text); return on.length >= 3 && (cn.includes(on) || on.includes(cn)); }); if (choisi) { cand = x; break; } }
        if (choisi) { setSelect(sel, choisi.value); traitantNote = ' Gros traitant rattaché : ' + choisi.text.trim() + ' (ORIGEN : ' + cand + ').'; journal(e, 'Gros traitant rattaché : ' + choisi.text.trim()); }
        else { traitantNote = ' ⚠ Gros traitant : « ' + cands.join(' / ') + ' » (ORIGEN) ne correspond à aucun gros traitant d\'OBC (' + opts.map((o) => o.text.trim()).join(', ') + ') : choisis-le toi-même dans « Gros traitant rattaché » avant d\'enregistrer si nécessaire.'; journal(e, 'Gros traitant : aucune correspondance pour ' + cands.join(' / ')); }
      } }
    // OBC n'active « Enregistrer » que si Téléphone ET Mobile (section Contacts) sont renseignés : téléphone de la coopérative, à défaut celui de l'interlocuteur, à défaut 10 zéros (règle de Nabi).
    const telCoop = c.telephone || c.interlocuteur_tel || '0000000000';
    setInput(q('#txttelephone_fournisseurAdd'), telCoop); setInput(q('#txtmobile_fournisseurAdd'), telCoop);
    // Interlocuteur : celui d'ORIGEN ; coopérative sans interlocuteur et rattachée à BOBBY VO : BOBBY VO lui-même (règle de Nabi).
    const gtC = grosTraitantCible(lot), interNom = c.interlocuteur_nom || (gtC && gtC.cle === 'BOBBY VO' ? 'BOBBY VO' : '');
    setInput(q('#txtnom_prenom_interlocuteurAdd0'), interNom); setInput(q('#txtnum_telephone2_interlocuteurAdd0'), c.interlocuteur_tel || (interNom ? telCoop : '')); setInput(q('#txtemail_interlocuteurAdd0'), c.email); // modèle : téléphone dans « Téléphone 2 » de l'interlocuteur
    await attendreOption(q('#txtnumero_poste_comptableAdd0'), new RegExp('^' + poste.Value + '\\b'));
    if (!setSelect(q('#txtnumero_poste_comptableAdd0'), poste.Value)) throw new Error('Poste comptable non sélectionnable');
    setSelect(q('#txttype_prestation_achatAdd0'), '1');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    try { if (typeof window.validateCreateFournisseur === 'function') window.validateCreateFournisseur(); } catch (er) { /* ignoré */ }
    { const bs = q('#btnCreateFournisseur'); if (bs && bs.disabled) { const v = champsFournisseurVides(); throw new Error('« Enregistrer » reste grisé dans OBC. ' + (v.length ? 'Champs vides : ' + v.join(', ') + '. Remplis-les à la main, puis « Continuer ».' : 'Aucun champ obligatoire vide détecté : retape une lettre dans « Dénomination sociale » pour relancer le contrôle d\'OBC, puis « Continuer ».')); } }
    e.note = 'Coopérative ' + c.sigle + ' (' + c.ccc + ').' + traitantNote; return 'rempli';
  }
  async function etapeTransporteur(e) {
    const lot = e.lot;
    if (e.ids.transporteur_nom) return 'suivant';
    if (!lot.transporteur.nom) { e.fait[5] = 'pas de transporteur sur le connaissement'; journal(e, 'Transporteur absent du lot : étape sautée'); return 'suivant'; }
    const rows = await listerTransporteurs(lot.transporteur.nom.split(' ')[0]);
    const ch = choisirTransporteur(lot, rows);
    if (ch.existant) { e.ids.transporteur_nom = ch.existant.nom; e.fait[5] = 'déjà dans OBC : ' + ch.existant.nom; journal(e, 'Transporteur trouvé : ' + ch.existant.nom + ' (' + ch.existant.veh + ' / ' + ch.existant.rem + ')'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    e.ids.transporteur_nouveau = ch.nouveauNom;
    const f = await ouvrirFormulaire(5); if (!f) return 'navigation';
    setEntite(q('#txtid_entiteAdd'));
    setInput(q('#txttransporteur_nomAdd'), ch.nouveauNom); setInput(q('#txttransporteur_codeAdd'), ch.nouveauNom);
    setInput(q('#txttransporteur_immatriculation_vehiculeAdd'), lot.transporteur.immat_vehicule); setInput(q('#txttransporteur_immatriculation_remorqueAdd'), lot.transporteur.immat_remorque);
    setInput(q('#txttransporteur_nom_chauffeurAdd'), lot.transporteur.chauffeur);
    e.note = 'Transporteur « ' + ch.nouveauNom + ' »' + (ch.nouveauNom !== lot.transporteur.nom.trim() ? ' (nouveau camion pour un transporteur déjà connu).' : '.'); return 'rempli';
  }
  async function etapeProducteur(e) {
    const lot = e.lot;
    // 1) page Historique des producteurs filtrée sur la coopérative ; 2) en secours, la liste qu'OBC utilise dans ses formulaires
    // Le filtre d'OBC ne prend qu'un mot : on cherche sur le premier mot du nom (puis sur le n° CCC), et on vérifie la colonne Coopérative.
    const nomCoop = e.ids.fournisseur_nom || lot.cooperative.sigle;
    const motsCle = [...new Set([N(nomCoop).split(' ').find((m) => m.length >= 3) || N(nomCoop).split(' ')[0], String(lot.cooperative.ccc || '').toUpperCase()].filter(Boolean))];
    let lignesP = [];
    for (const mot of motsCle) { const docP = await getHtml('/AgroAchatProducteur/Index?filter=' + encodeURIComponent(mot) + '&pageSize=200'); lignesP = lignesTable(docP).filter((l) => N(l.c[2]) === N(nomCoop)); if (lignesP.length) break; }
    if (lignesP.length) { const nomP = lignesP[0].c.slice(3, 5).join(' ').trim(); e.fait[6] = 'déjà dans OBC : ' + nomP; journal(e, 'Producteur trouvé : ' + nomP); return 'suivant'; }
    const liste = await getJson('/AppMethods1/LoadAgroProducteursByFournisseurId2?FournisseurId=' + e.ids.fournisseur_id);
    const prods = liste.filter((p) => jsonVal(p) !== '' && jsonTxt(p) !== '');
    if (prods.length) { const nomL = N((lot.producteur.nom || '') + ' ' + (lot.producteur.prenoms || '')); const choisi = prods.find((p) => N(jsonTxt(p)).startsWith(nomL)) || prods[0]; e.ids.producteur_id = jsonVal(choisi); e.fait[6] = 'déjà dans OBC : ' + jsonTxt(choisi); journal(e, 'Producteur trouvé : ' + jsonTxt(choisi)); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(6); if (!f) return 'navigation';
    const p = lot.producteur;
    setEntite(q('#txtid_entiteAdd'));
    setInput(q('#txtproducteur_nomAdd'), p.nom); setInput(q('#txtproducteur_prenomsAdd'), p.prenoms);
    setInput(q('#txtproducteur_matricule_cooperativeAdd'), p.code || lot.cooperative.ccc || ''); setInput(q('#txtproducteur_matricule_regulateurAdd'), p.matricule_ccc || lot.cooperative.ccc || '');
    setRadio('txtproducteur_typeAdd1'); setRadio('txtproducteur_genreAdd1');
    setInput(q('#txtproducteur_localiteAdd'), p.localite);
    await listeStable(q('#txtid_fournisseurAdd'));
    if (!setSelect(q('#txtid_fournisseurAdd'), e.ids.fournisseur_id)) throw new Error('Coopérative (id ' + e.ids.fournisseur_id + ') introuvable dans la liste du producteur');
    setInput(q('#txtproducteur_date_adhesionAdd'), isoDate(lot.connaissement.date));
    setSelect(q('#txtcommodite_idAdd0'), '2'); setInput(q('#txtproducteur_parcelle_codeAdd0'), 'P001');
    setInput(q('#txtparcelle_superficie_totaleAdd0'), '1'); setInput(q('#txtparcelle_superficie_commoditeAdd0'), '1'); setInput(q('#txtparcelle_production_potentielleAdd0'), '1000');
    const manques = await reappliquer(f); if (manques.length) throw new Error('Liste non prise en compte par OBC : ' + manques.join(', '));
    e.note = 'Producteur ' + p.nom + ' ' + p.prenoms + (p.pca ? ' (PCA de la coopérative).' : p.chauffeur ? ' (PCA non renseigné : nom du chauffeur).' : p.fictif ? ' (nom neutre : ni PCA ni producteur dans ORIGEN).' : '.'); return 'rempli';
  }
  // Existence : les pages « Historique » d'OBC acceptent un filtre exact dans l'adresse ; la colonne 4 porte le numéro.
  async function existeDans(page, filtre, colonne, valeur) { if (!filtre) return null; let doc; try { doc = await getHtml(page + '?filter=' + encodeURIComponent(filtre) + '&pageSize=30'); } catch (err) { if (/HTTP 500/.test(String(err && err.message))) return { c: [], illisible: true }; throw err; /* OBC plante à l'affichage d'une ligne : elle est donc bien enregistrée */ } return lignesTable(doc).find((l) => N(l.c[colonne]) === N(valeur)) || null; }
  const existeBrousse = (e) => existeDans('/AgroAchatConnaissementBrousse/Index', e.lot.connaissement.numero, 4, e.lot.connaissement.numero);
  const existeUsine = (e) => existeDans('/AgroAchatConnaissementUsine/Index', e.lot.connaissement.numero, 4, e.lot.connaissement.numero);
  const existePesee = (e) => existeDans('/AgroAchatPeseeBrousse/Index', e.lot.pesee.code, 4, e.lot.pesee.code);
  // Le filtre du bordereau ne porte que sur son propre numéro : on filtre sur le n° CCC (préfixe) et on vérifie la colonne du connaissement.
  const existeBordereau = (e) => existeDans('/AgroAchatBordereauReception/Index', String(e.lot.connaissement.numero || '').split('-')[0], 8, e.lot.connaissement.numero);

  // Ligne modèle : si la coopérative a déjà un connaissement brousse dans OBC, on regarde sa ligne de détail la plus récente
  // pour reprendre le même producteur et la même parcelle (le reste de la ligne est propre à la livraison en cours).
  async function ligneModele(e) {
    try {
      if (!e.ids.fournisseur_id) return null;
      const doc = await getHtml('/AgroAchatConnaissementBrousse/Index?id_entite=' + ENTITE + '&campagne_id=&id_fournisseur=' + encodeURIComponent(e.ids.fournisseur_id) + '&commodite_id=&type_commodite_id=&certification_id=&date_debut_operation=&date_fin_operation=&filter=&pageSize=100');
      const l = lignesTable(doc).find((x) => N(x.c[4]) !== N(e.lot.connaissement.numero) && x.tr.querySelector('a[href*="/Edit/"]'));
      if (!l) return null;
      const ed = await getHtml(l.tr.querySelector('a[href*="/Edit/"]').getAttribute('href'));
      const val = (id) => { const el = ed.getElementById(id); if (!el) return ''; if (el.tagName === 'SELECT') { const o = el.querySelector('option[selected]') || el.options[el.selectedIndex]; return o ? o.value : ''; } return el.value || ''; };
      const m = { numero: l.c[4], producteur: val('txtproducteur_idEdit0'), parcelle: val('txtproducteur_parcelle_idEdit0'), recu: val('txtnumero_recu_achatAdd0') || val('txtnumero_recu_achatEdit0'), sacs: val('txtlivraison_nb_sacsEdit0'), poids: val('txtlivraison_poids_netEdit0') };
      return m.producteur && m.poids ? m : null;
    } catch (err) { return null; }
  }
  async function etapeBrousse(e) {
    const lot = e.lot;
    { const [u, p, b] = await Promise.all([existeUsine(e), existePesee(e), existeBrousse(e)]);
      // Garde-fou : un connaissement sans parcelle fait planter toute la liste d'OBC. On le contrôle dès qu'il est enregistré.
      if (b && b.illisible) throw new Error('OBC plante en affichant ce connaissement : il a sûrement une parcelle vide. Ouvre-le dans OBC (Connaissement brousse > Modifier), choisis la parcelle de la ligne, enregistre, puis « Continuer ».');
      if (b && b.tr) { const a = b.tr.querySelector('a[href*="/Edit/"]'); if (a) { const ed = await getHtml(a.getAttribute('href'));
        const vv = (id) => { const el = ed.getElementById(id); return el ? Number(String(el.value || '').replace(',', '.')) : 1; };
        if (!(vv('txtlivraison_montantEdit0') > 0) || !(vv('txtconnaissement_brousse_montantEdit') > 0) || !(vv('txtconnaissement_brousse_nb_sacsEdit') > 0) || !(vv('txtconnaissement_brousse_poids_netEdit') > 0)) throw new Error('Le connaissement ' + e.lot.connaissement.numero + ' est enregistré avec un montant ou des totaux vides/à 0 : OBC va planter sur sa liste. Ouvre-le (Modifier), retape le prix unitaire de la ligne pour qu\'OBC recalcule, enregistre, puis « Continuer ».');
        const sp = ed.getElementById('txtproducteur_parcelle_idEdit0'); const o = sp && (sp.querySelector('option[selected]') || sp.options[sp.selectedIndex]); if (!o || !o.value) throw new Error('Le connaissement ' + e.lot.connaissement.numero + ' est enregistré SANS parcelle : OBC va planter sur sa liste. Ouvre-le (Modifier), choisis la parcelle de la ligne, enregistre, puis « Continuer ».'); } }
      if (u || p || b) { e.fait[7] = 'déjà dans OBC'; journal(e, 'Connaissement brousse déjà saisi'); return 'suivant'; } }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(7); if (!f) return 'navigation';
    const c = lot.connaissement;
    fixerCampagne(e);
    await listeStable(q('#txtid_fournisseurAdd')); await listeStable(q('#txttype_commodite_idAdd'));
    await setSelectTexte(q('#txtcommodite_idAdd'), /^CACAO/i, 'Commodité');
    await setSelectTexte(q('#txttype_commodite_idAdd'), new RegExp('^' + c.type_commodite, 'i'), 'Type commodité');
    if (c.certification) await setSelectTexte(q('#txtcertification_idAdd'), new RegExp('^' + c.certification, 'i'), 'Certification');
    setInput(q('#txtconnaissement_brousse_numeroAdd'), c.numero); setInput(q('#txtconnaissement_brousse_dateAdd'), isoDate(c.date));
    if (!setSelect(q('#txtid_fournisseurAdd'), e.ids.fournisseur_id)) throw new Error('Coopérative (id ' + e.ids.fournisseur_id + ') absente de la liste Fournisseur du connaissement');
    await listeStable(q('#txtproducteur_idAdd0'));
    const prod = await attendreOption(q('#txtproducteur_idAdd0'), /./); if (!prod) throw new Error('Aucun producteur proposé pour cette coopérative');
    const modele = await ligneModele(e);
    const prodModele = modele && [...q('#txtproducteur_idAdd0').options].find((o) => o.value === modele.producteur);
    // OBC plante à l'affichage de la liste des connaissements si la parcelle n'a pas de code (libellé « - CACAO ») :
    // on retient le premier producteur (modèle, étape 3, puis les autres) dont une parcelle porte un code.
    const selProd = q('#txtproducteur_idAdd0'), selParc = q('#txtproducteur_parcelle_idAdd0');
    const candidats = [...new Set([prodModele && prodModele.value, e.ids.producteur_id && String(e.ids.producteur_id), prod.value].concat([...selProd.options].map((o) => o.value)).filter(Boolean))].filter((v) => [...selProd.options].some((o) => o.value === v)).slice(0, 8);
    let prodRetenu = null, parcRetenue = null;
    for (const v of candidats) {
      setSelect(selProd, v); await dormir(1500);
      const ok = await attendre(() => [...selParc.options].find((o) => o.value !== '' && !/^\s*-/.test(o.text)), 4000, 300);
      if (ok) { prodRetenu = v; parcRetenue = (modele && v === modele.producteur && [...selParc.options].find((o) => o.value === modele.parcelle && !/^\s*-/.test(o.text))) || ok; break; }
    }
    if (!prodRetenu) throw new Error('Aucun producteur de cette coopérative n\'a de parcelle avec un code : OBC ne saurait pas afficher le connaissement. Ajoute une parcelle (ex. P001) à un producteur, puis « Continuer ».');
    setSelect(selParc, parcRetenue.value);
    e.ids.producteur_id = prodRetenu;
    const d = c.detail_arbitraire || {}, repris = !!prodModele && prodRetenu === prodModele.value;
    // Producteur et parcelle : repris à l'identique. Le reste de la ligne (date, reçu, sacs, poids) est propre à CETTE livraison.
    const sacsL = 1, poidsL = 20; // règle d'OBC (Nabi) : un seul producteur, qui livre 1 sac de 20 kg ; les vrais poids sont dans Données livraison / Pesée
    setInput(q('#txtdate_achatAdd0'), isoDate(d.date_achat || c.date)); setInput(q('#txtnumero_recu_achatAdd0'), d.numero_recu || '001');
    setInput(q('#txtlivraison_nb_sacsAdd0'), sacsL); setInput(q('#txtlivraison_poids_netAdd0'), poidsL); setInput(q('#txtlivraison_prix_unitaireAdd0'), num(c.prix_bord_champ));
    if (repris) journal(e, 'Producteur et parcelle repris de ' + modele.numero + ' ; sacs et poids de cette livraison (' + sacsL + ' sacs, ' + poidsL + ' kg)');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    // Montant de la ligne et totaux d'en-tête : OBC les calcule en quittant les champs, mais pas toujours. Vides ou à 0, ils font planter la liste d'OBC : on les force.
    { const pu = num(c.prix_bord_champ), mt = Math.round(Number(poidsL) * Number(pu)), vide = (el) => !el || !(Number(String(el.value).replace(',', '.')) > 0);
      const ligne = q('#txtlivraison_montantAdd0'), hs = q('#txtconnaissement_brousse_nb_sacsAdd'), hp = q('#txtconnaissement_brousse_poids_netAdd'), hm = q('#txtconnaissement_brousse_montantAdd');
      await dormir(600);
      if (vide(ligne)) setInput(ligne, mt); if (vide(hs)) setInput(hs, sacsL); if (vide(hp)) setInput(hp, poidsL); if (vide(hm)) setInput(hm, mt);
      if (mt > 0 && [ligne, hs, hp, hm].some((el) => el && vide(el))) throw new Error('OBC n\'a pas calculé le montant ou les totaux du connaissement (sacs, poids, montant) : ne pas enregistrer. Vérifie les cases à la main.'); }
    e.note = 'Connaissement ' + c.numero + ' (' + c.type_commodite + (c.certification ? ' ' + c.certification : '') + '), prix bord champ ' + c.prix_bord_champ + '.'; return 'rempli';
  }
  // Création d'une origine dans OBC (Agro › Paramétrage › Origine › Nouvelle origine) : ENTITE = ECORIGINE, LIBELLE ORIGINE = CODE = nom de la localité, PRIX UNITAIRE TKM = TKM du connaissement.
  const visible = (el) => !!el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none') && getComputedStyle(el).visibility !== 'hidden';
  const modalOuverte = () => [...document.querySelectorAll('.modal')].filter((m) => getComputedStyle(m).display !== 'none' && m.querySelector('input:not([type=hidden]), select')).pop() || null;
  function champParLibelle(modal, re) {
    const lab = [...modal.querySelectorAll('label, .control-label')].find((l) => re.test(N(l.textContent)));
    if (!lab) return null;
    const direct = lab.htmlFor && modal.querySelector('#' + CSS.escape(lab.htmlFor)); if (direct) return direct;
    let n = lab.parentElement; for (let k = 0; k < 3 && n; k++, n = n.parentElement) { const c = n.querySelector('input:not([type=hidden]):not([type=search]), select, textarea'); if (c) return c; }
    return null;
  }
  // Champs du formulaire « Nouvelle origine » : par libellé, sinon dans l'ordre (entité, libellé, code, TKM).
  function champsOrigine(modal) {
    const sels = [...modal.querySelectorAll('select')];
    const txt = [...modal.querySelectorAll('input')].filter((x) => !/hidden|search|checkbox|radio|button|submit/i.test(x.type) && !x.closest('.bootstrap-select'));
    return { ent: champParLibelle(modal, /^ENTITE/) || sels[0] || null, lib: champParLibelle(modal, /^LIBELLE/) || txt[0] || null, code: champParLibelle(modal, /^CODE$/) || txt[1] || null, prix: champParLibelle(modal, /PRIX UNITAIRE|TKM/) || txt[2] || null };
  }
  const memoOrigines = () => lireFile().origines || [];
  function memoriserOrigine(nom) { const f = lireFile(); f.origines = [...new Set((f.origines || []).concat([N(nom)]))]; ecrireFile(f); }
  // etapeRetour : 'suite' quand l'origine est faite en tout début de lot (on enchaîne sur l'étape 1) ; sinon retour à la page des données livraison.
  const memoUsines = () => lireFile().usines || [];
  function memoriserUsine(code) { const f = lireFile(); f.usines = [...new Set((f.usines || []).concat([String(code).toUpperCase()]))]; ecrireFile(f); }
  // Création d'un élément de référentiel OBC : 'origine' (entité, libellé, code, TKM) ou 'usine' (entité, libellé, code). L'élément est d'abord cherché dans la liste.
  // Création d'un élément de référentiel OBC sur sa page : 'origine' (entité, libellé = code, TKM) ou 'usine' (entité, libellé, code). Cherche d'abord dans la liste. Renvoie 'existe' ou 'cree'.
  async function creerElement(e, type, it) {
    const usine = type === 'usine', LIB = usine ? 'Nouvelle usine' : 'Nouvelle origine', LABEL = usine ? 'Usine' : 'Origine';
    const nom = it.nom, codeVal = it.code, tkm = it.tkm;
    const cle = usine ? codeVal : nom;
    const dansTable = () => [...document.querySelectorAll('table tbody td')].some((td) => N(td.textContent) === N(cle));
    await attendre(() => document.querySelector('table tbody tr') || /aucun|no data|pas de donn/i.test(document.body.innerText), 15000, 400); await dormir(1000);
    // La liste d'OBC est paginée : si le nom n'est pas sur la page affichée, on le cherche avec la zone de recherche de la liste.
    const existeRecherche = async () => {
      if (dansTable()) return true;
      const rech = [...document.querySelectorAll('input[type=search], .dataTables_filter input, input[placeholder*="echerche" i], input[name*="search" i], input[id*="search" i], input[id*="filter" i]')].find((x) => visible(x) && !x.closest('.modal') && !x.closest('#origen-obc'));
      if (!rech) return false;
      setInput(rech, cle); rech.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' })); rech.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
      await attendre(() => dansTable(), 6000, 400); const ok = dansTable(); setInput(rech, ''); return ok;
    };
    if (await existeRecherche()) return 'existe';
    if (!modalOuverte()) {
      const cands = [...document.querySelectorAll('a, button')].filter((b) => visible(b) && !b.closest('#origen-obc') && !b.closest('.modal'));
      const btn = cands.find((b) => new RegExp(usine ? 'Usine/(Create|Add)' : 'Origine/(Create|Add)', 'i').test(b.getAttribute('href') || '')) || cands.find((b) => /^(NOUVEAU|NOUVELLE|AJOUTER|CREER)\b/.test(N(b.textContent))) || cands.find((b) => /nouv|create|add/i.test(b.id));
      if (!btn) throw new Error('Bouton « Nouveau » introuvable sur la page « ' + LABEL + ' ». Boutons vus : ' + cands.map((b) => (b.textContent || '').trim().slice(0, 20)).filter(Boolean).slice(0, 15).join(' | '));
      journal(e, LABEL + ' : clic sur « ' + (btn.textContent || btn.id || '').trim().slice(0, 30) + ' »'); btn.click();
    }
    const modal = await attendre(() => modalOuverte(), 25000, 300);
    if (!modal) throw new Error('Le formulaire « ' + LIB + ' » ne s\'est pas ouvert (aucune fenêtre visible après le clic)');
    await attendre(() => { const c = champsOrigine(modal); return c.lib && c.code && (usine || c.prix); }, 8000, 300); await dormir(600);
    const { ent, lib, code, prix } = champsOrigine(modal);
    if (!lib || !code || (!usine && !prix)) throw new Error('Formulaire « ' + LIB + ' » : cases introuvables (libellé ' + !!lib + ', code ' + !!code + ', TKM ' + !!prix + '). Contenu : ' + modal.innerText.replace(/\s+/g, ' ').slice(0, 160));
    if (ent && ent.tagName === 'SELECT') { await setSelectTexte(ent, /^ECORIGINE/i, 'Entité'); await dormir(1500); }
    // OBC peut vider les cases après le choix de l'entité : on remplit, on attend, on revérifie (3 passes) avant d'enregistrer.
    const ok3 = () => lib.value === nom && code.value === codeVal && (usine || Number(String(prix.value).replace(',', '.')) === Number(tkm));
    for (let passe = 0; passe < 3 && !ok3(); passe++) { setInput(lib, nom); setInput(code, codeVal); if (prix) setInput(prix, tkm); await dormir(1200); }
    { const entTxt = ent && ent.tagName === 'SELECT' ? ((ent.options[ent.selectedIndex] || {}).text || '') : '(sans liste)';
      if (ent && ent.tagName === 'SELECT' && !/^ECORIGINE/i.test(entTxt)) throw new Error(LIB + ' : l\'entité n\'a pas pris ECORIGINE (« ' + entTxt + ' »), rien n\'est enregistré');
      if (!ok3()) throw new Error(LIB + ' : cases vidées par OBC (libellé « ' + lib.value + ' », code « ' + code.value + ' », TKM « ' + prix.value + ' »), rien n\'est enregistré');
      journal(e, LIB + ' : entité ' + entTxt + ', libellé ' + nom + ', code ' + codeVal + (usine ? '' : ', TKM ' + tkm)); }
    const auto = e.enFile && lireFile().auto !== false;
    const bt = () => [...modal.querySelectorAll('button, input[type=submit]')].find((b) => /enregistrer/i.test(b.textContent || b.value || ''));
    if (auto) {
      const b = await attendre(() => { const x = bt(); return x && !x.disabled ? x : null; }, 6000, 300);
      if (!b) throw new Error('Bouton « Enregistrer » de « ' + LIB + ' » inactif ou introuvable. ' + erreurVisible());
      journal(e, LABEL + ' « ' + nom + ' » : enregistrement automatique'); b.click(); confirmerBoite();
    } else { e.note = LABEL + ' « ' + nom + ' » remplie : clique « Enregistrer » dans OBC.'; ecrireEtat(e); afficherEtat(); }
    // Enregistrement réussi = la fenêtre se ferme sans message d'erreur ; la présence réelle de l'origine est de toute façon revérifiée dans la liste du formulaire « Données livraison ».
    const t0 = Date.now(); let ferme = false;
    while (Date.now() - t0 < (auto ? 20000 : 300000)) {
      if (!modalOuverte()) { ferme = true; break; }
      if (/exist|d[ée]j[àa]|doublon|unique|already/i.test(erreurVisible())) break;      // OBC refuse un doublon : l'origine existe, c'est ce qu'on voulait
      await dormir(500);
    }
    if (!ferme) {
      const msg = erreurVisible();
      const fermer = modalOuverte() && [...modalOuverte().querySelectorAll('button, a')].find((b) => /fermer|annuler|close/i.test(b.textContent || ''));
      if (fermer) { fermer.click(); await dormir(1500); }
      if (/exist|d[ée]j[àa]|doublon|unique|already/i.test(msg) || await existeRecherche()) { journal(e, LABEL + ' « ' + nom + ' » existe déjà dans OBC (' + (msg || 'vue dans la liste') + ')'); return 'existe'; }
      throw new Error(LABEL + ' « ' + nom + ' » non enregistrée : la fenêtre est restée ouverte. ' + msg);
    }
    await dormir(1500);
    return 'cree';
  }
  const usinesDuLot = (e, tout) => {
    const c0 = e.lot.connaissement, vu = new Set(), r = [];
    [{ code: c0.usine_code, nom: c0.usine_nom }].concat(tout ? (c0.usines_toutes || []) : []).forEach((u) => { const code = String(u.code || '').trim().toUpperCase(), nom = String(u.nom || u.code || '').trim().toUpperCase(); if (code && nom && !vu.has(code)) { vu.add(code); r.push({ code, nom }); } });
    return r;
  };
  const usinesManquantes = (e) => usinesDuLot(e, true).filter((u) => !memoUsines().includes(u.code));
  function urlReferentiel(type) {
    if (type === 'origine') return '/AgroParametrage/ParametrageOrigine';
    const f = lireFile(); if (f.urlUsine) return f.urlUsine;
    const l = [...document.querySelectorAll('a[href]')].find((x) => !x.closest('#origen-obc') && /^USINES?$/.test(N(x.textContent)) && !/Connaissement|Achat|Pesee/i.test(x.getAttribute('href')) && x.getAttribute('href') !== '#' && !/^javascript/i.test(x.getAttribute('href')));
    return l ? l.getAttribute('href') : '/AgroParametrage/ParametrageUsine';
  }
  // Étape préalable / de secours : crée dans OBC les usines (toutes celles d'ORIGEN) ou l'origine du lot, puis enchaîne.
  async function sousEtapeOrigine(e) {
    const type = e.sous || 'origine', usine = type === 'usine', c0 = e.lot.connaissement;
    const fin = () => {
      e.sous = null; if (usine) e.usinesOk = true; else e.origineOk = true; ecrireEtat(e);
      if (e.preEtape) return 'suite';
      journal(e, (usine ? 'Usine' : 'Origine') + ' prête : retour aux données livraison'); location.href = PAGES[7]; return 'navigation';
    };
    const page = urlReferentiel(type);
    if (location.pathname.toLowerCase() !== page.split('?')[0].toLowerCase()) { journal(e, (usine ? 'Usines' : 'Origine') + ' : ouverture de ' + page); location.href = page; return 'navigation'; }
    await attendre(() => document.querySelector('table tbody tr') || /aucun|no data|pas de donn/i.test(document.body.innerText), 15000, 400); await dormir(1000);
    if (usine) {
      const liste = e.preEtape ? usinesManquantes(e) : usinesDuLot(e, false);
      if (!liste.length) return fin();
      const f0 = lireFile(); f0.urlUsine = location.pathname; ecrireFile(f0);
      journal(e, 'Usines à vérifier dans OBC : ' + liste.map((u) => u.code).join(', '));
      for (const u of liste) {
        const r = await creerElement(e, 'usine', u);
        memoriserUsine(u.code); journal(e, 'Usine « ' + u.nom + ' - ' + u.code + ' » : ' + (r === 'cree' ? 'créée' : 'déjà présente'));
        await dormir(800);
      }
      return fin();
    }
    const nom = String(c0.origine || '').trim().toUpperCase();
    if (!nom) throw new Error('Origine vide dans ORIGEN');
    const r = await creerElement(e, 'origine', { nom, code: nom, tkm: num(c0.tkm) });
    memoriserOrigine(nom); journal(e, 'Origine « ' + nom + ' » : ' + (r === 'cree' ? 'créée' : 'déjà présente'));
    return fin();
  }
  async function etapeLivraison(e) {
    const lot = e.lot;
    { const [u, p] = await Promise.all([existeUsine(e), existePesee(e)]); if (u || p) { e.fait[8] = 'déjà dans OBC'; journal(e, 'Données livraison déjà saisies'); return 'suivant'; } }
    if (e.sous) return sousEtapeOrigine(e);
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(8); if (!f) return 'navigation';
    const c = lot.connaissement;
    fixerCampagne(e);
    await listeStable(q('#txtconnaissement_brousse_idAdd')); await listeStable(q('#txttransporteur_idAdd')); await listeStable(q('#txtorigine_idAdd'));
    await setSelectTexte(q('#txtcampagne_recolte_idAdd'), new RegExp('^' + lot.campagne.recolte, 'i'), 'Récolte');
    await setSelectTexte(q('#txtconnaissement_brousse_idAdd'), c.numero, 'Connaissement brousse');
    await dormir(1500);
    // OBC remplit normalement commodité, type, certification et fournisseur à partir du connaissement brousse, mais pas toujours
    // (ou sans rafraîchir l'affichage) : on les renseigne nous-mêmes, comme dans le connaissement brousse.
    { const cm = q('#txtcommodite_idAdd'); if (cm) await setSelectTexte(cm, /^CACAO/i, 'Commodité');
      await dormir(600); await listeStable(q('#txttype_commodite_idAdd'));
      await setSelectTexte(q('#txttype_commodite_idAdd'), new RegExp('^' + c.type_commodite, 'i'), 'Type commodité');
      if (c.certification) await setSelectTexte(q('#txtcertification_idAdd'), new RegExp('^' + c.certification, 'i'), 'Certification');
      if (e.ids.fournisseur_id && !setSelect(q('#txtid_fournisseurAdd'), e.ids.fournisseur_id)) throw new Error('Coopérative (id ' + e.ids.fournisseur_id + ') absente de la liste Fournisseur des données livraison');
      await dormir(800);
      const cb = q('#txtconnaissement_brousse_idAdd'); if (cb && !cb.value) { await setSelectTexte(cb, c.numero, 'Connaissement brousse'); await dormir(1200); } }
    setInput(q('#txtconnaissement_usine_dateAdd'), isoDate(c.date));
    if (!q('#txtconnaissement_usine_numeroAdd').value) setInput(q('#txtconnaissement_usine_numeroAdd'), c.numero);
    { const selO = q('#txtorigine_idAdd'); await listeStable(selO);
      if (!selO || selO.options.length <= 1) throw new Error('OBC ne répond pas : la liste des origines est vide (non chargée), rien n\'est créé');
      const oO = await attendre(() => optionParTexte(selO, exact(c.origine)), 5000, 300);
      if (!oO) {
        // L'origine n'existe pas encore dans OBC (référentiel à part) : on la crée (entité ECORIGINE, libellé = code = localité, TKM du connaissement), puis on revient ici.
        if (!c.origine) throw new Error('Origine du connaissement vide dans ORIGEN');
        if (e.origineEssayee) throw new Error('Origine « ' + c.origine + ' » toujours absente de la liste après sa création');
        e.origineEssayee = true; e.sous = 'origine'; ecrireEtat(e); journal(e, 'Origine « ' + c.origine + ' » absente d\'OBC : création');
        location.href = '/AgroParametrage/ParametrageOrigine'; return 'navigation';
      }
      setSelect(selO, oO.value); }
    setInput(q('#txtconnaissement_usine_cout_tkmAdd'), num(c.tkm));
    await setSelectTexte(q('#txtdestination_idAdd'), exact(c.destination), 'Destination', c.destination);
    const nomTr = e.ids.transporteur_nom || e.ids.transporteur_nouveau; if (nomTr) await setSelectTexte(q('#txttransporteur_idAdd'), exact(nomTr), 'Transporteur', nomTr);
    await dormir(600);
    if (!q('#txtconnaissement_immatriculation_vehiculeAdd').value) setInput(q('#txtconnaissement_immatriculation_vehiculeAdd'), lot.transporteur.immat_vehicule);
    if (!q('#txtconnaissement_immatriculation_remorqueAdd').value) setInput(q('#txtconnaissement_immatriculation_remorqueAdd'), lot.transporteur.immat_remorque);
    if (!q('#txtconnaissement_nom_chauffeurAdd').value) setInput(q('#txtconnaissement_nom_chauffeurAdd'), lot.transporteur.chauffeur);
    { const selU = q('#txtusine_idAdd'); await listeStable(selU);
      const reU = new RegExp('-\\s*' + c.usine_code + '\\s*$', 'i');
      if (selU && selU.options.length > 1 && !(await attendre(() => optionParTexte(selU, reU), 4000, 300))) {
        if (e.usineEssayee) throw new Error('Usine « ' + c.usine_code + ' » toujours absente de la liste après sa création');
        e.usineEssayee = true; e.sous = 'usine'; ecrireEtat(e); journal(e, 'Usine « ' + c.usine_code + ' » absente d\'OBC : création');
        location.href = urlReferentiel('usine'); return 'navigation';
      }
      await setSelectTexte(selU, reU, 'Usine'); }
    setInput(q('#txtconnaissement_usine_nb_sacs_chargeAdd'), c.sacs_declares); setInput(q('#txtconnaissement_usine_nb_sacs_receptionneAdd'), c.sacs_declares);
    setInput(q('#txtconnaissement_usine_poids_brut_chargeAdd'), c.poids_brut_declare || ''); setInput(q('#txtconnaissement_usine_poids_refactionAdd'), '0');
    ['nb_sacs_charge', 'poids_brut_charge'].forEach((k) => { const el = q('#txtconnaissement_usine_' + k + 'Add'); if (el) el.dispatchEvent(new Event('focusout', { bubbles: true })); });
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Livraison ' + c.numero + ' : ' + c.sacs_declares + ' sacs, brut déclaré ' + (c.poids_brut_declare || '?') + ', TKM ' + c.tkm + ', usine ' + c.usine_code + '.'; return 'rempli';
  }
  async function etapePesee(e) {
    const lot = e.lot;
    if (await existePesee(e)) { e.fait[9] = 'déjà dans OBC'; journal(e, 'Pesée déjà saisie'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(9); if (!f) return 'navigation';
    const p = lot.pesee, c = lot.connaissement;
    fixerCampagne(e);
    await listeStable(q('#txtconnaissement_usine_idAdd')); await listeStable(q('#txtqualite_idAdd'));
    await setSelectTexte(q('#txtconnaissement_usine_idAdd'), c.numero, 'Connaissement usine');
    await dormir(1500);
    setInput(q('#txtpesee_brousse_dateAdd'), isoDate(p.date || c.date)); setInput(q('#txtpesee_brousse_numeroAdd'), p.code);
    setInput(q('#txtpesee_brousse_poids_entreeAdd'), num(p.poids_entree)); setInput(q('#txtpesee_brousse_poids_sortieAdd'), num(p.poids_sortie));
    if (p.date_entree) setInput(q('#txtpesee_brousse_date_entreeAdd'), p.date_entree); if (p.date_sortie) setInput(q('#txtpesee_brousse_date_sortieAdd'), p.date_sortie);
    if (p.pont) { setInput(q('#txtpesee_brousse_pont_entreeAdd'), p.pont); setInput(q('#txtpesee_brousse_pont_sortieAdd'), p.pont); }
    // rubriques qualité : celles qu'OBC connaît pour le cacao
    const rubs = await getJson('/AppMethods1/LoadAgroRubriquesQualiteByCommoditeId?CommoditeId=2');
    const paires = []; (p.qualite || []).forEach((qv) => { const r = rubs.find((x) => { const a = N(x.Text).replace(/\s*\[.*$/, ''), b = N(qv.rubrique); return a === b || a.startsWith(b) || b.startsWith(a); }); if (r && qv.valeur != null && !paires.some((x) => x.id === r.Value)) paires.push({ id: r.Value, valeur: num(qv.valeur), lib: r.Text }); });
    for (let i = 0; i < paires.length; i++) {
      if (i > 0 && !q('#txtcommodite_rubriques_qualite_idAdd' + i)) { const b = q('#btnNewLineDetailsRubriqueQualitePeseeBrousse'); if (b) b.click(); await attendre(() => q('#txtcommodite_rubriques_qualite_idAdd' + i), 5000); }
      const sel = q('#txtcommodite_rubriques_qualite_idAdd' + i); if (!sel) break;
      await attendreOption(sel, /./); setSelect(sel, paires[i].id); setInput(q('#txtcommodite_rubriques_qualite_valeurAdd' + i), paires[i].valeur);
    }
    // Réfaction (retenue de poids pour qualité) : celle du SAIGIC ; à défaut brut − tare − net payé attendu.
    const refac = Number(p.refaction) > 0 ? Number(p.refaction) : Math.max(0, Math.round(((Number(num(p.poids_entree)) - Number(num(p.poids_sortie))) - Number(num(p.tare_sacs)) - (Number(p.poids_net_paye_attendu) || 0)) * 100) / 100);
    setInput(q('#txtpesee_brousse_sacs_dechargesAdd'), p.sacs_decharges != null ? p.sacs_decharges : p.sacs_acceptes); setInput(q('#txtpesee_brousse_sacs_acceptesAdd'), p.sacs_acceptes);
    setInput(q('#txtpesee_brousse_tare_sacs_acceptesAdd'), num(p.tare_sacs)); setInput(q('#txtpesee_brousse_tare_palettesAdd'), '0'); setInput(q('#txtpesee_brousse_poids_refactionAdd'), String(refac));
    if (p.classement) await setSelectTexte(q('#txtqualite_idAdd'), exact(p.classement), 'Classement', p.classement);
    ['poids_entree', 'poids_sortie', 'sacs_decharges', 'sacs_acceptes', 'tare_sacs_acceptes', 'tare_palettes', 'poids_refaction'].forEach((k) => { const el = q('#txtpesee_brousse_' + k + 'Add'); if (el) el.dispatchEvent(new Event('focusout', { bubbles: true })); });
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Pesée ' + p.code + ' : entrée ' + p.poids_entree + ' / sortie ' + p.poids_sortie + ', ' + paires.length + ' rubriques qualité, ' + p.classement + '. Poids net payé attendu : ' + p.poids_net_paye_attendu + '.'; return 'rempli';
  }
  async function etapeBordereau(e) {
    const lot = e.lot, b = lot.bordereau;
    if (await existeBordereau(e)) { e.fait[10] = 'déjà dans OBC'; journal(e, 'Bordereau déjà saisi'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(10); if (!f) return 'navigation';
    fixerCampagne(e);
    await listeStable(q('#txtpesee_brousse_idAdd'));
    await setSelectTexte(q('#txtpesee_brousse_idAdd'), lot.pesee.code, 'Pesée brousse');
    await dormir(1500);
    setInput(q('#txtbordereau_reception_dateAdd'), isoDate(b.date)); setInput(q('#txtbordereau_reception_numeroAdd'), b.numero);
    setInput(q('#txtbordereau_reception_pu_commoditeAdd'), num(b.pu_commodite)); setInput(q('#txtbordereau_reception_retenue_pu_bicAdd'), num(b.pu_bic));
    setInput(q('#txtbordereau_reception_retenue_pu_mandatAdd'), '0'); setInput(q('#txtbordereau_reception_retenue_pu_miseencompteAdd'), '0');
    setInput(q('#txtbordereau_reception_retenue_pu_revolvingAdd'), num(b.pu_revolving || 0)); setInput(q('#txtbordereau_reception_retenue_pu_avanceAdd'), '0');
    setInput(q('#txtbordereau_reception_gain_pu_commissionAdd'), num(b.pu_commission || 0)); setInput(q('#txtbordereau_reception_gain_pu_transportAdd'), num(b.pu_transport));
    // Comptabilisation (livraison produit, facturation) : valeurs par défaut d'OBC, on n'y touche JAMAIS.
    await dormir(1200);
    { const m = await reappliquer(f, 800); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    // Le prix est celui d'ORIGEN (campagne) : on le FORCE, puis on vérifie les calculs d'OBC (montant brut, retenue BIC, net à payer) et on recommence si OBC n'a pas recalculé.
    const lire = (suffixe) => { const el = q('#txtbordereau_reception_' + suffixe + 'Add'), lb = q('#lblbordereau_reception_' + suffixe + 'Add'); const brut = el && el.value !== '' ? el.value : (lb ? lb.textContent : ''); const v = Number(String(brut).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')); return isFinite(v) ? v : NaN; };
    const netPaye = Number(lot.pesee.poids_net_paye_attendu) || 0, pu = Number(num(b.pu_commodite)) || 0;
    const r2 = (x) => Math.round(x * 100) / 100, puN = (k) => Number(num(b[k] || 0)) || 0;
    const att = { brut: r2(netPaye * pu), bic: r2(netPaye * puN('pu_bic')), revolving: r2(Number(b.montant_revolving) || 0), commission: r2(netPaye * puN('pu_commission')), transport: r2(netPaye * puN('pu_transport')), net: b.net_attendu == null ? null : r2(b.net_attendu) };
    const CHAMPS = [['montant_commodite', 'brut', 'Montant brut'], ['retenue_montant_bic', 'bic', 'Retenue BIC'], ['retenue_montant_revolving', 'revolving', 'Retenue revolving'], ['gain_montant_commission', 'commission', 'Commission'], ['gain_montant_transport', 'transport', 'Transport'], ['montant_net', 'net', 'Net à payer']];
    const PUS = ['pu_commodite', 'retenue_pu_bic', 'retenue_pu_mandat', 'retenue_pu_miseencompte', 'retenue_pu_revolving', 'retenue_pu_avance', 'gain_pu_commission', 'gain_pu_transport'];
    // revolving et net : au centime près (le revolving doit être EXACTEMENT le montant de l'avance retenue, ex. 20 000 000) ; les autres cases : à 1 FCFA près
    const bon = (v, w, tol) => w == null || (isFinite(v) && Math.abs(v - w) < (tol || 1));
    const TOL = { revolving: 0.005, net: 0.005 };
    const toutBon = () => CHAMPS.every(([s, k]) => bon(lire(s), att[k], TOL[k]));
    let tentatives = 0;
    for (; tentatives < 4; tentatives++) {
      const puEl = q('#txtbordereau_reception_pu_commoditeAdd'); if (puEl && Number(num(puEl.value)) !== pu) setInput(puEl, num(b.pu_commodite));
      PUS.forEach((k) => { const el = q('#txtbordereau_reception_' + k + 'Add'); if (el) { el.dispatchEvent(new Event('focusout', { bubbles: true })); try { el.focus(); el.blur(); } catch (er) { /* ignoré */ } } });
      await dormir(700);
      if (toutBon()) break;
    }
    // Si OBC n'a pas calculé une case (montant, retenue, net), on y écrit nous-mêmes la valeur d'ORIGEN, dans la case ET dans son affichage.
    const corriges = [];
    CHAMPS.forEach(([s, k, nom]) => {
      const w = att[k]; if (w == null || bon(lire(s), w, TOL[k])) return;
      const el = q('#txtbordereau_reception_' + s + 'Add'), lb = q('#lblbordereau_reception_' + s + 'Add');
      if (el) { const virg = !/\./.test(el.value || ''); /* OBC stocke ses montants avec la virgule (59577,50) */ el.value = virg ? String(w).replace('.', ',') : String(w); ['input', 'change'].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true }))); }
      if (lb) lb.textContent = w.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
      corriges.push(nom);
    });
    if (corriges.length) { journal(e, 'Cases forcées avec la valeur ORIGEN : ' + corriges.join(', ')); await dormir(300); }
    const fr = (x) => isFinite(x) ? x.toLocaleString('fr-FR') : '?';
    const vb = lire('montant_commodite'), vn = lire('montant_net');
    const verif = toutBon()
      ? ' ✓ Cases vérifiées = ORIGEN : brut ' + fr(vb) + ' (' + netPaye.toLocaleString('fr-FR') + ' kg × ' + pu + '), BIC ' + fr(lire('retenue_montant_bic')) + ', revolving ' + fr(lire('retenue_montant_revolving')) + ', net à payer ' + fr(vn) + '.' + (corriges.length ? ' (OBC n\'avait pas calculé : ' + corriges.join(', ') + ' — valeurs saisies par le robot.)' : '')
      : ' ⚠ Cases ≠ ORIGEN : brut ' + fr(vb) + ' (attendu ' + fr(att.brut) + '), revolving ' + fr(lire('retenue_montant_revolving')) + ' (attendu ' + fr(att.revolving) + '), net à payer ' + fr(vn) + ' (attendu ' + fr(att.net) + ') : ne pas enregistrer avant vérification.';
    e.note = 'Bordereau ' + b.numero + ' : PU ' + b.pu_commodite + ', BIC ' + b.pu_bic + ', transport ' + b.pu_transport + (b.montant_revolving ? ', revolving ' + b.montant_revolving : '') + '.' + verif; return 'rempli';
  }
  const EXEC = [etapeGrosTraitantTiers, etapeGrosTraitant, etapeCompteTiers, etapeCooperative, etapeTransporteur, etapeProducteur, etapeBrousse, etapeLivraison, etapePesee, etapeBordereau];

  // ---------- boucle ----------
  let enCours = false;
  async function boucle() {
    if (enCours) return; enCours = true;
    try {
      veille.demarrer();
      let e = lireEtat();
      if ((!e || e.statut === 'termine') && fileActive()) { if (!(await suivantFile())) return; e = lireEtat(); }
      if (!e || e.pause || e.statut === 'termine') return;
      if (!connecte()) { e.erreur = 'Connecte-toi à OBC, puis « Continuer ».'; ecrireEtat(e); afficherEtat(); return; }
      for (let garde = 0; garde < 25; garde++) {
        e = lireEtat(); if (!e || e.pause) return;
        if (e.etape > NB_ETAPES) {
          if (e.enFile) { await finLotFile(e); return; }
          try { const r = await existeBordereau(e); const lien = r && r.tr && r.tr.querySelector('a[href*="RptAgroAchatBordereauReceptionViewer"]'); if (lien) e.urlImpression = lien.getAttribute('href'); } catch (er) { /* lien facultatif */ } e.statut = 'termine'; e.note = 'Dans ORIGEN, sous cette livraison, clique « déjà saisi » pour la marquer OBC ✓ (n° de bordereau : ' + (e.lot.bordereau && e.lot.bordereau.numero || '') + ').'; ecrireEtat(e); afficherEtat(); if (e.lot && e.lot.achat_id && !e.imprime) { e.imprime = true; ecrireEtat(e); setTimeout(() => { location.href = ORIGEN_URL + '#bordereau=' + encodeURIComponent(e.lot.achat_id); }, 2000); } return; }
        if (e.statut === 'attente_enregistrement') {
          // le formulaire est rempli et enregistré (par le robot ou par l'utilisateur) : on vérifie toutes les 4 s
          let res;
          try { res = await EXEC[e.etape - 1](e); }
          catch (err) {
            const msg = err && err.message ? err.message : String(err);
            e.verifErr = (e.verifErr || 0) + 1;
            if (e.enFile && e.verifErr >= 8) { await echecLot(e, msg); return; }
            e.erreur = ETAPES[e.etape - 1] + ' (vérification) : ' + msg; ecrireEtat(e); afficherEtat(); dormir(8000).then(boucle); return;
          }
          if (e.erreur) { e.erreur = null; }
          if (res === 'suivant') { e.statut = 'a_faire'; e.note = ''; e.etape++; delete e.t_save; delete e.cliques; delete e.verifErr; ecrireEtat(e); afficherEtat(); continue; }
          if (e.enFile && e.t_save && lireFile().auto !== false) {
            const ecoule = Date.now() - e.t_save;
            if (ecoule > 90000) { await echecLot(e, 'enregistrement automatique sans effet après 90 s. ' + erreurVisible()); return; }
            if (ecoule > 30000 && (e.cliques || 0) < 2) { const b = boutonEnregistrer(e.etape); if (b && !b.disabled) { e.cliques = (e.cliques || 0) + 1; ecrireEtat(e); journal(e, 'Nouvel essai d\'enregistrement'); b.click(); confirmerBoite(); } }
          }
          ecrireEtat(e); afficherEtat(); dormir(e && e.enFile ? 1500 : 4000).then(boucle); return;
        }
        if (e.statut === 'verifier') e.statut = 'a_faire';
        // Tout premier élément de la chaîne : l'origine du camion existe-t-elle dans OBC ? Sinon on la crée, puis on enchaîne.
        if (e.enFile && e.etape === 1 && !e.sous && !(e.usinesOk && e.origineOk)) {
          const nomO = String(e.lot.connaissement.origine || '').trim();
          if (!e.usinesOk && usinesManquantes(e).length) { e.sous = 'usine'; e.preEtape = true; }
          else {
            e.usinesOk = true;
            if (!nomO || memoOrigines().includes(N(nomO))) { e.origineOk = true; e.preEtape = false; } else { e.sous = 'origine'; e.preEtape = true; }
          }
          ecrireEtat(e);
        }
        if (e.sous) {
          try { const r = await sousEtapeOrigine(e); if (r === 'navigation') return; continue; }
          catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (e.enFile) { if (transitoire(msg) && (e.retries || 0) < 30) { e.retries = (e.retries || 0) + 1; journal(e, 'Erreur passagère, nouvel essai dans 20 s : ' + msg); dormir(20000).then(boucle); return; } e.etape = e.etape; await echecLot(e, (e.sous === 'usine' ? 'usine : ' : 'origine : ') + msg); return; }
            e.erreur = 'Origine : ' + msg; journal(e, 'Erreur : ' + e.erreur); return;
          }
        }
        e.erreur = null; ecrireEtat(e); afficherEtat();
        let res;
        try { res = await EXEC[e.etape - 1](e); }
        catch (err) {
          const msg = err && err.message ? err.message : String(err);
          if (e.enFile) {
            if (transitoire(msg) && (e.retries || 0) < 30) { e.retries = (e.retries || 0) + 1; e.erreur = ETAPES[e.etape - 1] + ' : ' + msg; journal(e, 'Erreur passagère, nouvel essai dans 20 s : ' + msg); dormir(20000).then(boucle); return; }
            await echecLot(e, msg); return;
          }
          e.erreur = ETAPES[e.etape - 1] + ' : ' + msg; journal(e, 'Erreur : ' + e.erreur); return;
        }
        if (res === 'suivant') { e.statut = 'a_faire'; e.etape++; e.note = ''; ecrireEtat(e); afficherEtat(); continue; }
        if (res === 'rempli') {
          e.statut = 'attente_enregistrement'; journal(e, ETAPES[e.etape - 1] + ' : formulaire rempli' + (e.enFile && lireFile().auto !== false ? '' : ', en attente d\'Enregistrer'));
          if (e.enFile && lireFile().auto !== false) { if (!(await enregistrerAuto(e))) return; }
          dormir(e && e.enFile ? 1500 : 4000).then(boucle); return;
        }
        if (res === 'navigation') return;          // la page change : le script reprend au chargement
        if (res === 'stop') { ecrireEtat(e); afficherEtat(); return; }
        if (res === 'attendre') { ecrireEtat(e); afficherEtat(); dormir(e && e.enFile ? 1500 : 4000).then(boucle); return; }
      }
    } finally { enCours = false; }
  }

  // Page d'impression du bordereau (ouverte par le robot avec #origen-imprimer) : clique « Actions » puis « Imprimer le rapport » ; l'utilisateur prend ensuite la main.
  if (/RptAgroAchatBordereauReceptionViewer/.test(location.pathname) && location.hash === '#origen-imprimer') {
    let essais = 0;
    const t = setInterval(() => {
      const menu = document.getElementById('dropdownMenu1'), imp = document.getElementById('printBtn');
      if (++essais > 60) { clearInterval(t); return; }
      if (!menu || !imp) return;
      clearInterval(t);
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => { try { menu.click(); } catch (er) { /* ignoré */ } setTimeout(() => imp.click(), 400); }, 2500);
    }, 1000);
    return;
  }
  creerPanneau();
  dormir(1200).then(boucle);
})();
