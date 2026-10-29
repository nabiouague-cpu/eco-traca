// ECORIGINE — Edge Function : réception des LOTS EXPORT lus sur le SAIGIC (état « Etat des lots fabriqués »)
// par le robot du serveur relais (VPS en Côte d'Ivoire). LECTURE SEULE côté SAIGIC.
//
// Pour chaque lot reçu (tous clients confondus, exportateur 009) :
//  - le client / programme / type de cacao se reconnaissent d'après le NUMÉRO du lot (séries d'ORIGEN : la série dont le
//    numéro de début est le plus grand sans dépasser le numéro du lot) ; un lot sans série est signalé « à classer » ;
//  - lot déjà dans ORIGEN : on enregistre les infos du SAIGIC (date de fabrication, grade, BV, Fo1, poids théorique et réel, D6, vu embarqué)
//    et on ne remplit que ce qui est vide (client, série, site, type, marque, poids) ; jamais d'écrasement d'une saisie à la main,
//    SAUF le poids d'entrepôt, que le SAIGIC corrige (sauf sites loco-magasin, dont le poids AGL est saisi par le shipping : l'écart est seulement signalé) ;
//  - lot absent d'ORIGEN : il est créé (origine « saigic »), avec le site si le robot a pu le trouver.
// Corps : { lots: [...], localisation?: {numero: "UA55"}, complet?: true, dry_run?: true }.  Secret : en-tête x-relais-secret = RELAIS_SAIGIC_SECRET.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const rep = (c: unknown, s = 200) => new Response(JSON.stringify(c), { status: s, headers: { 'Content-Type': 'application/json' } });
async function egaux(a: string, b: string) {
  const e = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(b)));
  let d = 0; for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i]; return d === 0;
}
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const txt = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const vide = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return rep({ error: 'POST uniquement' }, 405);
  const secret = Deno.env.get('RELAIS_SAIGIC_SECRET');
  if (!secret) return rep({ error: "RELAIS_SAIGIC_SECRET n'est pas configuré." }, 500);
  if (!(await egaux(req.headers.get('x-relais-secret') || '', secret))) return rep({ error: 'Non autorisé' }, 401);
  try {
    const corps = await req.json();
    const lots = Array.isArray(corps?.lots) ? corps.lots : null;
    if (!lots) return rep({ error: 'Champ « lots » manquant.' }, 400);
    if (lots.length > 2000) return rep({ error: 'Trop de lots.' }, 413);
    const dry = corps?.dry_run === true;
    const localisation: Record<string, string> = (corps?.localisation && typeof corps.localisation === 'object') ? corps.localisation : {};
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: camps } = await sb.from('campagnes').select('id, nom, date_debut, date_fin');
    const { data: series } = await sb.from('lots_series').select('id, campagne_id, type_cacao, niveau_tracabilite, numero_debut, numero_fin, client, site_code, programme');
    const { data: sites } = await sb.from('sites_usinage').select('code, nom, ville, actif, tracabilite_externe, prix_loco_fcfa_kg');
    const numeros = lots.map((l: any) => String(l?.numero ?? '').trim()).filter(Boolean);
    const { data: exist, error: e1 } = await sb.from('lots_usinage').select('*').in('numero', numeros);
    if (e1) throw new Error('lots : ' + e1.message);
    const parNumero = new Map<string, any>(); for (const x of (exist || []) as any[]) parNumero.set(String(x.numero), x);
    const siteDe = (code: string | null) => ((sites || []) as any[]).find((s) => s.code === code) || null;
    const locoMagasin = (code: string | null) => { const s = siteDe(code); return !!s && (s.tracabilite_externe === true || Number(s.prix_loco_fcfa_kg) > 0); };

    const bilan = { lues: 0, creees: 0, mises_a_jour: 0, inchangees: 0, a_classer: [] as string[], a_localiser: [] as string[],
      poids_corriges: [] as unknown[], ecarts_poids_signales: [] as unknown[], clients_completes: [] as string[], absents_du_saigic: [] as string[],
      sites_a_tester: ((sites || []) as any[]).filter((s) => s.actif !== false).map((s) => s.code), erreurs: [] as string[], plan: [] as unknown[] };
    const vus = new Set<string>(); const maintenant = new Date().toISOString();

    for (const l of lots) {
      const numero = String(l?.numero ?? '').trim(); if (!numero || vus.has(numero)) continue; vus.add(numero); bilan.lues++;
      const n = parseInt(numero, 10);
      const dateFab = txt(l.date_fab); const jour = dateFab ? dateFab.slice(0, 10) : null;
      const camp = (camps || []).find((c: any) => jour && c.date_debut && c.date_fin && String(c.date_debut) <= jour && jour <= String(c.date_fin)) || (camps || [])[0] || null;
      // série : numéro de début le plus grand qui ne dépasse pas le numéro du lot (dans la campagne du lot)
      const candidates = ((series || []) as any[]).filter((s) => (!camp || !s.campagne_id || s.campagne_id === camp.id) && Number.isFinite(n) && s.numero_debut <= n && (s.numero_fin == null || n <= s.numero_fin))
        .sort((a, b) => b.numero_debut - a.numero_debut);
      const serie = candidates[0] || null;
      if (!serie) bilan.a_classer.push(numero);

      const saigic: Record<string, unknown> = {
        saigic_date_fab: dateFab, saigic_grade: txt(l.grade), saigic_numero_bv: txt(l.numero_bv), saigic_fo1_provisoire: txt(l.fo1_provisoire), saigic_fo1: txt(l.fo1),
        saigic_poids_theorique_kg: num(l.poids_theorique), saigic_poids_reel_kg: num(l.poids_reel), saigic_d6: txt(l.d6), saigic_vu_emb: txt(l.vu_emb), saigic_traite: txt(l.traite),
      };
      const siteCode = txt(localisation[numero]);
      const ex = parNumero.get(numero);

      if (ex) {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(saigic)) { if (String(ex[k] ?? '') !== String(v ?? '') && !(vide(ex[k]) && vide(v))) patch[k] = v; }
        // champs remplis seulement s'ils sont vides
        const defauts: Record<string, unknown> = {
          client: serie?.client ?? null, serie_id: serie?.id ?? null, type_cacao: serie?.type_cacao ?? null, programme: serie?.programme ?? null,
          niveau_tracabilite: serie?.niveau_tracabilite ?? null, marque: txt(l.marque), campagne_id: camp?.id ?? null,
          poids_theorique_kg: num(l.poids_theorique), date_production: jour,
        };
        for (const [k, v] of Object.entries(defauts)) { if (vide(ex[k]) && !vide(v)) { patch[k] = v; if (k === 'client') bilan.clients_completes.push(numero); } }
        if (vide(ex.site_code)) { const sc = siteCode || serie?.site_code || null; if (sc) { patch.site_code = sc; if (vide(ex.site)) patch.site = siteDe(sc)?.nom ?? sc; } }
        const site = String(patch.site_code ?? ex.site_code ?? '') || null;
        if (!site) bilan.a_localiser.push(numero);
        // poids d'entrepôt : le SAIGIC fait foi (sauf loco-magasin)
        const reel = num(l.poids_reel);
        if (reel !== null && reel > 0) {
          const actuel = num(ex.poids_entrepot_kg);
          if (actuel === null) patch.poids_entrepot_kg = reel;
          else if (actuel !== reel) {
            if (locoMagasin(site)) bilan.ecarts_poids_signales.push({ numero, orig_en: actuel, saigic: reel, raison: 'loco-magasin : poids AGL conservé' });
            else { patch.poids_entrepot_kg = reel; bilan.poids_corriges.push({ numero, avant: actuel, apres: reel }); }
          }
        }
        const reste = Object.keys(patch).filter((k) => k !== 'saigic_lu_le');
        if (!reste.length) { bilan.inchangees++; continue; }
        patch.saigic_lu_le = maintenant; patch.updated_at = maintenant;
        bilan.plan.push({ numero, action: 'maj', champs: reste });
        if (!dry) { const { error } = await sb.from('lots_usinage').update(patch).eq('id', ex.id); if (error) { bilan.erreurs.push(numero + ' : ' + error.message); continue; } }
        bilan.mises_a_jour++;
        continue;
      }

      const sc = siteCode || serie?.site_code || null;
      if (!sc) bilan.a_localiser.push(numero);
      const reel = num(l.poids_reel);
      const nouveau: Record<string, unknown> = {
        id: 'lu_saigic_' + numero, numero, campagne_id: camp?.id ?? null, site: sc ? (siteDe(sc)?.nom ?? sc) : null, site_code: sc,
        client: serie?.client ?? null, serie_id: serie?.id ?? null, type_cacao: serie?.type_cacao ?? null, programme: serie?.programme ?? null,
        niveau_tracabilite: serie?.niveau_tracabilite ?? null, marque: txt(l.marque), statut: 'ouvert', origine: 'saigic', date_production: jour,
        poids_theorique_kg: num(l.poids_theorique), poids_entrepot_kg: reel !== null && reel > 0 ? reel : null,
        ...saigic, saigic_lu_le: maintenant,
      };
      bilan.plan.push({ numero, action: 'creer', client: serie?.client ?? null, site: sc });
      if (!dry) { const { error } = await sb.from('lots_usinage').upsert(nouveau, { onConflict: 'id', ignoreDuplicates: true }); if (error) { bilan.erreurs.push(numero + ' : ' + error.message); continue; } }
      bilan.creees++;
    }

    // lots d'ORIGEN (venus du SAIGIC ou d'un transfert) qu'on ne retrouve plus sur le SAIGIC : simple information
    if (corps?.complet === true) {
      const { data: tous } = await sb.from('lots_usinage').select('numero, origine').in('origine', ['saigic', 'transfert']);
      for (const x of (tous || []) as any[]) if (!vus.has(String(x.numero))) bilan.absents_du_saigic.push(String(x.numero));
    }
    return rep({ ok: true, dry_run: dry, ...bilan });
  } catch (e) {
    return rep({ error: String(e) }, 500);
  }
});
