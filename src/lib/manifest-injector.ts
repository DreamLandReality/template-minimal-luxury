/**
 * Dream Reality — Manifest Injector
 *
 * Activates ONLY when ?manifest=<url> is in the URL.
 * Fetches an external manifest JSON and applies it to the page,
 * overriding the baked-in static data via data-dr-* attributes.
 *
 * This enables re-editing a deployed site by injecting a modified
 * manifest from the admin panel API or any trusted HTTPS endpoint.
 *
 * Security:
 *   - Only fetches from HTTPS URLs (+ localhost for dev)
 *   - Validates response is valid JSON with a sections array
 *
 * Zero overhead if ?manifest param is absent — the entire module no-ops.
 *
 * Copy this file into any new template at: src/lib/manifest-injector.ts
 * Import it in BaseLayout.astro or page files:
 *   import '../lib/manifest-injector';
 */

// ─── Guard ──────────────────────────────────────────────────────────

const manifestUrl = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('manifest')
  : null;

if (manifestUrl) {
  initManifestInjector(manifestUrl);
}

// ─── Main ───────────────────────────────────────────────────────────

async function initManifestInjector(url: string): Promise<void> {
  // Security: only allow HTTPS URLs (or localhost for dev)
  if (
    !url.startsWith('https://') &&
    !url.startsWith('http://localhost') &&
    !url.startsWith('http://127.0.0.1')
  ) {
    console.warn('[manifest-injector] Blocked non-HTTPS manifest URL:', url);
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      console.error('[manifest-injector] Failed to fetch manifest:', response.status);
      return;
    }

    const manifest = await response.json();

    if (!manifest || !Array.isArray(manifest.sections)) {
      console.error('[manifest-injector] Invalid manifest shape — missing sections array');
      return;
    }

    applyManifest(manifest);

    // Evaluate declarative conditions (show-when, hide-when, effect-when)
    const cachedData: Record<string, Record<string, any>> = {};
    for (const section of manifest.sections) {
      if (section.data) cachedData[section.id] = section.data;
    }
    evaluateConditions(cachedData);

    console.log('[manifest-injector] Manifest applied successfully');
  } catch (err) {
    console.error('[manifest-injector] Error:', err);
  }
}

// ─── Apply Manifest ─────────────────────────────────────────────────

function applyManifest(manifest: any): void {
  // Build collection item index for reference resolution
  const collectionIndex = new Map<string, any>();
  for (const col of manifest.collections ?? []) {
    for (const item of col.data ?? []) {
      if (item.id) collectionIndex.set(item.id, item);
    }
  }

  // Apply theme CSS variables
  const themeSection = manifest.sections.find((s: any) => s.id === 'theme');
  if (themeSection?.data) {
    applyThemeCssVars(themeSection.data);
  }

  // Apply section data
  for (const section of manifest.sections) {
    if (section.id === 'theme') continue;

    const sectionEl = document.querySelector(`[data-dr-section="${section.id}"]`);
    if (!sectionEl) continue;

    // Handle enabled/disabled
    if (section.enabled === false) {
      (sectionEl as HTMLElement).style.display = 'none';
      continue;
    } else {
      (sectionEl as HTMLElement).style.display = '';
    }

    if (!section.data) continue;

    // Resolve collection references in section data
    const data = resolveCollectionRefs(section, collectionIndex);

    // Apply style overrides from styleOverrides block
    const sOverrides = (manifest as any).styleOverrides;
    if (sOverrides?.[section.id]) {
      applyStyleOverrides(section.id, sOverrides[section.id]);
    }

    // Apply fields
    for (const [field, value] of Object.entries(data)) {
      if (field.endsWith('__style')) continue; // Skip inline style keys (handled via styleOverrides)

      if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
        // Nested object — update dot-notation fields
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, any>)) {
          updateField(sectionEl, `${field}.${nestedKey}`, nestedValue);
        }
      } else if (Array.isArray(value)) {
        updateArrayField(sectionEl, field, value);
      } else {
        updateField(sectionEl, field, value);
      }
    }
  }
}

// ─── Theme ──────────────────────────────────────────────────────────

function applyThemeCssVars(themeData: any): void {
  const style = document.documentElement.style;
  const colors = themeData?.colors ?? {};
  const typography = themeData?.typography ?? {};
  const radius = themeData?.radius ?? {};

  if (colors.primary) style.setProperty('--primary', colors.primary);
  if (colors.primaryForeground) style.setProperty('--primary-foreground', colors.primaryForeground);
  if (colors.background) style.setProperty('--background', colors.background);
  if (colors.surface) style.setProperty('--surface', colors.surface);
  if (colors.muted) style.setProperty('--muted', colors.muted);
  if (colors.border) style.setProperty('--border', colors.border);
  if (typography.fontSans) style.setProperty('--font-sans', typography.fontSans);
  if (typography.fontSerif) style.setProperty('--font-serif', typography.fontSerif);
  if (radius.base) style.setProperty('--radius', radius.base);
}

// ─── Collection References ──────────────────────────────────────────

function resolveCollectionRefs(section: any, index: Map<string, any>): Record<string, any> {
  const data = { ...section.data };
  const schema = section.schema?.properties ?? {};

  for (const [key, fieldSchema] of Object.entries(schema) as [string, any][]) {
    if (fieldSchema.uiWidget === 'collectionPicker' && Array.isArray(data[key])) {
      const refs = data[key];
      if (refs.length > 0 && typeof refs[0] === 'string') {
        data[key] = refs
          .map((id: string) => index.get(id))
          .filter((item: any) => !!item);
      }
    }
  }

  return data;
}

// ─── Style Override Helpers ──────────────────────────────────────

/**
 * Apply style overrides for a single section by injecting a <style> element.
 * Handles both flat values ("0.5em") and responsive objects { mobile, tablet, desktop }.
 */
function applyStyleOverrides(
  sectionId: string,
  fields: Record<string, Record<string, unknown>>
): void {
  const rules: string[] = [];
  for (const [field, props] of Object.entries(fields)) {
    const selector = field === '__section'
      ? `[data-dr-section="${sectionId}"]`
      : `[data-dr-section="${sectionId}"] [data-dr-style="${field}"]`;

    for (const [cssProp, value] of Object.entries(props)) {
      const kebab = cssProp.replace(/[A-Z]/g, (m: string) => `-${m.toLowerCase()}`);
      const isResponsive = typeof value === 'object' && value !== null
        && ('mobile' in value || 'tablet' in value || 'desktop' in value);

      if (isResponsive) {
        const rv = value as { mobile?: string; tablet?: string; desktop?: string };
        if (rv.mobile) rules.push(`${selector} { ${kebab}: ${rv.mobile}; }`);
        if (rv.tablet) rules.push(`@media (min-width: 768px) and (max-width: 1199px) { ${selector} { ${kebab}: ${rv.tablet}; } }`);
        if (rv.desktop) rules.push(`@media (min-width: 1200px) { ${selector} { ${kebab}: ${rv.desktop}; } }`);
      } else if (typeof value === 'string' && value) {
        rules.push(`${selector} { ${kebab}: ${value}; }`);
      }
    }
  }

  if (rules.length > 0) {
    const style = document.createElement('style');
    style.id = `dr-style-overrides-${sectionId}`;
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }
}

// ─── DOM Update Helpers ─────────────────────────────────────────────

function updateField(container: Element, field: string, value: any): void {
  const el = container.querySelector(`[data-dr-field="${field}"]`) as HTMLElement | null;
  if (!el || value === null || value === undefined) return;

  el.style.removeProperty('display');
  const tagName = el.tagName.toLowerCase();

  if (tagName === 'img') {
    (el as HTMLImageElement).src = String(value);
  } else if (tagName === 'a' && field.includes('href')) {
    (el as HTMLAnchorElement).href = String(value);
  } else {
    el.textContent = String(value);
  }
}

function updateArrayField(container: Element, listName: string, items: any[]): void {
  const listEls = container.querySelectorAll(`[data-dr-list="${listName}"]`);
  if (listEls.length === 0) return;

  listEls.forEach((listEl) => {
    const templateItem = listEl.querySelector('[data-dr-list-item]');
    if (!templateItem) return;

    const templateClone = templateItem.cloneNode(true) as HTMLElement;
    const existingItems = listEl.querySelectorAll('[data-dr-list-item]');
    existingItems.forEach((item) => item.remove());

    for (const itemData of items) {
      const newItem = templateClone.cloneNode(true) as HTMLElement;

      if (typeof itemData !== 'object' || itemData === null) {
        const firstFieldEl = newItem.querySelector('[data-dr-field]') as HTMLElement | null;
        if (firstFieldEl) firstFieldEl.textContent = String(itemData);
        listEl.appendChild(newItem);
        continue;
      }

      for (const [key, value] of Object.entries(itemData)) {
        const fieldEl = newItem.querySelector(`[data-dr-field="${key}"]`) as HTMLElement | null;
        if (!fieldEl) continue;

        const tagName = fieldEl.tagName.toLowerCase();
        if (tagName === 'img') {
          (fieldEl as HTMLImageElement).src = String(value);
        } else if (tagName === 'a') {
          (fieldEl as HTMLAnchorElement).textContent = String(value);
          if ((itemData as any).href) {
            (fieldEl as HTMLAnchorElement).href = String((itemData as any).href);
          }
        } else {
          fieldEl.textContent = String(value);
        }
      }

      listEl.appendChild(newItem);
    }
  });

  // Fire dr:content-updated for component re-initialization
  const sectionEl = container.closest('[data-dr-section]');
  const sectionId = sectionEl?.getAttribute('data-dr-section') || '';
  document.dispatchEvent(new CustomEvent('dr:content-updated', {
    detail: { sectionId, listName }
  }));
}

// ─── Declarative Condition Evaluation ────────────────────────────────

function parseCondition(attr: string): { sectionId: string; field: string; value: string }[] {
  return attr.split('|').map(cond => {
    const trimmed = cond.trim();
    const eqIndex = trimmed.indexOf('=');
    const path = trimmed.substring(0, eqIndex);
    const value = trimmed.substring(eqIndex + 1);
    const dotIndex = path.indexOf('.');
    return { sectionId: path.substring(0, dotIndex), field: path.substring(dotIndex + 1), value };
  });
}

function conditionMatches(conditions: { sectionId: string; field: string; value: string }[], data: Record<string, Record<string, any>>): boolean {
  return conditions.some(c => String(data[c.sectionId]?.[c.field] ?? '') === c.value);
}

function evaluateConditions(data: Record<string, Record<string, any>>): void {
  document.querySelectorAll('[data-dr-show-when]').forEach(el => {
    const conds = parseCondition(el.getAttribute('data-dr-show-when')!);
    (el as HTMLElement).style.display = conditionMatches(conds, data) ? '' : 'none';
  });

  document.querySelectorAll('[data-dr-hide-when]').forEach(el => {
    const conds = parseCondition(el.getAttribute('data-dr-hide-when')!);
    (el as HTMLElement).style.display = conditionMatches(conds, data) ? 'none' : '';
  });

  document.querySelectorAll('[data-dr-effect-when]').forEach(el => {
    const conds = parseCondition(el.getAttribute('data-dr-effect-when')!);
    const effect = el.getAttribute('data-dr-effect') || '';
    const match = conditionMatches(conds, data);
    effect.split(';').filter(Boolean).forEach(rule => {
      const colonIdx = rule.indexOf(':');
      if (colonIdx === -1) return;
      const prop = rule.substring(0, colonIdx).trim();
      const val = rule.substring(colonIdx + 1).trim();
      if (prop) (el as HTMLElement).style[prop as any] = match ? val : '';
    });
  });
}
