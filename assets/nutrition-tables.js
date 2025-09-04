
/*! Nutrition Tables Add-on (Drop-in) v1.3
 *  What's new:
 *   • Auto-detect recipe text in: #custom-output, #form-output (in addition to prior candidates)
 *   • New button: "Generate from current selections (no AI)" — builds 5 tables from checked ingredients
 *   • Still supports paste-fallback
 *  Data files (under /data/):
 *    - mapping_nutrition.csv
 *    - mapping_cognitive_other.csv
 *    - mapping_diet_compat.csv
 *    - mapping_microbiome.csv
 *    - mapping_micronutrients.csv
 *    - settings_global.csv  (optional; may contain alias/canonical pairs)
 *
 *  Requires Papa Parse (CDN):
 *    <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
 *
 *  Safe add-on: does NOT modify your recipe generator. It only reads DOM and appends tables.
 */
(function () {
  "use strict";

  // ---------- CONFIG ----------
  const CONFIG = {
    CSV_BASE_URL: "/data/",
    FILES: {
      settings: "settings_global.csv",          // set to null if not present
      main: "mapping_nutrition.csv",
      benefits: "mapping_cognitive_other.csv",
      diet: "mapping_diet_compat.csv",
      microbiome: "mapping_microbiome.csv",
      micronutrients: "mapping_micronutrients.csv"
    },
    // Expanded candidates to match your app's actual output nodes
    SELECTORS_RECIPE_CANDIDATES: [
      "#custom-output",
      "#form-output",
      "#nutrition-root",            // in case text lands here
      "#recipeOutput",
      "#generatedRecipe",
      "#result",
      ".recipe-output",
      ".recipe",
      "#output"
    ],
    TABLES_ROOT_SELECTOR: "#nutrition-tables-root",
    FIELD_ALIASES: {
      canonical: ["canonical","canonical_name","ingredient","food","item","name"],
      alias: ["alias","synonym","alt","alt_name","alias_name"],
      // Macro / core measures
      calories: ["calories","kcal","energy_kcal","kcal_per100","calories_per100"],
      protein_g: ["protein","protein_g","prot_g","protein_per100_g","protein_per100"],
      fiber_g: ["fiber","fibre","fiber_g","dietary_fiber_g","fiber_per100_g"],
      carbs_g: ["carbs","carbohydrates","carbohydrate_g","net_carb_g","carb_g","carbs_per100_g"],
      fat_g: ["fat","fat_g","total_fat_g","fat_per100_g"],
      gi: ["gi","glycemic_index","GI"],
      gl: ["gl","glycemic_load","GL"],
      dii: ["dii","anti-inflammatory_score","inflammatory_index","DII"],
      // Base amounts
      per_100g_flag: ["per_100g","per100g","basis_100g"],
      serving_size_g: ["serving_size_g","serving_g","portion_g","default_portion_g","portion_size_g","serving_g_estimate"],
      // Diet tags (detected dynamically if present)
      diet_tags: ["MIND","DASH","Mediterranean","Vegan","Vegetarian","Pescatarian","Gluten-Free","Keto","Paleo","Low-FODMAP"],
      // Benefit tags
      benefit_cols: ["benefits","neuro_benefits","cognitive_benefits","tags","cognitive_other"],
      // Microbiome signals
      microbiome_cols: ["microbiome","microbiome_benefits","gut_tags","taxa"],
      // Micronutrients
      micronutrient_cols: ["micronutrients","nutrients","top_micronutrients"]
    },
    UI: {
      buttonLabelAuto: "Generate 5 Nutrition Tables (auto-detect recipe text)",
      buttonLabelSelections: "Generate from current selections (no AI)",
      pasteFallbackTitle: "Paste the recipe text (only if auto-detect fails)",
      pasteFallbackPlaceholder: "Paste the full recipe here, including an 'Ingredients' section...",
      statusLoading: "Loading CSV datasets and analyzing...",
      statusDone: "Tables generated.",
      statusErrorCSV: "Could not load one or more required CSV files. Check file names and CSV_BASE_URL in CONFIG.",
      statusErrorPapa: "Papa Parse is missing. Add the CDN script tag noted at the top of this file."
    }
  };
  // ---------- END CONFIG ----------

  // Utility helpers
  function getField(row, candidates) {
    if (!row || !candidates) return undefined;
    const keys = Object.keys(row);
    for (const cand of candidates) {
      const hit = keys.find(k => k.toLowerCase() === String(cand).toLowerCase());
      if (hit) return row[hit];
    }
    for (const k of keys) { if (candidates.includes(k)) return row[k]; }
    return undefined;
  }
  function visible(el) { return el && el.offsetParent !== null; }
  function loadCSV(url) {
    return new Promise((resolve, reject) => {
      if (!window.Papa) { reject(new Error(CONFIG.UI.statusErrorPapa)); return; }
      window.Papa.parse(url, {
        download: true, header: true, dynamicTyping: true, skipEmptyLines: true,
        complete: r => resolve(r.data || []), error: err => reject(err)
      });
    });
  }
  async function loadCSVOptional(url) {
    try { const rows = await loadCSV(url); return Array.isArray(rows) ? rows : []; }
    catch { return []; }
  }
  async function loadDatasets() {
    const b = CONFIG.CSV_BASE_URL, f = CONFIG.FILES;
    try {
      const [settings, main, benefits, diet, microbiome, micronutrients] = await Promise.all([
        f.settings ? loadCSVOptional(b + f.settings) : Promise.resolve([]),
        loadCSV(b + f.main),
        loadCSV(b + f.benefits),
        loadCSV(b + f.diet),
        loadCSV(b + f.microbiome),
        loadCSV(b + f.micronutrients)
      ]);
      return { settings, main, benefits, diet, microbiome, micronutrients };
    } catch (e) {
      console.error(e);
      throw new Error(CONFIG.UI.statusErrorCSV + " Details: " + (e.message || e));
    }
  }
  function buildAliasMapFromRows(rows) {
    const A = CONFIG.FIELD_ALIASES;
    const map = new Map(); const canonicalSet = new Set();
    for (const r of rows || []) {
      const alias = getField(r, A.alias);
      const canonical = getField(r, A.canonical) || alias;
      if (!alias) continue;
      const k = String(alias).trim().toLowerCase();
      const v = String(canonical || "").trim();
      if (!k || !v) continue;
      if (!map.has(k)) map.set(k, v);
      canonicalSet.add(v.toLowerCase());
    }
    return { map, canonicalSet };
  }
  function canonicalUniverseFromMain(mainRows) {
    const A = CONFIG.FIELD_ALIASES, set = new Set();
    for (const r of mainRows || []) {
      const c = (getField(r, A.canonical) || getField(r, ["ingredient","food","name","item"]) || "").toString().trim().toLowerCase();
      if (c) set.add(c);
    }
    return set;
  }
  function indexByCanonical(rows) {
    const A = CONFIG.FIELD_ALIASES; const by = new Map();
    for (const r of rows || []) {
      const c = (getField(r, A.canonical) || getField(r, ["ingredient","food","name","item"]) || "").toString().trim();
      if (!c) continue;
      if (!by.has(c)) by.set(c, []);
      by.get(c).push(r);
    }
    return by;
  }
  function extractIngredientsFromText(text) {
    if (!text) return [];
    const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let startIdx = lines.findIndex(s => /^ingredients\b/i.test(s));
    if (startIdx === -1) startIdx = 0;
    const out = [];
    for (let i = startIdx + (lines[startIdx] && /^ingredients\b/i.test(lines[startIdx]) ? 1 : 0); i < lines.length; i++) {
      const L = lines[i]; if (!L) break;
      if (/^(directions|instructions|method|steps)\b/i.test(L)) break;
      if (/^[-*•\d.)\]]\s*/.test(L) || /cup|tbsp|tsp|oz|g|gram|ml|lb|teaspoon|tablespoon|ounce|liter|litre|cup/i.test(L)) {
        out.push(L.replace(/^[-*•\d.)\]]\s*/, "").trim()); continue;
      }
      if (/serv(es|ings)|prep time|cook time|yield|nutrition/i.test(L)) break;
      if (L.split(" ").length <= 8) out.push(L);
    }
    return out.filter(Boolean);
  }
  function extractIngredientsFromDOM() {
    for (const sel of CONFIG.SELECTORS_RECIPE_CANDIDATES) {
      const el = document.querySelector(sel);
      if (el && (visible(el) || (el.textContent && el.textContent.trim().length > 0))) {
        const txt = el.innerText || el.textContent || "";
        const parsed = extractIngredientsFromText(txt);
        if (parsed && parsed.length) return parsed;
      }
    }
    const allText = document.body.innerText || document.body.textContent || "";
    const parsed = extractIngredientsFromText(allText);
    if (parsed && parsed.length) return parsed;
    return null;
  }
  function normalizeIngredientLine(line) {
    let s = String(line).toLowerCase();
    s = s.replace(/(\d+\/\d+)|[¼½¾⅓⅔⅛⅜⅝⅞]|\b\d+(\.\d+)?\b/g, " ").trim();
    s = s.replace(/\b(cups?|cup|tbsp|tablespoons?|tbsps?|tsp|teaspoons?|tsps?|oz|ounce|ounces|g|grams?|kg|kilograms?|ml|milliliters?|liter|litre|lbs?|pounds?)\b/g, " ");
    s = s.replace(/\b(chopped|minced|diced|sliced|ground|fresh|large|small|medium|ripe|raw|cooked|drained|rinsed|packed|peeled|seeded|to taste)\b/g, " ");
    s = s.replace(/[^a-z\s\-]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (s.endsWith("es")) s = s.slice(0, -2);
    else if (s.endsWith("s")) s = s.slice(0, -1);
    return s.trim();
  }
  function mapToCanonical(norm, aliasMap, aliasCanonLower, mainCanonLower) {
    if (!norm) return null;
    // explicit alias first
    if (aliasMap && aliasMap.size) {
      const direct = aliasMap.get(norm);
      if (direct) return { canonical: direct, confidence: 1.0 };
      const parts = norm.split(" ").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const tail = parts.slice(i).join(" ");
        const hit = aliasMap.get(tail);
        if (hit) return { canonical: hit, confidence: 0.9 - i * 0.05 };
      }
      for (const [alias, canon] of aliasMap.entries()) {
        if (norm.includes(alias)) return { canonical: canon, confidence: 0.6 };
      }
    }
    // fallback to main canonicals
    if (mainCanonLower && mainCanonLower.size) {
      if (mainCanonLower.has(norm)) return { canonical: norm, confidence: 0.95 };
      let best = null;
      for (const c of mainCanonLower) {
        if (norm === c || norm.endsWith(" " + c) || norm.startsWith(c + " ") || norm.includes(c)) {
          const conf = Math.min(0.9, 0.55 + c.length / Math.max(8, norm.length));
          if (!best || conf > best.confidence) best = { canonical: c, confidence: conf };
        }
      }
      if (best) return best;
    }
    if (aliasCanonLower && aliasCanonLower.size) {
      for (const c of aliasCanonLower) {
        if (norm === c) return { canonical: c, confidence: 0.75 };
        if (norm.includes(c)) return { canonical: c, confidence: 0.65 };
      }
    }
    return null;
  }
  function num(row, aliasList) {
    const v = getField(row, aliasList);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function resolvePortionGrams(row, A) {
    const explicit = num(row, A.serving_size_g);
    if (explicit && explicit > 0) return explicit;
    return 100;
  }
  function computeMacros(row, A, portion_g) {
    const calories = num(row, A.calories);
    const protein_g = num(row, A.protein_g);
    const fiber_g = num(row, A.fiber_g);
    const carbs_g = num(row, A.carbs_g);
    const fat_g = num(row, A.fat_g);
    const gi = num(row, A.gi);
    const gl = num(row, A.gl);
    const dii = num(row, A.dii);
    const scale = portion_g / 100;
    return {
      calories: isFinite(calories) ? calories * scale : null,
      protein_g: isFinite(protein_g) ? protein_g * scale : null,
      fiber_g: isFinite(fiber_g) ? fiber_g * scale : null,
      carbs_g: isFinite(carbs_g) ? carbs_g * scale : null,
      fat_g: isFinite(fat_g) ? fat_g * scale : null,
      gi: isFinite(gi) ? gi : null,
      gl: isFinite(gl) ? gl * scale : null,
      dii: isFinite(dii) ? dii : null
    };
  }
  function formatNum(x, d=1) { return (x==null || !isFinite(x)) ? "N/A" : Number(x).toFixed(d); }
  function makeTable(titleText, headers, rows) {
    const wrap = document.createElement("section"); wrap.className = "nt-section";
    const h2 = document.createElement("h2"); h2.className = "nt-title"; h2.textContent = titleText; wrap.appendChild(h2);
    const table = document.createElement("table"); table.className = "nt-table";
    const thead = document.createElement("thead"); const hr = document.createElement("tr");
    headers.forEach(h => { const th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(r => { const tr = document.createElement("tr"); r.forEach(c => { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }); tbody.appendChild(tr); });
    table.appendChild(tbody); wrap.appendChild(table); return wrap;
  }
  function toMarkdownTable(headers, rows) {
    const headerLine = "| " + headers.join(" | ") + " |";
    const sep = "| " + headers.map(()=>"---").join(" | ") + " |";
    const body = rows.map(r => "| " + r.join(" | ") + " |").join("\n");
    return [headerLine, sep, body].join("\n");
  }
  function addCopyMarkdownButton(container, title, headers, rows) {
    const btn = document.createElement("button"); btn.className = "nt-btn-secondary"; btn.textContent = "Copy as Markdown";
    btn.addEventListener("click", () => {
      const md = `### ${title}\n\n` + toMarkdownTable(headers, rows);
      navigator.clipboard.writeText(md).then(() => { btn.textContent = "Copied!"; setTimeout(()=>btn.textContent="Copy as Markdown",1200); });
    });
    container.appendChild(btn);
  }
  function ensureUIRoot() {
    let root = document.querySelector(CONFIG.TABLES_ROOT_SELECTOR);
    if (!root) { root = document.createElement("div"); root.id = CONFIG.TABLES_ROOT_SELECTOR.replace("#",""); document.body.appendChild(root); }
    root.classList.add("nt-root");
    if (!root.querySelector(".nt-controls")) {
      const controls = document.createElement("div"); controls.className = "nt-controls";
      const btnAuto = document.createElement("button"); btnAuto.className = "nt-btn"; btnAuto.textContent = CONFIG.UI.buttonLabelAuto;
      btnAuto.addEventListener("click", () => window.generateTablesFromLatestRecipe());
      const btnSel = document.createElement("button"); btnSel.className = "nt-btn"; btnSel.textContent = CONFIG.UI.buttonLabelSelections;
      btnSel.addEventListener("click", () => window.generateTablesFromSelectionsNoAI());
      const status = document.createElement("span"); status.className = "nt-status"; status.textContent = "";
      controls.appendChild(btnAuto); controls.appendChild(btnSel); controls.appendChild(status); root.appendChild(controls);

      const fallback = document.createElement("details"); fallback.className = "nt-fallback";
      const sum = document.createElement("summary"); sum.textContent = CONFIG.UI.pasteFallbackTitle;
      const ta = document.createElement("textarea"); ta.placeholder = CONFIG.UI.pasteFallbackPlaceholder; ta.rows = 8;
      const go = document.createElement("button"); go.className = "nt-btn-secondary"; go.textContent = "Generate from pasted recipe";
      go.addEventListener("click", async () => { await window.generateTablesFromRecipeText(ta.value); });
      fallback.appendChild(sum); fallback.appendChild(ta); fallback.appendChild(go); root.appendChild(fallback);
    }
    let tables = root.querySelector(".nt-tables"); if (!tables) { tables = document.createElement("div"); tables.className = "nt-tables"; root.appendChild(tables); }
    return root;
  }
  function setStatus(msg) {
    const root = document.querySelector(CONFIG.TABLES_ROOT_SELECTOR);
    const el = root ? root.querySelector(".nt-status") : null;
    if (el) el.textContent = msg || "";
  }

  // Public APIs
  window.generateTablesFromLatestRecipe = async function () {
    const root = ensureUIRoot(); const tables = root.querySelector(".nt-tables"); tables.innerHTML = ""; setStatus(CONFIG.UI.statusLoading);
    try {
      const datasets = await loadDatasets();
      const { settings, main, benefits, diet, microbiome, micronutrients } = datasets;
      const aliasInfo = buildAliasMapFromRows(settings);
      const aliasMap = aliasInfo.map;
      const aliasCanonLower = aliasInfo.canonicalSet;
      const mainCanonLower = canonicalUniverseFromMain(main);
      const lines = extractIngredientsFromDOM();
      if (!lines || !lines.length) { setStatus(""); alert("Couldn't auto-detect ingredients. Use the paste panel or the selections button."); return; }
      await buildAllTables(lines, datasets, aliasMap, aliasCanonLower, mainCanonLower, tables);
      setStatus(CONFIG.UI.statusDone);
    } catch (e) { setStatus(""); alert(e.message || String(e)); }
  };

  // New: generate from current checkbox selections (no AI required)
  window.generateTablesFromSelectionsNoAI = async function () {
    const root = ensureUIRoot(); const tables = root.querySelector(".nt-tables"); tables.innerHTML = ""; setStatus(CONFIG.UI.statusLoading);
    try {
      const datasets = await loadDatasets();
      const { settings, main, benefits, diet, microbiome, micronutrients } = datasets;
      const aliasInfo = buildAliasMapFromRows(settings);
      const aliasMap = aliasInfo.map;
      const aliasCanonLower = aliasInfo.canonicalSet;
      const mainCanonLower = canonicalUniverseFromMain(main);

      // Collect checked ingredient names from your page
      const inputs = document.querySelectorAll('input[type=checkbox][data-cat]:checked');
      const names = Array.from(inputs).map(i => i.value).filter(v => v && !/^GPT CHOOSES/i.test(v));
      if (!names.length) { setStatus(""); alert("No ingredients selected."); return; }
      await buildAllTables(names, datasets, aliasMap, aliasCanonLower, mainCanonLower, tables);
      setStatus(CONFIG.UI.statusDone);
    } catch (e) { setStatus(""); alert(e.message || String(e)); }
  };

  window.generateTablesFromRecipeText = async function (text) {
    const root = ensureUIRoot(); const tables = root.querySelector(".nt-tables"); tables.innerHTML = ""; setStatus(CONFIG.UI.statusLoading);
    try {
      const datasets = await loadDatasets();
      const { settings, main, benefits, diet, microbiome, micronutrients } = datasets;
      const aliasInfo = buildAliasMapFromRows(settings);
      const aliasMap = aliasInfo.map;
      const aliasCanonLower = aliasInfo.canonicalSet;
      const mainCanonLower = canonicalUniverseFromMain(main);
      const lines = extractIngredientsFromText(text);
      if (!lines || !lines.length) { setStatus(""); alert("No ingredients found in the pasted text."); return; }
      await buildAllTables(lines, datasets, aliasMap, aliasCanonLower, mainCanonLower, tables);
      setStatus(CONFIG.UI.statusDone);
    } catch (e) { setStatus(""); alert(e.message || String(e)); }
  };

  async function buildAllTables(linesOrNames, datasets, aliasMap, aliasCanonLower, mainCanonLower, tablesContainer) {
    const A = CONFIG.FIELD_ALIASES;
    const mainIdx = indexByCanonical(datasets.main);
    const dietIdx = indexByCanonical(datasets.diet);
    const benIdx = indexByCanonical(datasets.benefits);
    const microbIdx = indexByCanonical(datasets.microbiome);
    const microNutrIdx = indexByCanonical(datasets.micronutrients);

    // Map ingredient lines/names to canonicals
    const mapped = [];
    for (const raw of linesOrNames) {
      const norm = normalizeIngredientLine(raw);
      if (!norm) continue;
      const m = mapToCanonical(norm, aliasMap, aliasCanonLower, mainCanonLower);
      if (m) {
        // harmonize display case using main index keys when possible
        let display = m.canonical;
        for (const key of mainIdx.keys()) { if (String(key).toLowerCase() === String(m.canonical).toLowerCase()) { display = key; break; } }
        mapped.push({ src: raw, canonical: display, confidence: m.confidence });
      } else {
        mapped.push({ src: raw, canonical: null, confidence: 0 });
      }
    }

    const perIngredient = [];
    let total = { calories: 0, protein_g: 0, fiber_g: 0, carbs_g: 0, fat_g: 0, gl: 0 };
    let giWeightedCarb = 0, totalCarbForGI = 0;
    let diiWeightedMass = 0, totalMassForDII = 0;

    for (const m of mapped) {
      const rows = m.canonical ? mainIdx.get(m.canonical) : null;
      const mainRow = rows && rows.length ? rows[0] : null;
      if (!mainRow) {
        perIngredient.push({ ingredient: m.src, canonical: m.canonical || "Unmapped", calories:null, protein_g:null, fiber_g:null, carbs_g:null, fat_g:null, gi:null, gl:null, dii:null });
        continue;
      }
      const portion_g = resolvePortionGrams(mainRow, A);
      const mac = computeMacros(mainRow, A, portion_g);
      perIngredient.push({ ingredient: m.src, canonical: m.canonical, portion_g, ...mac });

      if (mac.calories != null) total.calories += mac.calories;
      if (mac.protein_g != null) total.protein_g += mac.protein_g;
      if (mac.fiber_g != null) total.fiber_g += mac.fiber_g;
      if (mac.carbs_g != null) total.carbs_g += mac.carbs_g;
      if (mac.fat_g != null) total.fat_g += mac.fat_g;
      if (mac.gl != null) total.gl += mac.gl;
      if (mac.gi != null && mac.carbs_g != null) { giWeightedCarb += mac.gi * mac.carbs_g; totalCarbForGI += mac.carbs_g; }
      if (mac.dii != null && portion_g != null) { diiWeightedMass += mac.dii * portion_g; totalMassForDII += portion_g; }
    }

    const overallGI = totalCarbForGI > 0 ? giWeightedCarb / totalCarbForGI : null;
    const overallDII = totalMassForDII > 0 ? diiWeightedMass / totalMassForDII : null;

    // Table 1: Nutrition
    const t1Headers = ["Ingredient","Calories","Protein (g)","Fiber (g)","Carbs (g)","Fat (g)","GI","GL","DII (lower is better)"];
    const t1Rows = perIngredient.map(r => [ r.ingredient, formatNum(r.calories,0), formatNum(r.protein_g,1), formatNum(r.fiber_g,1), formatNum(r.carbs_g,1), formatNum(r.fat_g,1), formatNum(r.gi,0), formatNum(r.gl,1), formatNum(r.dii,2) ]);
    t1Rows.push([ "TOTAL / WEIGHTED AVG", formatNum(total.calories,0), formatNum(total.protein_g,1), formatNum(total.fiber_g,1), formatNum(total.carbs_g,1), formatNum(total.fat_g,1), formatNum(overallGI,0), formatNum(total.gl,1), formatNum(overallDII,2) ]);
    const t1 = makeTable("Nutrition", t1Headers, t1Rows); addCopyMarkdownButton(t1, "Nutrition", t1Headers, t1Rows); tablesContainer.appendChild(t1);

    // Table 2: Cognitive & Other Health Benefits
    const t2Headers = ["Ingredient","Benefits"];
    const t2Rows = perIngredient.map(r => {
      const rows = benIdx.get(r.canonical || "") || [];
      const cols = CONFIG.FIELD_ALIASES.benefit_cols;
      const tags = new Set();
      for (const br of rows) { for (const col of cols) { const v = getField(br, [col]); if (v) String(v).split(/[;,|]/).map(s=>s.trim()).filter(Boolean).forEach(x=>tags.add(x)); } }
      return [r.ingredient, Array.from(tags).slice(0,8).join(", ") || "—"];
    });
    const t2 = makeTable("Cognitive & Other Health Benefits", t2Headers, t2Rows); addCopyMarkdownButton(t2, "Cognitive & Other Health Benefits", t2Headers, t2Rows); tablesContainer.appendChild(t2);

    // Table 3: Diet Compatibility
    const dietAny = datasets.diet || []; const dietHeaders = dietAny.length ? Object.keys(dietAny[0]) : [];
    const knownDietCols = CONFIG.FIELD_ALIASES.diet_tags.filter(col => dietHeaders.some(h => h.toLowerCase() === col.toLowerCase()));
    const t3Headers = ["Diet","Compatible?","Notes"]; const t3Rows = [];
    if (knownDietCols.length) {
      for (const dietName of knownDietCols) {
        let anyNo = false, anyUnknown = false; const offenders = [];
        for (const r of perIngredient) {
          const rows = dietIdx.get(r.canonical || "") || [];
          if (!rows.length) { anyUnknown = true; continue; }
          const v = getField(rows[0], [dietName]); const vStr = String(v || "").trim().toLowerCase();
          if (!vStr) { anyUnknown = true; continue; }
          const isYes = vStr === "y" || vStr === "yes" || vStr === "true" || vStr === "1";
          if (!isYes) { anyNo = true; offenders.push(r.ingredient); }
        }
        let compat = "Yes", notes = "";
        if (anyNo) { compat = "No"; notes = offenders.length ? ("Swap: " + offenders.slice(0,5).join(", ")) : ""; }
        else if (anyUnknown) { compat = "Likely"; notes = "Some ingredients unknown"; }
        t3Rows.push([dietName, compat, notes || ""]);
      }
    } else { t3Rows.push(["—","—","No diet tag columns detected in data"]); }
    const t3 = makeTable("Diet Compatibility", t3Headers, t3Rows); addCopyMarkdownButton(t3, "Diet Compatibility", t3Headers, t3Rows); tablesContainer.appendChild(t3);

    // Table 4: Microbiome Benefit
    const t4Headers = ["Ingredient","Microbiome Benefits"];
    const t4Rows = perIngredient.map(r => {
      const rows = microbIdx.get(r.canonical || "") || []; const cols = CONFIG.FIELD_ALIASES.microbiome_cols; const tags = new Set();
      for (const mr of rows) { for (const col of cols) { const v = getField(mr, [col]); if (v) String(v).split(/[;,|]/).map(s=>s.trim()).filter(Boolean).forEach(x=>tags.add(x)); } }
      return [r.ingredient, Array.from(tags).slice(0,8).join(", ") || "—"];
    });
    const t4 = makeTable("Microbiome Benefit", t4Headers, t4Rows); addCopyMarkdownButton(t4, "Microbiome Benefit", t4Headers, t4Rows); tablesContainer.appendChild(t4);

    // Table 5: Micronutrient Benefits
    const t5Headers = ["Ingredient","Top Micronutrients"];
    const t5Rows = perIngredient.map(r => {
      const rows = microNutrIdx.get(r.canonical || "") || []; const cols = CONFIG.FIELD_ALIASES.micronutrient_cols; const tags = new Set();
      for (const nr of rows) { for (const col of cols) { const v = getField(nr, [col]); if (v) String(v).split(/[;,|]/).map(s=>s.trim()).filter(Boolean).forEach(x=>tags.add(x)); } }
      return [r.ingredient, Array.from(tags).slice(0,10).join(", ") || "—"];
    });
    const t5 = makeTable("Micronutrient Benefits", t5Headers, t5Rows); addCopyMarkdownButton(t5, "Micronutrient Benefits", t5Headers, t5Rows); tablesContainer.appendChild(t5);
  }

  document.addEventListener("DOMContentLoaded", ensureUIRoot);
})();
