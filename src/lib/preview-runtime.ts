/**
 * Dream Reality — Preview Runtime
 *
 * Activates ONLY when ?preview=true is in the URL.
 * Listens for postMessage from the admin portal parent window
 * and updates DOM elements via data-dr-* attributes in real-time.
 *
 * Zero overhead in production — the entire module no-ops if not in preview mode.
 *
 * Copy this file into any new template at: src/lib/preview-runtime.ts
 * Import it in BaseLayout.astro: import './lib/preview-runtime';
 */

// ─── Types ───────────────────────────────────────────────────────────

/** Messages sent FROM the admin portal TO the iframe */
type ParentToIframeMessage =
  | { type: 'full-update'; data: Record<string, Record<string, any>>; sections: Record<string, { enabled: boolean }> }
  | { type: 'field-update'; sectionId: string; field: string; value: any }
  | { type: 'section-toggle'; sectionId: string; enabled: boolean }
  | { type: 'style-update'; sectionId: string; field: string; styles: Record<string, string> }
  | { type: 'section-highlight'; sectionId: string | null }
  | { type: 'scroll-to-section'; sectionId: string };

/** Messages sent FROM the iframe TO the admin portal */
type IframeToParentMessage =
  | { type: 'field-edited'; sectionId: string; field: string; value: string }
  | { type: 'image-replace-requested'; sectionId: string; field: string }
  | { type: 'ai-suggest-requested'; sectionId: string; field: string; content: string }
  | { type: 'element-selected'; sectionId: string; field: string; elementType: 'text' | 'image'; content: string }
  | { type: 'deselect' }
  | { type: 'ready' };

// ─── Module-level state (must be declared before initPreviewRuntime) ──

const _allowedStyleProps = [
  // Text
  'textAlign', 'fontWeight', 'fontSize', 'letterSpacing',
  'lineHeight', 'color', 'textTransform', 'opacity',
  // Spacing
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'marginTop', 'marginBottom',
  // Layout (flex/grid) — only apply to containers, not text elements
  'gap', 'justifyContent', 'alignItems', 'flexDirection',
  // Background
  'backgroundColor', 'borderRadius',
];

let _parentOrigin: string = '*'; // Set to actual parent origin on first valid message
let _highlightedEl: HTMLElement | null = null;

// ─── Guard: only run in preview mode ─────────────────────────────────

const isPreview = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('preview') === 'true';

if (isPreview) {
  initPreviewRuntime();
}

// ─── Main ────────────────────────────────────────────────────────────

function initPreviewRuntime(): void {
  console.log('[preview-runtime] Activated');

  // Keep preview mode active across internal navigation
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (
      a &&
      a.href &&
      a.host === window.location.host &&
      !a.getAttribute('href')?.startsWith('javascript:') &&
      !a.href.includes('preview=true')
    ) {
      // Don't intercept hash-only internal links
      const hrefAttr = a.getAttribute('href');
      if (hrefAttr && hrefAttr.startsWith('#')) return;

      e.preventDefault();
      const url = new URL(a.href);
      url.searchParams.set('preview', 'true');
      window.location.href = url.toString();
    }
  });

  // Listen for messages from parent admin portal
  window.addEventListener('message', handleMessage);

  // Set up inline editing on text fields
  setupInlineEditing();

  // Set up image click handlers
  setupImageClickHandlers();

  // Notify parent that the iframe is ready
  sendToParent({ type: 'ready' });

  // Deselect when clicking outside editable elements
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-dr-field]')) {
      sendToParent({ type: 'deselect' });
    }
  });
}

// ─── Message Handler ─────────────────────────────────────────────────

function handleMessage(event: MessageEvent): void {
  // Accept messages from same origin, localhost, known deployment domains, or any HTTPS admin panel
  const origin = event.origin;
  if (
    origin !== window.location.origin
    && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')
    && !origin.startsWith('https://localhost') && !origin.startsWith('https://127.0.0.1')
    && !origin.endsWith('.pages.dev')
    && !origin.startsWith('https://')
  ) {
    return;
  }

  // Lock in parent origin from first valid message
  if (_parentOrigin === '*') {
    _parentOrigin = origin;
  }

  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'full-update':
      handleFullUpdate(msg.data, msg.sections);
      break;
    case 'field-update':
      handleFieldUpdate(msg.sectionId, msg.field, msg.value);
      break;
    case 'section-toggle':
      handleSectionToggle(msg.sectionId, msg.enabled);
      break;
    case 'style-update':
      handleStyleUpdate(msg.sectionId, msg.field, msg.styles);
      break;
    case 'section-highlight':
      handleSectionHighlight(msg.sectionId);
      break;
    case 'scroll-to-section': {
      const target = document.querySelector(`[data-dr-section="${msg.sectionId}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
  }
}

// ─── Full Update ─────────────────────────────────────────────────────

function handleFullUpdate(
  data: Record<string, Record<string, any>>,
  sections: Record<string, { enabled: boolean }>
): void {
  // Toggle section visibility
  for (const [sectionId, config] of Object.entries(sections)) {
    handleSectionToggle(sectionId, config.enabled);
  }

  // Update all fields per section
  for (const [sectionId, sectionData] of Object.entries(data)) {
    // Special case: theme section → apply CSS variables to :root
    if (sectionId === 'theme') {
      applyThemeCssVars(sectionData as any);
      continue;
    }

    const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`);
    if (!sectionEl) continue;

    for (const [field, value] of Object.entries(sectionData)) {
      // Apply __style keys via handleStyleUpdate
      if (field.endsWith('__style') && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const baseField = field.slice(0, -7); // strip "__style"
        handleStyleUpdate(sectionId, baseField, value as Record<string, string>);
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
        // Nested object — update dot-notation fields
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          updateFieldElement(sectionEl, `${field}.${nestedKey}`, nestedValue);
        }
      } else if (Array.isArray(value)) {
        // Pass sectionId as fallback list name for object-with-items sections
        // (e.g. field="items" but HTML has data-dr-list="properties")
        updateArrayField(sectionEl, field, value, sectionId);
        // Also update dot-notation field references for individual array items
        // (e.g. data-dr-field="gallery.0.src" used for hero images on detail pages)
        value.forEach((item: any, index: number) => {
          if (item && typeof item === 'object') {
            for (const [itemKey, itemVal] of Object.entries(item)) {
              updateFieldElement(sectionEl, `${field}.${index}.${itemKey}`, itemVal as any);
            }
          } else {
            updateFieldElement(sectionEl, `${field}.${index}`, item);
          }
        });
      } else {
        updateFieldElement(sectionEl, field, value);
      }
    }
  }

  // Re-bind inline editing for any new/replaced DOM nodes
  setupInlineEditing();

  console.log('[preview-runtime] Full update applied');
}

// ─── Theme CSS Variables ─────────────────────────────────────────────

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

// ─── Field Update ────────────────────────────────────────────────────

function handleFieldUpdate(sectionId: string, field: string, value: any): void {
  const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`);
  if (!sectionEl) {
    console.warn(`[preview-runtime] Section not found: ${sectionId}`);
    return;
  }

  if (Array.isArray(value)) {
    updateArrayField(sectionEl, field, value, sectionId);
  } else {
    updateFieldElement(sectionEl, field, value);
  }
}

// ─── Section Toggle ──────────────────────────────────────────────────

function handleSectionToggle(sectionId: string, enabled: boolean): void {
  const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`) as HTMLElement | null;
  if (!sectionEl) return;

  sectionEl.style.display = enabled ? '' : 'none';
}

// ─── Style Update ────────────────────────────────────────────────────

function handleStyleUpdate(sectionId: string, field: string, styles: Record<string, string>): void {
  const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`);
  if (!sectionEl) return;

  // For __section styles, apply to the section container itself
  const el = field === '__section'
    ? sectionEl as HTMLElement
    : sectionEl.querySelector(`[data-dr-style="${field}"]`) as HTMLElement | null;
  if (!el) return;

  for (const [prop, value] of Object.entries(styles)) {
    if (_allowedStyleProps.includes(prop)) {
      (el.style as any)[prop] = value;
    }
  }
}

// ─── Section Highlight ───────────────────────────────────────────────

function handleSectionHighlight(sectionId: string | null): void {
  if (_highlightedEl) {
    _highlightedEl.style.outline = '';
    _highlightedEl.style.outlineOffset = '';
    _highlightedEl = null;
  }
  if (!sectionId) return;

  const el = document.querySelector(`[data-dr-section="${sectionId}"]`) as HTMLElement | null;
  if (!el) return;

  el.style.outline = '2px solid rgba(59, 130, 246, 0.5)';
  el.style.outlineOffset = '-2px';
  _highlightedEl = el;
}

// ─── Element Update Helpers ──────────────────────────────────────────

function updateFieldElement(container: Element, field: string, value: any): void {
  const el = container.querySelector(`[data-dr-field="${field}"]`) as HTMLElement | null;
  if (!el) return;

  if (value === null || value === undefined) return;

  const tagName = el.tagName.toLowerCase();

  // Unhide elements that were hidden due to empty initial content
  el.style.removeProperty('display');

  if (tagName === 'img') {
    (el as HTMLImageElement).src = String(value);
  } else if (tagName === 'a' && field.includes('href')) {
    (el as HTMLAnchorElement).href = String(value);
  } else {
    el.textContent = String(value);
  }
}

function updateArrayField(container: Element, listName: string, items: any[], fallbackListName?: string): void {
  // Use querySelectorAll to update all matching lists (e.g. desktop + mobile nav)
  let listEls = container.querySelectorAll(`[data-dr-list="${listName}"]`);
  // Fallback for object-with-items sections where the field key (e.g. "items")
  // differs from the data-dr-list attribute (e.g. "properties")
  if (listEls.length === 0 && fallbackListName) {
    listEls = container.querySelectorAll(`[data-dr-list="${fallbackListName}"]`);
  }
  if (listEls.length === 0) return;

  listEls.forEach((listEl) => {
    // Get the first list item as a template
    const templateItem = listEl.querySelector('[data-dr-list-item]');
    if (!templateItem) return;

    // Clone the template before clearing
    const templateClone = templateItem.cloneNode(true) as HTMLElement;

    // Remove all existing items
    const existingItems = listEl.querySelectorAll('[data-dr-list-item]');
    existingItems.forEach((item) => item.remove());

    // Create new items from data
    for (const itemData of items) {
      const newItem = templateClone.cloneNode(true) as HTMLElement;

      // Primitive item (e.g. string array like amenities) — set the first data-dr-field element
      if (typeof itemData !== 'object' || itemData === null) {
        const firstFieldEl = newItem.querySelector('[data-dr-field]') as HTMLElement | null;
        if (firstFieldEl) {
          firstFieldEl.textContent = String(itemData);
        }
        listEl.appendChild(newItem);
        continue;
      }

      // Fill in field values (relative field names inside list items)
      for (const [key, value] of Object.entries(itemData)) {
        // Handle nested objects with dot-notation fields (e.g. specs.bedrooms)
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [subKey, subValue] of Object.entries(value)) {
            const subEl = newItem.querySelector(`[data-dr-field="${key}.${subKey}"]`) as HTMLElement | null;
            if (subEl) {
              subEl.textContent = String(subValue);
            }
          }
          continue;
        }

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
}

// ─── Inline Editing ──────────────────────────────────────────────────

function setupInlineEditing(): void {
  // Make all text fields with data-dr-field editable (except images)
  const fields = document.querySelectorAll('[data-dr-field]');

  fields.forEach((el) => {
    const htmlEl = el as HTMLElement;
    const tagName = htmlEl.tagName.toLowerCase();

    // Skip images — they use the image replace flow
    if (tagName === 'img') return;

    // Skip elements inside data-dr-list-item (array items are managed by the panel)
    if (htmlEl.closest('[data-dr-list-item]')) return;

    // Make contenteditable
    htmlEl.setAttribute('contenteditable', 'true');
    htmlEl.style.outline = 'none';
    htmlEl.style.cursor = 'text';

    // Highlight on focus
    htmlEl.addEventListener('focus', () => {
      htmlEl.style.outline = '2px solid rgba(139, 92, 246, 0.5)';
      htmlEl.style.outlineOffset = '2px';
      htmlEl.style.borderRadius = '2px';

      const sectionId = getSectionId(htmlEl);
      const field = htmlEl.getAttribute('data-dr-field');
      if (sectionId && field) {
        sendToParent({
          type: 'element-selected',
          sectionId,
          field,
          elementType: 'text',
          content: htmlEl.textContent || '',
        });
      }
    });

    // Remove highlight on blur + send update
    htmlEl.addEventListener('blur', () => {
      htmlEl.style.outline = 'none';
      htmlEl.style.outlineOffset = '';
      htmlEl.style.borderRadius = '';

      const sectionId = getSectionId(htmlEl);
      const field = htmlEl.getAttribute('data-dr-field');
      if (sectionId && field) {
        sendToParent({
          type: 'field-edited',
          sectionId,
          field,
          value: htmlEl.textContent || '',
        });
      }
    });

    // Send updates on input for real-time sync
    htmlEl.addEventListener('input', () => {
      const sectionId = getSectionId(htmlEl);
      const field = htmlEl.getAttribute('data-dr-field');
      if (sectionId && field) {
        sendToParent({
          type: 'field-edited',
          sectionId,
          field,
          value: htmlEl.textContent || '',
        });
      }
    });

    // Allow Enter to create new lines in all text fields
    // Users can press Enter to add line breaks in any editable text
  });
}

// ─── Image Click Handlers ────────────────────────────────────────────

function setupImageClickHandlers(): void {
  const images = document.querySelectorAll('img[data-dr-field]');

  images.forEach((img) => {
    const htmlImg = img as HTMLImageElement;

    // Style for hover feedback
    htmlImg.style.cursor = 'pointer';
    htmlImg.style.transition = 'outline 0.15s ease';

    htmlImg.addEventListener('mouseenter', () => {
      htmlImg.style.outline = '2px solid rgba(139, 92, 246, 0.5)';
      htmlImg.style.outlineOffset = '2px';
    });

    htmlImg.addEventListener('mouseleave', () => {
      htmlImg.style.outline = 'none';
      htmlImg.style.outlineOffset = '';
    });

    htmlImg.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const sectionId = getSectionId(htmlImg);
      const field = htmlImg.getAttribute('data-dr-field');

      if (sectionId && field) {
        sendToParent({
          type: 'element-selected',
          sectionId,
          field,
          elementType: 'image',
          content: htmlImg.src,
        });

        sendToParent({
          type: 'image-replace-requested',
          sectionId,
          field,
        });
      }
    });
  });
}

// ─── Utilities ───────────────────────────────────────────────────────

function getSectionId(el: HTMLElement): string | null {
  const section = el.closest('[data-dr-section]');
  return section?.getAttribute('data-dr-section') || null;
}

function sendToParent(message: IframeToParentMessage): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, _parentOrigin);
  }
}
