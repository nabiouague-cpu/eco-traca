// ==UserScript==
// @name         ORIGEN → Forms CARGILL (automate de saisie)
// @namespace    https://nabiouague-cpu.github.io/eco-traca/
// @version      1.0.0
// @description  Saisit automatiquement dans le formulaire Microsoft Forms de CARGILL les questionnaires producteurs collectés dans ORIGEN (ECORIGINE). Un lot copié depuis ORIGEN, un producteur par réponse, reprise automatique après chaque envoi.
// @author       ECORIGINE — ORIGEN
// @match        https://forms.office.com/*
// @match        https://forms.microsoft.com/*
// @match        https://forms.cloud.microsoft/*
// @match        https://*.forms.office.com/*
// @updateURL    https://nabiouague-cpu.github.io/eco-traca/automate/origen-forms-automate.user.js
// @downloadURL  https://nabiouague-cpu.github.io/eco-traca/automate/origen-forms-automate.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const CLE = 'origen_forms_lot';
  const PAUSE = 450;           // ms entre deux actions (laisse React re-rendre)
  const ATTENTE_MAX = 15000;   // ms d'attente maximale d'un element
  const N = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;

  // ---------- lot (stocke dans localStorage de la page Forms) ----------
  function lireLot() { try { return JSON.parse(localStorage.getItem(CLE) || 'null'); } catch (e) { return null; } }
  function ecrireLot(lot) { localStorage.setItem(CLE, JSON.stringify(lot)); }
  function effacerLot() { localStorage.removeItem(CLE); }

  // ---------- panneau ----------
  let panneau, zoneTexte, zoneEtat, btnDemarrer, btnPause, btnStop, btnCopier;
  function creerPanneau() {
    if (document.getElementById('origen-automate')) return;
    panneau = document.createElement('div');
    panneau.id = 'origen-automate';
    panneau.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;background:#fff;border:1px solid #cfd8d4;border-radius:12px;box-shadow:0 10px 30px rgba(14,59,54,.18);font:13px/1.45 Arial,Helvetica,sans-serif;color:#1e2b29;';
    panneau.innerHTML = '<div style="background:#0E3B36;color:#fff;padding:10px 14px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between;align-items:center;"><span>ORIGEN → Forms CARGILL</span><span id="oa-ferme" style="cursor:pointer;opacity:.8;">✕</span></div>'
      + '<div style="padding:12px 14px;">'
      + '<div id="oa-etat" style="margin-bottom:10px;white-space:pre-wrap;"></div>'
      + '<textarea id="oa-lot" placeholder="Colle ici le lot copié depuis ORIGEN (Ctrl+V)" style="width:100%;box-sizing:border-box;height:70px;border:1px solid #cfd8d4;border-radius:8px;padding:6px;font:12px monospace;"></textarea>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'
      + '<button id="oa-demarrer" style="background:#F2B705;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Démarrer</button>'
      + '<button id="oa-pause" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Pause</button>'
      + '<button id="oa-copier" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Copier le résultat</button>'
      + '<button id="oa-stop" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;color:#B3261E;">Effacer le lot</button>'
      + '</div></div>';
    document.body.appendChild(panneau);
    zoneTexte = panneau.querySelector('#oa-lot'); zoneEtat = panneau.querySelector('#oa-etat');
    btnDemarrer = panneau.querySelector('#oa-demarrer'); btnPause = panneau.querySelector('#oa-pause'); btnStop = panneau.querySelector('#oa-stop'); btnCopier = panneau.querySelector('#oa-copier');
    panneau.querySelector('#oa-ferme').onclick = () => { panneau.style.display = 'none'; };
    btnDemarrer.onclick = demarrer;
    btnPause.onclick = () => { const lot = lireLot(); if (!lot) return; lot.pause = !lot.pause; ecrireLot(lot); afficherEtat(); if (!lot.pause) boucle(); };
    btnStop.onclick = () => { if (confirm('Effacer le lot en cours sur cette page ? (Les réponses déjà envoyées à Forms restent envoyées.)')) { effacerLot(); afficherEtat(); } };
    btnCopier.onclick = copierResultat;
    afficherEtat();
  }
  function afficherEtat(msg) {
    const lot = lireLot();
    if (!zoneEtat) return;
    if (!lot) { zoneEtat.textContent = msg || 'Aucun lot. Dans ORIGEN : « Copier le lot pour l\'automate », puis colle-le ci-dessous et clique Démarrer.'; zoneTexte.style.display = ''; return; }
    zoneTexte.style.display = 'none';
    const total = lot.reponses.length, faits = lot.faits.length, erreurs = lot.erreurs.length;
    zoneEtat.textContent = (msg ? msg + '\n' : '') + 'Lot ' + lot.cooperative + ' : ' + faits + ' / ' + total + ' envoyé' + (faits > 1 ? 's' : '') + (erreurs ? ' · ' + erreurs + ' en erreur' : '') + (lot.pause ? '\n⏸ En pause' : (lot.restants.length ? '\n▶ En cours…' : '\n✓ Terminé — clique « Copier le résultat » puis colle-le dans ORIGEN.'));
    btnPause.textContent = lot.pause ? 'Reprendre' : 'Pause';
  }
  function demarrer() {
    let lot = lireLot();
    if (!lot) {
      const txt = zoneTexte.value.trim();
      if (!txt) { alert('Colle d\'abord le lot copié depuis ORIGEN.'); return; }
      try { lot = JSON.parse(txt); } catch (e) { alert('Lot illisible : recopie-le depuis ORIGEN.'); return; }
      if (!lot || !Array.isArray(lot.reponses) || !lot.reponses.length) { alert('Lot vide.'); return; }
      lot.restants = lot.reponses.map((r) => r.id); lot.faits = []; lot.erreurs = []; lot.pause = false; lot.journal = [];
      ecrireLot(lot);
    } else { lot.pause = false; ecrireLot(lot); }
    afficherEtat();
    boucle();
  }
  function copierResultat() {
    const lot = lireLot(); if (!lot) return;
    const res = JSON.stringify({ origen_forms_resultat: true, cooperative: lot.cooperative, demande_id: lot.demande_id, faits: lot.faits, erreurs: lot.erreurs });
    const fin = () => alert('Résultat copié. Dans ORIGEN, clique « Coller le résultat de l\'automate ».');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res).then(fin, () => prompt('Copie ce texte puis colle-le dans ORIGEN :', res));
    else prompt('Copie ce texte puis colle-le dans ORIGEN :', res);
  }

  // ---------- lecture du formulaire ----------
  function texteTitre(bloc) {
    const t = bloc.querySelector('[data-automation-id="questionTitle"], [role="heading"], .question-title-box, h3, h2');
    let s = t ? t.textContent : bloc.textContent;
    return N(s.replace(/^\s*\d+\s*[.)]?\s*/, '').replace(/\*/g, '').replace(/obligatoire|required/gi, ''));
  }
  function blocsQuestions() {
    let b = Array.from(document.querySelectorAll('[data-automation-id="questionItem"]'));
    if (!b.length) b = Array.from(document.querySelectorAll('[role="group"], .office-form-question')).filter((x) => x.querySelector('input, textarea, [role="combobox"], [role="radio"]'));
    return b.filter(visible);
  }
  function trouverQuestion(titreN, questions) {
    // meilleure correspondance : libelle ORIGEN dont le debut normalise (35 car.) est contenu dans le titre Forms, ou l'inverse
    let meilleur = null, score = 0;
    for (const q of questions) {
      const l = N(q.libelle); if (!l) continue;
      const a = l.slice(0, 35), b = titreN.slice(0, 35);
      let s = 0;
      if (l === titreN) s = 1000; else if (titreN.indexOf(a) >= 0 || l.indexOf(b) >= 0) s = Math.min(l.length, titreN.length);
      if (s > score) { score = s; meilleur = q; }
    }
    return score >= 15 ? meilleur : null;
  }
  function setValeurReact(el, valeur) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, valeur);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function attendre(fn, max) {
    const debut = Date.now();
    while (Date.now() - debut < (max || ATTENTE_MAX)) { const r = fn(); if (r) return r; await dormir(200); }
    return null;
  }
  async function repondreBloc(bloc, q, valeur) {
    const v = String(valeur == null ? '' : valeur);
    if (!v) return 'vide';
    // 1. choix (boutons radio)
    const radios = Array.from(bloc.querySelectorAll('input[type="radio"], [role="radio"]')).filter(visible);
    if (radios.length) {
      const cible = radios.find((r) => {
        const lab = r.getAttribute('aria-label') || r.value || (r.closest('label') && r.closest('label').textContent) || (r.parentElement && r.parentElement.textContent) || '';
        return N(lab) === N(v) || N(lab).indexOf(N(v)) === 0;
      });
      if (!cible) return 'option « ' + v + ' » introuvable';
      (cible.closest('label') || cible).click(); await dormir(150);
      if (cible.type === 'radio' && !cible.checked) { cible.click(); }
      return 'ok';
    }
    // 2. liste deroulante
    const combo = bloc.querySelector('select') || bloc.querySelector('[role="combobox"]') || bloc.querySelector('[data-automation-id="dropdown"] button') || bloc.querySelector('[data-automation-id="dropdown"]');
    if (combo) {
      if (combo.tagName === 'SELECT') {
        const opt = Array.from(combo.options).find((o) => N(o.textContent) === N(v) || N(o.textContent).indexOf(N(v)) === 0);
        if (!opt) return 'option « ' + v + ' » introuvable';
        combo.value = opt.value; combo.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
      }
      combo.click(); await dormir(PAUSE);
      const opt = await attendre(() => Array.from(document.querySelectorAll('[role="option"], [data-automation-id="dropdownOption"], li[role="menuitem"]')).filter(visible).find((o) => N(o.textContent) === N(v) || N(o.textContent).indexOf(N(v)) === 0), 4000);
      if (!opt) { document.body.click(); return 'option « ' + v + ' » introuvable dans la liste'; }
      opt.click(); await dormir(PAUSE);
      return 'ok';
    }
    // 3. texte
    const champ = bloc.querySelector('textarea, input[type="text"], input:not([type]), input[data-automation-id="textInput"]');
    if (champ) { champ.focus(); setValeurReact(champ, v); champ.blur(); return 'ok'; }
    return 'aucun champ reconnu';
  }
  function boutonParTexte(regex, selecteur) {
    const direct = selecteur ? document.querySelector(selecteur) : null;
    if (direct && visible(direct)) return direct;
    return Array.from(document.querySelectorAll('button, a[role="button"], a')).filter(visible).find((b) => regex.test(N(b.textContent))) || null;
  }
  const boutonSuivant = () => boutonParTexte(/^(suivant|next)$/, 'button[data-automation-id="nextButton"]');
  const boutonEnvoyer = () => boutonParTexte(/^(envoyer|submit)$/, 'button[data-automation-id="submitButton"]');
  const lienAutre = () => boutonParTexte(/autre reponse|another response/, 'a[data-automation-id="submitAnother"]');
  // Texte RENDU (innerText) : textContent inclurait les scripts de la page.
  const pageMerci = () => !!lienAutre() || (!boutonEnvoyer() && !boutonSuivant() && /(^| )merci( |$)|thank you|votre reponse a ete envoyee|your response was submitted/.test(N(document.body.innerText).slice(0, 4000)));

  // ---------- boucle principale (reprend apres chaque rechargement) ----------
  let enCours = false;
  async function boucle() {
    if (enCours) return; enCours = true;
    try {
      let lot = lireLot();
      if (!lot || lot.pause || !lot.restants.length) { afficherEtat(); return; }
      // Page « merci » : passer a la reponse suivante (recharge la page -> le script reprend)
      if (pageMerci()) {
        const a = lienAutre();
        if (a) { afficherEtat('Réponse envoyée, passage au producteur suivant…'); await dormir(PAUSE); a.click(); await dormir(3000); if (pageMerci()) location.reload(); return; }
        location.href = lot.lien || location.href.split('?')[0]; return;
      }
      const id = lot.restants[0];
      const rep = lot.reponses.find((r) => r.id === id);
      if (!rep) { lot.restants.shift(); ecrireLot(lot); enCours = false; return boucle(); }
      afficherEtat('Saisie de ' + rep.nom + '…');
      // pages successives
      for (let page = 0; page < 12; page++) {
        const blocs = await attendre(() => { const b = blocsQuestions(); return b.length ? b : null; }, 8000);
        if (!blocs) { marquerErreur(lot, id, 'aucune question visible sur la page ' + (page + 1)); return; }
        const problemes = [];
        // Passes successives : Forms fait apparaitre des questions apres certaines reponses (branchement),
        // et peut re-rendre la page ; on re-cherche donc chaque bloc par son titre, jusqu'a ce que plus
        // aucune nouvelle question n'apparaisse.
        const dejaFaits = new Set();
        for (let passe = 0; passe < 4; passe++) {
          const titres = blocsQuestions().map(texteTitre).filter((t) => t && !dejaFaits.has(t));
          if (!titres.length) break;
          for (const titre of titres) {
            dejaFaits.add(titre);
            const q = trouverQuestion(titre, lot.questions);
            if (!q) continue;                                   // question inconnue d'ORIGEN : on la laisse
            const valeur = rep.valeurs[q.cle];
            if (valeur == null || valeur === '') continue;      // pas sur le chemin suivi
            const bloc = await attendre(() => blocsQuestions().find((x) => texteTitre(x) === titre) || null, 4000);
            if (!bloc) { problemes.push(q.libelle.slice(0, 60) + ' → question disparue de la page'); continue; }
            let r;
            try { r = await repondreBloc(bloc, q, valeur); } catch (e) { r = 'erreur : ' + e.message; }
            await dormir(200);
            if (r !== 'ok' && r !== 'vide') problemes.push(q.libelle.slice(0, 60) + ' → ' + r);
          }
          await dormir(300);
        }
        if (problemes.length) { marquerErreur(lot, id, problemes.join(' ; ')); return; }
        await dormir(PAUSE);
        const suivant = boutonSuivant();
        if (suivant) { suivant.click(); await dormir(900); continue; }
        const envoyer = boutonEnvoyer();
        if (!envoyer) { marquerErreur(lot, id, 'bouton Envoyer introuvable sur la page ' + (page + 1)); return; }
        envoyer.click();
        const ok = await attendre(() => pageMerci() ? true : null, 12000);
        if (!ok) { marquerErreur(lot, id, 'pas de confirmation après Envoyer (champ obligatoire manquant ?)'); return; }
        lot = lireLot(); lot.restants = lot.restants.filter((x) => x !== id); lot.faits.push(id); lot.journal.push({ id, le: new Date().toISOString() }); ecrireLot(lot);
        afficherEtat('✓ ' + rep.nom + ' envoyé.');
        await dormir(800);
        enCours = false;
        return boucle();  // page merci -> reponse suivante
      }
      marquerErreur(lot, id, 'trop de pages');
    } catch (e) { const lot2 = lireLot(); if (lot2) { lot2.pause = true; ecrireLot(lot2); } afficherEtat('⚠ Erreur inattendue : ' + e.message); }
    finally { enCours = false; }
  }
  function marquerErreur(lot, id, detail) {
    lot = lireLot(); lot.restants = lot.restants.filter((x) => x !== id); lot.erreurs.push({ id, detail }); lot.pause = true; ecrireLot(lot);
    afficherEtat('⚠ Erreur sur ce producteur : ' + detail + '\nLe formulaire est laissé tel quel pour vérification. Corrige à la main ou recharge la page puis « Reprendre » pour passer au suivant.');
  }

  // ---------- demarrage ----------
  function init() {
    creerPanneau();
    const lot = lireLot();
    if (lot && !lot.pause && lot.restants.length) { setTimeout(boucle, 1500); }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 800); else window.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
})();
