/* BrainPreserve – Auto Nutrition Tables (Five Tables)
 * Drop-in file: /assets/nutrition-tables.js
 * Requires: Papa Parse (CDN) before this script
 * Renders automatically when you call: window.BP.renderTables(["Avocado","Cheddar","Eggs"]) 
 * or dispatch: window.dispatchEvent(new CustomEvent('bp:recipe-ready',{detail:{ingredients:[...]}}))
 *
 * What it does
 * 1) Robustly loads multiple CSVs (headers with quotes/commas OK) using Papa.parse
 * 2) Normalizes ingredient names (case/spacing/punctuation) + synonym map
 * 3) Merges rows across CSVs into a canonical per-ingredient record
 * 4) Renders the five required tables (Nutrition; Cognitive & Other Health Benefits; Diet Compatibility; Microbiome Benefit; Micronutrient Benefits)
 * 5) Shows clear diagnostics for unmapped ingredients / missing columns (no more silent N/A)
 *
 * How to configure
 * - Place your CSVs in /data with the exact filenames used below or change CSV_SOURCES URLs to match your repo paths.
 * - Ensure each CSV includes a primary key column that names the ingredient (default key: "Ingredient").
 * - You can extend the SYNONYMS map at the bottom without changing code.
 */
(function(){
  'use strict';

  // ------- Simple utility helpers -------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs={}) => Object.assign(document.createElement(tag), attrs);
  const text = (s) => document.createTextNode(String(s==null?"":s));

  // Inject minimal styles once
  (function injectStyles(){
    if ($('#bp-nutrition-styles')) return;
    const s = el('style', {id:'bp-nutrition-styles'});
    s.textContent = `
      #bp-nutrition{margin:24px 0}
      .bp-card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
      .bp-card h3{margin:0 0 12px 0;font-size:18px}
      .bp-table{width:100%;border-collapse:collapse;font-size:14px}
      .bp-table th,.bp-table td{border:1px solid #e5e7eb;padding:8px;vertical-align:top}
      .bp-table th{background:#f9fafb;text-align:left}
      .bp-note{color:#6b7280;font-size:12px;margin-top:8px}
      .bp-badge{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:9999px;padding:2px 8px;margin:2px;font-size:12px}
      .bp-warn{background:#fff7ed;border-left:4px solid #fb923c;padding:12px;border-radius:8px;margin:12px 0;color:#7c2d12}
      .bp-ok{background:#ecfdf5;border-left:4px solid #10b981;padding:12px;border-radius:8px;margin:12px 0;color:#065f46}
      .bp-muted{color:#6b7280}
      .bp-small{font-size:12px}
      .bp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    `;
    document.head.appendChild(s);
  })();

  // ------- CSV configuration -------
  // If your files use different names/paths, change here (not in the code below).
  // All CSVs must include a primary ingredient key column (default "Ingredient" or synonyms defined below).
  const CSV_SOURCES = [
    { name:'nutrition', url:'/data/nutrition.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:[
      'Serving Size (g)','ServingSize','Serving Size','Calories (kcal)','Calories','Protein (g)','Protein','Fiber (g)','Fiber','Fat (g)','Fat','Carbs (g)','Carbohydrates (g)'
    ]},
    { name:'gi_gl', url:'/data/gi_gl.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['GI','Glycemic Index','GL','Glycemic Load'] },
    { name:'dii', url:'/data/dii.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['DII','Anti-Inflammatory Score','Inflammatory Index'] },
    { name:'cog', url:'/data/cognitive_benefits.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['Direct Cognitive Benefits','Indirect Cognitive Benefits','Other Health Benefits'] },
    { name:'diet', url:'/data/diet_tags.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['MIND','DASH','Mediterranean','Low GI','Keto','Paleo','Vegan','Vegetarian','Gluten-Free','Dairy-Free'] },
    { name:'micro', url:'/data/microbiome.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['Microbiome Benefit','Prebiotic Fibers','Polyphenols'] },
    { name:'micros', url:'/data/micronutrients.csv', keyCandidates:['Ingredient','Food','Item'], expectAnyOf:['Vitamin A','Vitamin C','Vitamin E','B12','Folate','Magnesium','Zinc','Iron','Potassium','Choline','Omega-3'] },
    // Optional: synonyms CSV with two columns: Alias, Canonical
    { name:'synonyms', url:'/data/synonyms.csv', keyCandidates:['Alias'], expectAnyOf:['Canonical'], optional:true }
  ];

  // ------- Name normalization & synonyms -------
  const stripPunct = s => s.replace(/[()\[\]{}.,/!?:;"'`~]/g,' ');
  const normalize = s => stripPunct(String(s||'').toLowerCase()).replace(/\s+/g,' ').trim();
  const SYNONYMS = {
    'evoo':'olive oil (extra virgin)',
    'extra virgin olive oil':'olive oil (extra virgin)',
    'avocado oil (cold pressed)':'avocado oil',
    'tomatoes':'tomato', 'strawberries':'strawberry', 'eggs':'egg', 'walnuts':'walnut', 'almonds':'almond',
    'chickpea pasta':'pasta (chickpea)','wholegrain pasta':'pasta (whole grain)','sourdough pasta':'pasta (sourdough)',
    'cheddar cheese':'cheddar','parmigiano reggiano':'parmesan',
  };

  // ------- Data state -------
  const State = {
    ready:false,
    dataByKey: new Map(), // key -> merged record
    keyToDisplay: new Map(), // key -> original display name
    keyColByDataset: {},    // datasetName -> actual key column detected
    synonymsDynamic: new Map(),
    loadError:null
  };

  // ------- CSV Loader (Papa Parse required) -------
  async function fetchCsv(url){
    const res = await fetch(url, {cache:'no-store'});
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const text = await res.text();
    return new Promise((resolve,reject)=>{
      if (!window.Papa) return reject(new Error('Papa Parse is not loaded. Include it before nutrition-tables.js')); 
      Papa.parse(text, {header:true, skipEmptyLines:true, dynamicTyping:false, complete: results=>resolve(results.data), error: err=>reject(err)});
    });
  }

  function chooseKeyColumn(row, candidates){
    const cols = Object.keys(row||{});
    for (const cand of candidates){ if (cols.includes(cand)) return cand; }
    // Try loose match
    for (const c of cols){ if (normalize(c)==='ingredient') return c; }
    return null;
  }

  function detectColumns(rows){
    if (!rows || !rows.length) return new Set();
    return new Set(Object.keys(rows[0]));
  }

  function addSynonym(alias, canonical){
    if (!alias || !canonical) return;
    State.synonymsDynamic.set(normalize(alias), normalize(canonical));
  }

  function canonicalizeName(raw){
    let n = normalize(raw);
    if (State.synonymsDynamic.has(n)) n = State.synonymsDynamic.get(n);
    else if (SYNONYMS[n]) n = normalize(SYNONYMS[n]);
    return n;
  }

  function recordDisplayName(key, display){
    if (!State.keyToDisplay.has(key)) State.keyToDisplay.set(key, display||key);
  }

  function mergeRecord(datasetName, key, row){
    const rec = State.dataByKey.get(key) || { _key:key };
    for (const [k,v] of Object.entries(row)){
      if (k==='_dataset' || k==='_rawKey') continue;
      // Keep first non-empty value for stability; otherwise allow overwrite
      if (v!=='' && v!=null){
        if (rec[k]==null || String(rec[k]).trim()==='') rec[k]=v; else rec[k]=rec[k];
      }
    }
    State.dataByKey.set(key, rec);
  }

  async function loadAllCSVs(){
    try{
      for (const cfg of CSV_SOURCES){
        try{
          const rows = await fetchCsv(cfg.url);
          if ((!rows || rows.length===0) && cfg.optional) continue; 
          if (!rows || rows.length===0) throw new Error('No data rows');
          const keyCol = chooseKeyColumn(rows[0], cfg.keyCandidates);
          if (!keyCol) throw new Error(`Cannot find key column among: ${cfg.keyCandidates.join(', ')}`);
          State.keyColByDataset[cfg.name] = keyCol;
          const cols = detectColumns(rows);
          const foundExpect = cfg.expectAnyOf.some(c=>cols.has(c));
          if (!foundExpect && !cfg.optional){ console.warn(`[${cfg.name}] Expected columns not found. Continuing, but some table fields may be blank.`); }
          // Special: synonyms CSV
          if (cfg.name==='synonyms'){
            for (const r of rows){ addSynonym(r[keyCol], r['Canonical']); }
            continue;
          }
          for (const r of rows){
            const rawKey = r[keyCol];
            if (!rawKey) continue;
            const key = canonicalizeName(rawKey);
            recordDisplayName(key, rawKey);
            mergeRecord(cfg.name, key, Object.assign({_dataset:cfg.name,_rawKey:rawKey}, r));
          }
        }catch(e){
          if (cfg.optional){ console.info(`Optional dataset '${cfg.name}' not loaded: ${e.message}`); continue; }
          throw new Error(`Dataset '${cfg.name}' failed: ${e.message}`);
        }
      }
      State.ready = true;
    }catch(e){
      State.loadError = e;
      console.error('CSV load failed:', e);
    }
  }

  // ------- Public API -------
  const BP = window.BP || (window.BP = {});
  BP.normalizeName = canonicalizeName;
  BP.ready = (async ()=>{ await loadAllCSVs(); return true; })();

  // Try to derive ingredients from a free-text recipe (best-effort fallbacks)
  BP.deriveIngredientsFromRecipe = function(recipeText){
    if (!recipeText) return [];
    // naive: split by commas or newlines; trim; drop empties
    const parts = String(recipeText).split(/\n|,/).map(s=>s.trim()).filter(Boolean);
    // remove quantities (e.g., "1 cup spinach" -> "spinach")
    return parts.map(s=>{
      return s.replace(/^[-*\d\/.+\s]*(cup|cups|tbsp|tsp|oz|ounce|ounces|g|gram|grams|ml|cl|l|pound|lb|lbs)?\b/gi,'').trim();
    });
  }

  // ------- Rendering -------
  function ensureMount(){
    let root = $('#bp-nutrition');
    if (!root){ root = el('div',{id:'bp-nutrition'}); document.body.appendChild(root); }
    return root;
  }

  function hCard(title){
    const card = el('div',{className:'bp-card'});
    const h3 = el('h3'); h3.appendChild(text(title)); card.appendChild(h3);
    return {card,body:card};
  }

  function fmtNum(v){ if (v===undefined || v===null || v==='') return '—'; const n = Number(String(v).replace(/,/g,'')); return isFinite(n)? (Math.round(n*100)/100).toString(): String(v); }
  function yesNo(v){ if (v==null || v==='') return '—'; const s=String(v).trim().toLowerCase(); return (s==='1'||s==='y'||s==='yes'||s==='true')?'Yes':(s==='0'||s==='n'||s==='no'||s==='false')?'No':String(v); }

  function rowFor(key){ return State.dataByKey.get(key) || null; }
  function displayNameFor(key){ return State.keyToDisplay.get(key) || key; }

  function collectFor(keys){
    const out = [];
    for (const k of keys){ const r=rowFor(k); if (r) out.push(r); }
    return out;
  }

  function renderDiagnostics(root, requestedKeys){
    const missed = [];
    for (const r of requestedKeys){ if (!State.dataByKey.has(r)) missed.push(r); }
    if (State.loadError){
      const warn = el('div',{className:'bp-warn'});
      warn.innerHTML = `<strong>Data load error:</strong> ${State.loadError.message}. Ensure CSV paths exist and are accessible.`;
      root.appendChild(warn);
    } else if (missed.length){
      const warn = el('div',{className:'bp-warn'});
      const ul = missed.map(m=>`<li><code class="bp-mono">${m}</code> &rarr; consider adding to <code class="bp-mono">/data/synonyms.csv</code> or matching the <code class="bp-mono">Ingredient</code> name in your CSVs.</li>`).join('');
      warn.innerHTML = `<strong>Unmapped ingredients:</strong><ul>${ul}</ul>`;
      root.appendChild(warn);
    } else {
      const ok = el('div',{className:'bp-ok'});
      ok.textContent = 'All ingredients mapped successfully.';
      root.appendChild(ok);
    }
  }

  function table(headers, rows){
    const tbl = el('table',{className:'bp-table'});
    const thead = el('thead'); const trh = el('tr');
    for (const h of headers){ const th = el('th'); th.appendChild(text(h)); trh.appendChild(th); }
    thead.appendChild(trh); tbl.appendChild(thead);
    const tbody = el('tbody');
    for (const r of rows){ const tr = el('tr'); for (const c of r){ const td = el('td'); if (c instanceof Node) td.appendChild(c); else td.textContent = c==null?'—':String(c); tr.appendChild(td);} tbody.appendChild(tr); }
    tbl.appendChild(tbody); return tbl;
  }

  function sum(nums){ return nums.reduce((a,b)=>a+(isFinite(+b)?+b:0),0); }

  function renderNutritionCard(root, recs){
    const {card,body} = hCard('Nutrition Table');
    const headers = ['Ingredient','Serving (g)','Calories','Protein (g)','Fiber (g)','Fat (g)','Carbs (g)'];
    const rows = [];
    let totals = {g:0,kcal:0,p:0,fib:0,fat:0,carb:0};
    for (const r of recs){
      const g   = r['Serving Size (g)']||r['ServingSize']||r['Serving Size']||'';
      const kcal= r['Calories (kcal)']||r['Calories']||'';
      const p   = r['Protein (g)']||r['Protein']||'';
      const fib = r['Fiber (g)']||r['Fiber']||'';
      const fat = r['Fat (g)']||r['Fat']||'';
      const carb= r['Carbs (g)']||r['Carbohydrates (g)']||r['Carbohydrates']||'';
      rows.push([displayNameFor(r._key), fmtNum(g), fmtNum(kcal), fmtNum(p), fmtNum(fib), fmtNum(fat), fmtNum(carb)]);
      totals.g+=+g||0; totals.kcal+=+kcal||0; totals.p+=+p||0; totals.fib+=+fib||0; totals.fat+=+fat||0; totals.carb+=+carb||0;
    }
    // Totals row
    rows.push(['Total', fmtNum(totals.g), fmtNum(totals.kcal), fmtNum(totals.p), fmtNum(totals.fib), fmtNum(totals.fat), fmtNum(totals.carb)]);
    body.appendChild(table(headers, rows));
    root.appendChild(card);
  }

  function renderCognitiveCard(root, recs){
    const {card,body} = hCard('Cognitive & Other Health Benefits');
    const headers = ['Ingredient','Direct Cognitive Benefits','Indirect Cognitive Benefits'];
    const rows = [];
    for (const r of recs){
      rows.push([
        displayNameFor(r._key),
        r['Direct Cognitive Benefits']||'—',
        r['Indirect Cognitive Benefits']||'—'
      ]);
    }
    body.appendChild(table(headers, rows));
    root.appendChild(card);
  }

  function renderDietCompatCard(root, recs){
    const {card,body} = hCard('Diet Compatibility');
    const TAGS = ['MIND','DASH','Mediterranean','Low GI','Keto','Paleo','Vegan','Vegetarian','Gluten-Free','Dairy-Free'];
    const headers = ['Ingredient', ...TAGS];
    const rows = [];
    for (const r of recs){
      const row = [displayNameFor(r._key)];
      for (const t of TAGS){ row.push(yesNo(r[t])); }
      rows.push(row);
    }
    body.appendChild(table(headers, rows));
    root.appendChild(card);
  }

  function renderMicrobiomeCard(root, recs){
    const {card,body} = hCard('Microbiome Benefit');
    const headers = ['Ingredient','Microbiome Benefit'];
    const rows = [];
    for (const r of recs){ rows.push([displayNameFor(r._key), r['Microbiome Benefit']||r['Prebiotic Fibers']||r['Polyphenols']||'—']); }
    body.appendChild(table(headers, rows));
    root.appendChild(card);
  }

  function renderMicronutrientCard(root, recs){
    const {card,body} = hCard('Micronutrient Benefits');
    // Dynamically list micronutrient columns present in data
    const POSSIBLE = ['Vitamin A','Vitamin C','Vitamin D','Vitamin E','Vitamin K','B1','B2','B3','B5','B6','B7','B9','B12','Folate','Choline','Calcium','Magnesium','Zinc','Iron','Selenium','Potassium','Manganese','Copper','Omega-3'];
    const present = new Set();
    for (const r of recs){ for (const k of Object.keys(r)){ if (POSSIBLE.includes(k)) present.add(k); } }
    const cols = Array.from(present);
    const headers = ['Ingredient', ...cols];
    const rows = [];
    for (const r of recs){
      const row = [displayNameFor(r._key)];
      for (const c of cols){ row.push(fmtNum(r[c])); }
      rows.push(row);
    }
    body.appendChild(table(headers, rows));
    root.appendChild(card);
  }

  function renderGiDiiInline(root, recs){
    // Optional: small inline note under Nutrition for GI/GL and DII summaries
    const wrap = el('div',{className:'bp-note'});
    const giVals = recs.map(r=>r['GI']||r['Glycemic Index']).filter(v=>v!=''&&v!=null).map(Number).filter(n=>isFinite(n));
    const glVals = recs.map(r=>r['GL']||r['Glycemic Load']).filter(v=>v!=''&&v!=null).map(Number).filter(n=>isFinite(n));
    const diiVals= recs.map(r=>r['DII']||r['Anti-Inflammatory Score']).filter(v=>v!=''&&v!=null).map(Number).filter(n=>isFinite(n));
    const parts = [];
    if (giVals.length) parts.push(`Avg GI: ${Math.round(sum(giVals)/giVals.length)}`);
    if (glVals.length) parts.push(`Avg GL: ${Math.round(sum(glVals)/glVals.length)}`);
    if (diiVals.length) parts.push(`Avg DII: ${Math.round((sum(diiVals)/diiVals.length)*100)/100}`);
    if (parts.length){ wrap.textContent = parts.join('  •  '); root.querySelector('.bp-card').appendChild(wrap); }
  }

  BP.renderTables = async function(ingredients){
    const root = ensureMount();
    root.innerHTML = '';
    const title = el('div',{className:'bp-muted', innerHTML:'<strong>Nutrition & Brain Benefits</strong> – Auto-generated from your verified CSV data'});
    root.appendChild(title);

    await BP.ready; // ensure datasets are loaded
    const requested = (ingredients||[]).map(s=>canonicalizeName(s)).filter(Boolean);

    renderDiagnostics(root, requested);

    const recs = collectFor(requested);
    if (!recs.length){
      const warn = el('div',{className:'bp-warn'}); warn.textContent = 'No matching ingredients were found in your CSV datasets.'; root.appendChild(warn); return;
    }

    // 1) Nutrition
    renderNutritionCard(root, recs);
    renderGiDiiInline(root, recs);
    // 2) Cognitive & Other Health Benefits
    renderCognitiveCard(root, recs);
    // 3) Diet Compatibility
    renderDietCompatCard(root, recs);
    // 4) Microbiome
    renderMicrobiomeCard(root, recs);
    // 5) Micronutrient Benefits
    renderMicronutrientCard(root, recs);
  }

  // Listen for custom event so you don’t have to wire function calls deep in your code if you prefer events.
  window.addEventListener('bp:recipe-ready', async (e)=>{
    try{
      const list = (e && e.detail && Array.isArray(e.detail.ingredients)) ? e.detail.ingredients : [];
      await BP.renderTables(list);
    }catch(err){ console.error('bp:recipe-ready handler failed', err); }
  }, false);

})();
