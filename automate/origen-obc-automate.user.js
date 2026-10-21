// ==UserScript==
// @name         ORIGEN → OBC (automate de saisie des achats)
// @namespace    https://nabiouague-cpu.github.io/eco-traca/
// @version      0.1.14
// @description  Renseigne l'ERP OBC (onpointsunrise.com) à partir d'un lot copié depuis ORIGEN : coopérative, transporteur, producteur, connaissement brousse, données livraison, pesée, bordereau. Cherche avant de créer, remplit chaque écran et s'arrête avant « Enregistrer » pour validation.
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
  const VERSION = '0.1.14';
  const CLE = 'origen_obc_etat';
  const ENTITE = '1';                 // ECORIGINE
  const ATTENTE_MAX = 20000;
  const ETAPES = ['Coopérative', 'Transporteur', 'Producteur', 'Connaissement brousse', 'Données livraison', 'Pesée', 'Bordereau de réception'];
  const PAGES = ['/Fournisseur/Index', '/AgroParametrage/ParametrageTransporteur', '/AgroAchatProducteur/Index', '/AgroAchatConnaissementBrousse/Index', '/AgroAchatConnaissementUsine/Index', '/AgroAchatPeseeBrousse/Index', '/AgroAchatBordereauReception/Index'];
  const BTN_NOUVEAU = ['a[href="/Fournisseur/Create"]', 'a[href="/AgroParametrageTransporteur/Create"]', 'a[href="/AgroAchatProducteur/Create"]', 'a[href="/AgroAchatConnaissementBrousse/Create"]', 'a[href="/AgroAchatConnaissementUsine/Create"]', 'a[href="/AgroAchatPeseeBrousse/Create"]', 'a[href="/AgroAchatBordereauReception/Create"]'];
  const FORMS = ['#formCreateEditFournisseur', '#frmAgroParametrageTransporteurCreate', '#frmAgroAchatProducteurCreate', '#frmAgroAchatConnaissementBrousseCreate', '#frmAgroAchatConnaissementUsineCreate', '#frmAgroAchatPeseeBrousseCreate', '#frmAgroAchatBordereauReceptionCreate'];

  const N = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const PLAQUE = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => { const t = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.'); if (t === '') return ''; const n = Number(t); return isFinite(n) ? String(n) : ''; };
  const isoDate = (fr) => { const m = String(fr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
  const $ = () => window.jQuery;

  // ---------- état (localStorage) ----------
  function lireEtat() { try { return JSON.parse(localStorage.getItem(CLE) || 'null'); } catch (e) { return null; } }
  function ecrireEtat(e) { localStorage.setItem(CLE, JSON.stringify(e)); }
  function effacerEtat() { localStorage.removeItem(CLE); }
  function journal(e, texte) { e.journal = (e.journal || []).concat([new Date().toLocaleTimeString('fr-FR') + ' ' + texte]).slice(-60); ecrireEtat(e); afficherEtat(); }

  // ---------- panneau ----------
  let panneau, zoneTexte, zoneEtat;
  function creerPanneau() {
    if (document.getElementById('origen-obc')) return;
    panneau = document.createElement('div');
    panneau.id = 'origen-obc';
    panneau.style.cssText = 'position:fixed;top:60px;right:12px;z-index:2147483647;width:360px;background:#fff;border:1px solid #cfd8d4;border-radius:12px;box-shadow:0 10px 30px rgba(14,59,54,.18);font:13px/1.45 Arial,Helvetica,sans-serif;color:#1e2b29;';
    panneau.innerHTML = '<div style="background:#0E3B36;color:#fff;padding:10px 14px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;" id="oo-tete"><span>ORIGEN → OBC <small style="font-weight:400;opacity:.75">v' + VERSION + '</small></span><span id="oo-ferme" style="cursor:pointer;opacity:.8;">✕</span></div>'
      + '<div style="padding:12px 14px;">'
      + '<div id="oo-etat" style="margin-bottom:10px;white-space:pre-wrap;max-height:260px;overflow:auto;"></div>'
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
    panneau.querySelector('#oo-ferme').onclick = () => { panneau.style.display = 'none'; };
    panneau.querySelector('#oo-demarrer').onclick = demarrer;
    panneau.querySelector('#oo-continuer').onclick = () => { const e = lireEtat(); if (!e) return; e.pause = false; e.erreur = null; if (e.statut === 'attente_enregistrement') e.statut = 'verifier'; ecrireEtat(e); boucle(); };
    panneau.querySelector('#oo-pause').onclick = () => { const e = lireEtat(); if (!e) return; e.pause = !e.pause; ecrireEtat(e); afficherEtat(); if (!e.pause) boucle(); };
    panneau.querySelector('#oo-journal').onclick = () => { const e = lireEtat(); navigator.clipboard.writeText(JSON.stringify({ origen_obc_journal: true, etape: e && e.etape, statut: e && e.statut, ids: e && e.ids, journal: e && e.journal }, null, 1)); };
    panneau.querySelector('#oo-stop').onclick = () => { if (confirm('Effacer le lot en cours ? (Ce qui est déjà enregistré dans OBC reste enregistré.)')) { effacerEtat(); afficherEtat(); } };
    // déplaçable
    let dx = 0, dy = 0, drag = false; const tete = panneau.querySelector('#oo-tete');
    tete.onmousedown = (ev) => { drag = true; dx = ev.clientX - panneau.offsetLeft; dy = ev.clientY - panneau.offsetTop; ev.preventDefault(); };
    document.addEventListener('mousemove', (ev) => { if (!drag) return; panneau.style.left = (ev.clientX - dx) + 'px'; panneau.style.top = (ev.clientY - dy) + 'px'; panneau.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { drag = false; });
    afficherEtat();
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
    else if (e.statut === 'termine') message = '<div style="color:#1f7a4d;margin-top:8px;font-weight:700;">✓ Les 7 étapes sont faites. ' + (e.note || '') + '</div>';
    else if (e.note) message = '<div style="color:#5b6b68;margin-top:8px;">' + e.note + '</div>';
    zoneEtat.innerHTML = tete + lignes.join('<br>') + message + (e.journal && e.journal.length ? '<div style="color:#5b6b68;margin-top:6px;font-size:11px;">' + e.journal[e.journal.length - 1] + '</div>' : '');
  }
  function demarrer() {
    let lot; try { lot = JSON.parse(zoneTexte.value.trim()); } catch (e) { alert('Le texte collé n\'est pas un lot ORIGEN valide.'); return; }
    if (!lot || !lot.origen_obc_lot) { alert('Ce n\'est pas un lot « Saisir dans OBC » d\'ORIGEN.'); return; }
    ecrireEtat({ lot, etape: 1, statut: 'a_faire', ids: {}, fait: {}, journal: [], pause: false, erreur: null, note: '' });
    zoneTexte.value = '';
    afficherEtat(); boucle();
  }

  // ---------- accès OBC ----------
  async function getJson(url) { const r = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url.split('?')[0] + (r.status === 403 || r.status === 401 ? ' — session OBC expirée : reconnecte-toi puis « Continuer »' : '')); const j = await r.json(); if (Array.isArray(j)) return j; if (j && typeof j === 'object') { const arr = Object.values(j).find(Array.isArray); if (arr) return arr; } return []; }
  const jsonVal = (x) => x == null ? '' : String(x.Value ?? x.value ?? x.producteur_id ?? x.Id ?? x.id ?? ''); const jsonTxt = (x) => x == null ? '' : String(x.Text ?? x.text ?? x.producteur_nom_long ?? x.Nom ?? x.nom ?? x.Name ?? x.name ?? '');
  async function getHtml(url) { const r = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' sur ' + url.split('?')[0]); return new DOMParser().parseFromString(await r.text(), 'text/html'); }
  const lignesTable = (doc) => [...doc.querySelectorAll('table tbody tr')].map((tr) => ({ tr, c: [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()) })).filter((l) => l.c.length > 3);
  function connecte() { return !/\/Account\/Login/i.test(location.pathname) && !!document.querySelector('#logoutForm'); }

  async function attendre(fn, max, pas) { const t0 = Date.now(); while (Date.now() - t0 < (max || ATTENTE_MAX)) { const v = fn(); if (v) return v; await dormir(pas || 250); } return null; }
  // test : RegExp (sur le texte brut), fonction (texte normalisé → bool) ou chaîne (contenue, sans accents ni casse)
  function optionParTexte(sel, test) { if (!sel) return null; const f = test instanceof RegExp ? (t) => test.test(t) : typeof test === 'function' ? (t) => test(N(t)) : (t) => N(t).includes(N(test)); return [...sel.options].find((o) => o.value !== '' && f(o.text)) || null; }
  const exact = (v) => { const n = N(v); return (t) => t === n; };
  async function attendreOption(sel, test) { return attendre(() => optionParTexte(sel, test), ATTENTE_MAX, 300); }
  function setInput(el, v) { if (!el) return; el.value = v == null ? '' : String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
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
    for (let passe = 0; passe < 3; passe++) {
      await dormir(ms || 1500); manques = [];
      [...form.querySelectorAll('select[data-origen-val]')].forEach((el) => { const v = el.dataset.origenVal; if (el.value !== v) { if (!setSelect(el, v)) manques.push(el.id); } });
    }
    await dormir(600);
    [...form.querySelectorAll('select[data-origen-val]')].forEach((el) => { if (el.value !== el.dataset.origenVal && !manques.includes(el.id)) manques.push(el.id); });
    return manques;
  }
  async function setSelectTexte(el, test, libelle, affiche) { const o = await attendreOption(el, test); if (!o) throw new Error(libelle + ' : « ' + (affiche || (test instanceof RegExp ? test.source : typeof test === 'function' ? '?' : test)) + ' » non reconnu dans la liste OBC'); setSelect(el, o.value); return o; }
  // Entité : déjà ECORIGINE dans OBC ; la changer déclenche le rechargement de toutes les listes (et efface les sélections).
  function setEntite(el) { if (!el) return; if (String(el.value) !== ENTITE) setSelect(el, ENTITE); }
  // Attend qu'une liste ait fini de se (re)charger : nombre d'options stable pendant 1,2 s et au moins une valeur.
  async function listeStable(el) { let n = -1, stableDepuis = 0; const t0 = Date.now(); while (Date.now() - t0 < ATTENTE_MAX) { const m = el ? el.options.length : 0; if (m === n && m > 1) { if (Date.now() - stableDepuis > 1200) return true; } else { n = m; stableDepuis = Date.now(); } await dormir(200); } return el && el.options.length > 1; }
  function setRadio(id) { const el = document.getElementById(id); if (!el) return; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  const q = (s) => document.querySelector(s);

  // Ouvre le formulaire de création de l'étape k sur la page courante (ou navigue d'abord vers la bonne page).
  async function ouvrirFormulaire(k) {
    if (!location.pathname.toLowerCase().startsWith(PAGES[k - 1].toLowerCase())) { location.href = PAGES[k - 1]; return null; }
    if (q(FORMS[k - 1])) return q(FORMS[k - 1]);
    const btn = await attendre(() => q(BTN_NOUVEAU[k - 1]), 10000);
    if (!btn) throw new Error('Bouton « Nouveau » introuvable sur ' + PAGES[k - 1]);
    btn.click();
    const f = await attendre(() => q(FORMS[k - 1]), ATTENTE_MAX);
    if (!f) throw new Error('Le formulaire ne s\'est pas ouvert (' + FORMS[k - 1] + ')');
    await dormir(800);
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
    const memeNom = rows.filter((r) => N(r.nom) === base || N(r.nom).replace(/ \d+$/, '') === base);
    const veh = PLAQUE(lot.transporteur.immat_vehicule), rem = PLAQUE(lot.transporteur.immat_remorque);
    const existant = memeNom.find((r) => PLAQUE(r.veh) === veh && PLAQUE(r.rem) === rem) || null;
    if (existant) return { existant, nouveauNom: '' };
    if (!memeNom.length) return { existant: null, nouveauNom: lot.transporteur.nom.trim() };
    const nums = memeNom.map((r) => { const m = N(r.nom).match(/ (\d+)$/); return m ? Number(m[1]) : 1; });
    return { existant: null, nouveauNom: lot.transporteur.nom.trim() + ' ' + (Math.max(...nums) + 1) };
  }
  async function campagneId(lot) {
    const doc = await getHtml('/AgroAchatConnaissementBrousse/Create');
    const sel = doc.querySelector('#txtcampagne_idAdd'); if (!sel) throw new Error('Liste des campagnes introuvable');
    const cle = String(lot.campagne.nom || '').match(/\d{2}\s*-\s*\d{2}/); const test = cle ? cle[0].replace(/\s/g, '') : lot.campagne.nom;
    const o = [...sel.options].find((x) => x.value && N(x.text).replace(/ /g, '').includes(N(test).replace(/ /g, '')) && !/interm/i.test(x.text) === !/interm/i.test(lot.campagne.recolte));
    if (!o) throw new Error('Campagne « ' + lot.campagne.nom + ' » introuvable dans OBC');
    return o.value;
  }

  // ---------- les 7 étapes ----------
  async function etapeCooperative(e) {
    const lot = e.lot;
    if (!e.ids.fournisseur_id) { const r = await trouverFournisseur(lot); if (r) { e.ids.fournisseur_id = r.id; e.ids.fournisseur_nom = r.code; e.fait[1] = 'déjà dans OBC : ' + r.code; journal(e, 'Coopérative trouvée : ' + r.code + ' (id ' + r.id + ')'); return 'suivant'; } }
    else return 'suivant';
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const plan = await getJson('/AppMethods1/LoadPlanComptableEntiteTiersFournisseurByEntiteId?EntiteId=' + ENTITE);
    const poste = plan.find((p) => String(p.Value || '').toUpperCase() === String(lot.cooperative.ccc).toUpperCase());
    if (!poste) { e.erreur = 'Le poste comptable « ' + lot.cooperative.ccc + ' – ' + lot.cooperative.sigle + ' » n\'existe pas dans le plan comptable d\'OBC : crée-le d\'abord, puis « Continuer ».'; return 'stop'; }
    const f = await ouvrirFormulaire(1); if (!f) return 'navigation';
    const c = lot.cooperative;
    setEntite(q('#txtid_entiteAdd'));
    setInput(q('#txtnom_fournisseurAdd'), c.nom_complet); setInput(q('#txtcode_fournisseurAdd'), c.sigle);
    setSelect(q('#txtmode_reglement_fournisseurAdd'), '2'); setSelect(q('#txtsecteur_fournisseurAdd'), '1');
    setInput(q('#txtville_fournisseurAdd'), c.ville); setInput(q('#txtnumero_cc_fournisseurAdd'), c.dfe); setInput(q('#txtnumero_rccm_fournisseurAdd'), c.rccm);
    setInput(q('#txtadresse_postale_fournisseurAdd'), c.adresse_postale); setInput(q('#txtadresse_geographique_fournisseurAdd'), c.siege);
    setRadio('txttype_fournisseur_agroAdd2'); setInput(q('#txtnumero_agrement_ccc_fournisseur_agroAdd'), c.ccc);
    setInput(q('#txttelephone_fournisseurAdd'), c.telephone); setInput(q('#txtemail_fournisseurAdd'), c.email);
    setInput(q('#txtnom_prenom_interlocuteurAdd0'), c.interlocuteur_nom); setInput(q('#txtnum_telephone1_interlocuteurAdd0'), c.interlocuteur_tel);
    await attendreOption(q('#txtnumero_poste_comptableAdd0'), new RegExp('^' + poste.Value + '\\b'));
    if (!setSelect(q('#txtnumero_poste_comptableAdd0'), poste.Value)) throw new Error('Poste comptable non sélectionnable');
    setSelect(q('#txttype_prestation_achatAdd0'), '1');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Coopérative ' + c.sigle + ' (' + c.ccc + ').'; return 'rempli';
  }
  async function etapeTransporteur(e) {
    const lot = e.lot;
    if (e.ids.transporteur_nom) return 'suivant';
    if (!lot.transporteur.nom) { e.fait[2] = 'pas de transporteur sur le connaissement'; journal(e, 'Transporteur absent du lot : étape sautée'); return 'suivant'; }
    const rows = await listerTransporteurs(lot.transporteur.nom.split(' ')[0]);
    const ch = choisirTransporteur(lot, rows);
    if (ch.existant) { e.ids.transporteur_nom = ch.existant.nom; e.fait[2] = 'déjà dans OBC : ' + ch.existant.nom; journal(e, 'Transporteur trouvé : ' + ch.existant.nom + ' (' + ch.existant.veh + ' / ' + ch.existant.rem + ')'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    e.ids.transporteur_nouveau = ch.nouveauNom;
    const f = await ouvrirFormulaire(2); if (!f) return 'navigation';
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
    if (lignesP.length) { const nomP = lignesP[0].c.slice(3, 5).join(' ').trim(); e.fait[3] = 'déjà dans OBC : ' + nomP; journal(e, 'Producteur trouvé : ' + nomP); return 'suivant'; }
    const liste = await getJson('/AppMethods1/LoadAgroProducteursByFournisseurId2?FournisseurId=' + e.ids.fournisseur_id);
    const prods = liste.filter((p) => jsonVal(p) !== '' && jsonTxt(p) !== '');
    if (prods.length) { const nomL = N((lot.producteur.nom || '') + ' ' + (lot.producteur.prenoms || '')); const choisi = prods.find((p) => N(jsonTxt(p)).startsWith(nomL)) || prods[0]; e.ids.producteur_id = jsonVal(choisi); e.fait[3] = 'déjà dans OBC : ' + jsonTxt(choisi); journal(e, 'Producteur trouvé : ' + jsonTxt(choisi)); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(3); if (!f) return 'navigation';
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
    setInput(q('#txtparcelle_superficie_totaleAdd0'), '1'); setInput(q('#txtparcelle_superficie_commoditeAdd0'), '1'); setInput(q('#txtparcelle_production_potentielleAdd0'), '500');
    const manques = await reappliquer(f); if (manques.length) throw new Error('Liste non prise en compte par OBC : ' + manques.join(', '));
    e.note = 'Producteur ' + p.nom + ' ' + p.prenoms + (p.pca ? ' (PCA de la coopérative).' : p.chauffeur ? ' (PCA non renseigné : nom du chauffeur).' : p.fictif ? ' (nom neutre : ni PCA ni producteur dans ORIGEN).' : '.'); return 'rempli';
  }
  // Existence : les pages « Historique » d'OBC acceptent un filtre exact dans l'adresse ; la colonne 4 porte le numéro.
  async function existeDans(page, filtre, colonne, valeur) { if (!filtre) return null; const doc = await getHtml(page + '?filter=' + encodeURIComponent(filtre) + '&pageSize=100'); return lignesTable(doc).find((l) => N(l.c[colonne]) === N(valeur)) || null; }
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
    if (!e.ids.campagne_id) e.ids.campagne_id = await campagneId(lot);
    if (await existeUsine(e) || await existePesee(e) || await existeBrousse(e)) { e.fait[4] = 'déjà dans OBC'; journal(e, 'Connaissement brousse déjà saisi'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(4); if (!f) return 'navigation';
    const c = lot.connaissement;
    setSelect(q('#txtcampagne_idAdd'), e.ids.campagne_id);
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
    const prodId = e.ids.producteur_id && [...q('#txtproducteur_idAdd0').options].find((x) => x.value === String(e.ids.producteur_id));
    setSelect(q('#txtproducteur_idAdd0'), prodModele ? prodModele.value : prodId ? prodId.value : prod.value);
    const parc = await attendre(() => optionParTexte(q('#txtproducteur_parcelle_idAdd0'), /./), 8000);
    const parcModele = prodModele && modele.parcelle && [...q('#txtproducteur_parcelle_idAdd0').options].find((o) => o.value === modele.parcelle);
    if (parcModele) setSelect(q('#txtproducteur_parcelle_idAdd0'), parcModele.value); else if (parc) setSelect(q('#txtproducteur_parcelle_idAdd0'), parc.value);
    const d = c.detail_arbitraire || {}, repris = !!prodModele;
    // Producteur et parcelle : repris à l'identique. Le reste de la ligne (date, reçu, sacs, poids) est propre à CETTE livraison.
    const sacsL = Number(c.sacs_declares) > 0 ? c.sacs_declares : (d.sacs || 1), poidsL = Number(c.poids_net_declare) > 0 ? c.poids_net_declare : (d.poids_net || 56);
    setInput(q('#txtdate_achatAdd0'), isoDate(d.date_achat || c.date)); setInput(q('#txtnumero_recu_achatAdd0'), d.numero_recu || '001');
    setInput(q('#txtlivraison_nb_sacsAdd0'), sacsL); setInput(q('#txtlivraison_poids_netAdd0'), poidsL); setInput(q('#txtlivraison_prix_unitaireAdd0'), num(c.prix_bord_champ));
    if (repris) journal(e, 'Producteur et parcelle repris de ' + modele.numero + ' ; sacs et poids de cette livraison (' + sacsL + ' sacs, ' + poidsL + ' kg)');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Connaissement ' + c.numero + ' (' + c.type_commodite + (c.certification ? ' ' + c.certification : '') + '), prix bord champ ' + c.prix_bord_champ + '.'; return 'rempli';
  }
  async function etapeLivraison(e) {
    const lot = e.lot;
    if (await existeUsine(e) || await existePesee(e)) { e.fait[5] = 'déjà dans OBC'; journal(e, 'Données livraison déjà saisies'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(5); if (!f) return 'navigation';
    const c = lot.connaissement;
    setSelect(q('#txtcampagne_idAdd'), e.ids.campagne_id);
    await listeStable(q('#txtconnaissement_brousse_idAdd')); await listeStable(q('#txttransporteur_idAdd')); await listeStable(q('#txtorigine_idAdd'));
    await setSelectTexte(q('#txtcampagne_recolte_idAdd'), new RegExp('^' + lot.campagne.recolte, 'i'), 'Récolte');
    await setSelectTexte(q('#txtconnaissement_brousse_idAdd'), c.numero, 'Connaissement brousse');
    await dormir(1500);
    setInput(q('#txtconnaissement_usine_dateAdd'), isoDate(c.date));
    if (!q('#txtconnaissement_usine_numeroAdd').value) setInput(q('#txtconnaissement_usine_numeroAdd'), c.numero);
    await setSelectTexte(q('#txtorigine_idAdd'), exact(c.origine), 'Origine', c.origine);
    setInput(q('#txtconnaissement_usine_cout_tkmAdd'), num(c.tkm));
    await setSelectTexte(q('#txtdestination_idAdd'), exact(c.destination), 'Destination', c.destination);
    const nomTr = e.ids.transporteur_nom || e.ids.transporteur_nouveau; if (nomTr) await setSelectTexte(q('#txttransporteur_idAdd'), exact(nomTr), 'Transporteur', nomTr);
    await dormir(600);
    if (!q('#txtconnaissement_immatriculation_vehiculeAdd').value) setInput(q('#txtconnaissement_immatriculation_vehiculeAdd'), lot.transporteur.immat_vehicule);
    if (!q('#txtconnaissement_immatriculation_remorqueAdd').value) setInput(q('#txtconnaissement_immatriculation_remorqueAdd'), lot.transporteur.immat_remorque);
    if (!q('#txtconnaissement_nom_chauffeurAdd').value) setInput(q('#txtconnaissement_nom_chauffeurAdd'), lot.transporteur.chauffeur);
    await setSelectTexte(q('#txtusine_idAdd'), new RegExp('-\\s*' + c.usine_code + '\\s*$', 'i'), 'Usine');
    setInput(q('#txtconnaissement_usine_nb_sacs_chargeAdd'), c.sacs_declares); setInput(q('#txtconnaissement_usine_nb_sacs_receptionneAdd'), c.sacs_declares);
    setInput(q('#txtconnaissement_usine_poids_brut_chargeAdd'), c.poids_brut_declare || ''); setInput(q('#txtconnaissement_usine_poids_refactionAdd'), '0');
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Livraison ' + c.numero + ' : ' + c.sacs_declares + ' sacs, brut déclaré ' + (c.poids_brut_declare || '?') + ', TKM ' + c.tkm + ', usine ' + c.usine_code + '.'; return 'rempli';
  }
  async function etapePesee(e) {
    const lot = e.lot;
    if (await existePesee(e)) { e.fait[6] = 'déjà dans OBC'; journal(e, 'Pesée déjà saisie'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(6); if (!f) return 'navigation';
    const p = lot.pesee, c = lot.connaissement;
    setSelect(q('#txtcampagne_idAdd'), e.ids.campagne_id);
    await listeStable(q('#txtconnaissement_usine_idAdd')); await listeStable(q('#txtqualite_idAdd'));
    await setSelectTexte(q('#txtconnaissement_usine_idAdd'), c.numero, 'Connaissement usine');
    await dormir(1500);
    setInput(q('#txtpesee_brousse_dateAdd'), isoDate(p.date || c.date)); setInput(q('#txtpesee_brousse_numeroAdd'), p.code);
    setInput(q('#txtpesee_brousse_poids_entreeAdd'), num(p.poids_entree)); setInput(q('#txtpesee_brousse_poids_sortieAdd'), num(p.poids_sortie));
    // rubriques qualité : celles qu'OBC connaît pour le cacao
    const rubs = await getJson('/AppMethods1/LoadAgroRubriquesQualiteByCommoditeId?CommoditeId=2');
    const paires = []; (p.qualite || []).forEach((qv) => { const r = rubs.find((x) => { const a = N(x.Text).replace(/\s*\[.*$/, ''), b = N(qv.rubrique); return a === b || a.startsWith(b) || b.startsWith(a); }); if (r && qv.valeur != null && !paires.some((x) => x.id === r.Value)) paires.push({ id: r.Value, valeur: num(qv.valeur), lib: r.Text }); });
    for (let i = 0; i < paires.length; i++) {
      if (i > 0 && !q('#txtcommodite_rubriques_qualite_idAdd' + i)) { const b = q('#btnNewLineDetailsRubriqueQualitePeseeBrousse'); if (b) b.click(); await attendre(() => q('#txtcommodite_rubriques_qualite_idAdd' + i), 5000); }
      const sel = q('#txtcommodite_rubriques_qualite_idAdd' + i); if (!sel) break;
      await attendreOption(sel, /./); setSelect(sel, paires[i].id); setInput(q('#txtcommodite_rubriques_qualite_valeurAdd' + i), paires[i].valeur);
    }
    setInput(q('#txtpesee_brousse_sacs_dechargesAdd'), p.sacs_decharges != null ? p.sacs_decharges : p.sacs_acceptes); setInput(q('#txtpesee_brousse_sacs_acceptesAdd'), p.sacs_acceptes);
    setInput(q('#txtpesee_brousse_tare_sacs_acceptesAdd'), num(p.tare_sacs)); setInput(q('#txtpesee_brousse_tare_palettesAdd'), '0'); setInput(q('#txtpesee_brousse_poids_refactionAdd'), '0');
    if (p.classement) await setSelectTexte(q('#txtqualite_idAdd'), exact(p.classement), 'Classement', p.classement);
    { const m = await reappliquer(f); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    e.note = 'Pesée ' + p.code + ' : entrée ' + p.poids_entree + ' / sortie ' + p.poids_sortie + ', ' + paires.length + ' rubriques qualité, ' + p.classement + '. Poids net payé attendu : ' + p.poids_net_paye_attendu + '.'; return 'rempli';
  }
  async function etapeBordereau(e) {
    const lot = e.lot, b = lot.bordereau;
    if (await existeBordereau(e)) { e.fait[7] = 'déjà dans OBC'; journal(e, 'Bordereau déjà saisi'); return 'suivant'; }
    if (e.statut === 'attente_enregistrement' || e.statut === 'verifier') return 'attendre';
    const f = await ouvrirFormulaire(7); if (!f) return 'navigation';
    setSelect(q('#txtcampagne_idAdd'), e.ids.campagne_id);
    await listeStable(q('#txtpesee_brousse_idAdd'));
    await setSelectTexte(q('#txtpesee_brousse_idAdd'), lot.pesee.code, 'Pesée brousse');
    await dormir(1500);
    setInput(q('#txtbordereau_reception_dateAdd'), isoDate(b.date)); setInput(q('#txtbordereau_reception_numeroAdd'), b.numero);
    setInput(q('#txtbordereau_reception_pu_commoditeAdd'), num(b.pu_commodite)); setInput(q('#txtbordereau_reception_retenue_pu_bicAdd'), num(b.pu_bic));
    setInput(q('#txtbordereau_reception_retenue_pu_mandatAdd'), '0'); setInput(q('#txtbordereau_reception_retenue_pu_miseencompteAdd'), '0');
    setInput(q('#txtbordereau_reception_retenue_pu_revolvingAdd'), num(b.pu_revolving || 0)); setInput(q('#txtbordereau_reception_retenue_pu_avanceAdd'), '0');
    setInput(q('#txtbordereau_reception_gain_pu_commissionAdd'), num(b.pu_commission || 0)); setInput(q('#txtbordereau_reception_gain_pu_transportAdd'), num(b.pu_transport));
    const nat1 = q('#txtnature_prestation_id_livraison_produitAdd'), nat2 = q('#txtnature_prestation_id_facturationAdd');
    if (nat1 && !nat1.value) await setSelectTexte(nat1, /STOCK BROUSSE\s*-\s*321110000/i, 'Nature (livraison produit)');
    if (nat2 && !nat2.value) await setSelectTexte(nat2, /Fournitures Li\w+\s*-\s*602000/i, 'Nature (facturation)');
    await dormir(1200);
    { const m = await reappliquer(f, 800); if (m.length) throw new Error('Liste non prise en compte par OBC : ' + m.join(', ')); }
    const net = [...f.querySelectorAll('input')].find((i) => /net_a_payer|netapayer/i.test(i.name + i.id));
    let verif = '';
    if (net && b.net_attendu != null) { const v = Number(String(net.value).replace(/\s/g, '').replace(',', '.')); verif = isFinite(v) && Math.abs(v - b.net_attendu) < 1 ? ' ✓ Net à payer OBC = ORIGEN (' + v.toLocaleString('fr-FR') + ').' : ' ⚠ Net à payer OBC ' + net.value + ' ≠ ORIGEN ' + b.net_attendu.toLocaleString('fr-FR') + ' : vérifie avant d\'enregistrer.'; }
    e.note = 'Bordereau ' + b.numero + ' : PU ' + b.pu_commodite + ', BIC ' + b.pu_bic + ', transport ' + b.pu_transport + (b.montant_revolving ? ', revolving ' + b.montant_revolving : '') + '.' + verif; return 'rempli';
  }
  const EXEC = [etapeCooperative, etapeTransporteur, etapeProducteur, etapeBrousse, etapeLivraison, etapePesee, etapeBordereau];

  // ---------- boucle ----------
  let enCours = false;
  async function boucle() {
    if (enCours) return; enCours = true;
    try {
      let e = lireEtat();
      if (!e || e.pause || e.statut === 'termine') return;
      if (!connecte()) { e.erreur = 'Connecte-toi à OBC, puis « Continuer ».'; ecrireEtat(e); afficherEtat(); return; }
      for (let garde = 0; garde < 10; garde++) {
        e = lireEtat(); if (!e || e.pause) return;
        if (e.etape > 7) { e.statut = 'termine'; e.note = 'Dans ORIGEN, sous cette livraison, clique « déjà saisi » pour la marquer OBC ✓ (n° de bordereau : ' + (e.lot.bordereau && e.lot.bordereau.numero || '') + ').'; ecrireEtat(e); afficherEtat(); return; }
        if (e.statut === 'attente_enregistrement') {
          // le formulaire est rempli : on attend que l'utilisateur enregistre, puis on vérifie toutes les 4 s
          const res = await EXEC[e.etape - 1](e);
          if (res === 'suivant') { e.statut = 'a_faire'; e.note = ''; e.etape++; ecrireEtat(e); afficherEtat(); continue; }
          ecrireEtat(e); afficherEtat(); setTimeout(boucle, 4000); return;
        }
        if (e.statut === 'verifier') e.statut = 'a_faire';
        e.erreur = null; ecrireEtat(e); afficherEtat();
        let res;
        try { res = await EXEC[e.etape - 1](e); }
        catch (err) { e.erreur = ETAPES[e.etape - 1] + ' : ' + (err && err.message ? err.message : String(err)); journal(e, 'Erreur : ' + e.erreur); return; }
        if (res === 'suivant') { e.statut = 'a_faire'; e.etape++; e.note = ''; ecrireEtat(e); afficherEtat(); continue; }
        if (res === 'rempli') { e.statut = 'attente_enregistrement'; journal(e, ETAPES[e.etape - 1] + ' : formulaire rempli, en attente d\'Enregistrer'); setTimeout(boucle, 4000); return; }
        if (res === 'navigation') return;          // la page change : le script reprend au chargement
        if (res === 'stop') { ecrireEtat(e); afficherEtat(); return; }
        if (res === 'attendre') { ecrireEtat(e); afficherEtat(); setTimeout(boucle, 4000); return; }
      }
    } finally { enCours = false; }
  }

  creerPanneau();
  setTimeout(boucle, 1200);
})();
