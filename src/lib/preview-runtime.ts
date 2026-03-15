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
  | { type: 'full-update'; data: Record<string, Record<string, any>>; sections: Record<string, { enabled: boolean }>; editabilityMap?: Record<string, Record<string, boolean>>; isViewOnly?: boolean }
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
  | { type: 'component-selected'; sectionId: string; fieldPath: string; fieldType: string; index?: number; pageId?: string }
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
let _editabilityMap: Record<string, Record<string, boolean>> = {}; // sectionId → fieldPath → editable
let _isViewOnly: boolean = false; // When true, disable all editor interactions (view mode)
let _lastFullUpdateData: Record<string, Record<string, any>> = {}; // Cache of last full-update data for media switching

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
  console.log('[preview-runtime] Message received:', { type: event.data?.type, origin, data: event.data });
  
  if (
    origin !== window.location.origin
    && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')
    && !origin.startsWith('https://localhost') && !origin.startsWith('https://127.0.0.1')
    && !origin.endsWith('.pages.dev')
    && !origin.startsWith('https://')
  ) {
    console.warn('[preview-runtime] Message rejected - invalid origin:', origin);
    return;
  }

  // Lock in parent origin from first valid message
  if (_parentOrigin === '*') {
    _parentOrigin = origin;
    console.log('[preview-runtime] Parent origin locked to:', origin);
  }

  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'full-update':
      _editabilityMap = msg.editabilityMap ?? {};
      _isViewOnly = msg.isViewOnly ?? false;
      handleFullUpdate(msg.data, msg.sections);
      break;
    case 'field-update':
      console.log('[preview-runtime] field-update received:', { sectionId: msg.sectionId, field: msg.field, value: msg.value });
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
  // Cache the data for media type switching
  _lastFullUpdateData = data;

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

  // CRITICAL: Update cached data FIRST before any rendering logic
  // This ensures the cache is in sync when full-update arrives later
  if (!_lastFullUpdateData[sectionId]) {
    _lastFullUpdateData[sectionId] = {};
  }
  _lastFullUpdateData[sectionId] = { ..._lastFullUpdateData[sectionId], [field]: value };
  console.log(`[preview-runtime] Updated cache for ${sectionId}.${field}:`, value);

  // Special handling: media type changes require container replacement
  if (field === 'heroMediaType' || field === 'mediaType') {
    console.log(`[preview-runtime] Media type changed to ${value}`);
    handleMediaTypeChange(sectionId, field, value as string, sectionEl);
    return;
  }

  // Special handling: unlock-price preview state changes
  if (field === 'previewState' && sectionId === 'unlock-price') {
    console.log(`[preview-runtime] Preview state changed to ${value}`);
    handleUnlockPreviewStateChange(value as string);
    return;
  }

  // Special handling: carousel image array updates need to re-render the carousel
  if (field === 'backgroundImageCarousel' && Array.isArray(value)) {
    console.log(`[preview-runtime] Carousel images updated, re-rendering carousel`);
    // Get current media type and re-render
    const currentMediaType = _lastFullUpdateData[sectionId]?.heroMediaType || 'image';
    if (currentMediaType === 'carousel') {
      handleMediaTypeChange(sectionId, 'heroMediaType', 'carousel', sectionEl);
    }
    return;
  }

  if (Array.isArray(value)) {
    updateArrayField(sectionEl, field, value, sectionId);
  } else {
    updateFieldElement(sectionEl, field, value);
  }
}

// ─── Media Type Switching ────────────────────────────────────────────

function handleMediaTypeChange(sectionId: string, field: string, mediaType: string, sectionEl: Element): void {
  const container = document.querySelector(`[data-dr-media-container="${sectionId}"]`);
  if (!container) {
    console.warn(`[preview-runtime] Media container not found for section: ${sectionId}`);
    return;
  }

  // Get current section data from the last full-update (stored in module state)
  // Don't extract from DOM because DOM may not have the latest data yet
  const sectionData = (_lastFullUpdateData && _lastFullUpdateData[sectionId]) || extractSectionData(sectionEl);
  sectionData[field] = mediaType;

  // Render appropriate media based on type and section
  if (sectionId === 'hero') {
    renderHeroMedia(container, mediaType, sectionData);
  } else if (sectionId === 'media-showcase') {
    renderMediaShowcaseMedia(container, mediaType, sectionData);
  }
}

function extractSectionData(sectionEl: Element): Record<string, any> {
  const data: Record<string, any> = {};
  
  // Extract all data-dr-field values
  sectionEl.querySelectorAll('[data-dr-field]').forEach(el => {
    const field = el.getAttribute('data-dr-field');
    if (!field) return;
    
    // Check if this is an array field (carousel)
    if (el.getAttribute('data-dr-type') === 'array') {
      const images: string[] = [];
      el.querySelectorAll('img[data-dr-type="array-item"]').forEach(img => {
        images.push((img as HTMLImageElement).src);
      });
      data[field] = images;
      return;
    }
    
    if (el.tagName === 'IMG') {
      data[field] = (el as HTMLImageElement).src;
    } else if (el.tagName === 'VIDEO') {
      data[field] = (el as HTMLVideoElement).src;
    } else if (el.tagName === 'INPUT') {
      data[field] = (el as HTMLInputElement).value;
    } else {
      data[field] = el.textContent || '';
    }
  });
  
  // Extract array data from data-dr-list (for other sections)
  sectionEl.querySelectorAll('[data-dr-list]').forEach(listEl => {
    const listName = listEl.getAttribute('data-dr-list');
    if (!listName) return;
    
    const items: string[] = [];
    listEl.querySelectorAll('[data-dr-list-item]').forEach(itemEl => {
      const img = itemEl.querySelector('img');
      if (img) {
        items.push(img.src);
      }
    });
    data[listName] = items;
  });
  
  return data;
}

function renderHeroMedia(container: Element, mediaType: string, data: Record<string, any>): void {
  const imgSrc = (path: string) => path?.startsWith('http') ? path : `/${path}`;
  
  // Clear any existing carousel interval when switching media types
  if ((window as any)._heroCarouselInterval) {
    clearInterval((window as any)._heroCarouselInterval);
    (window as any)._heroCarouselInterval = null;
  }
  
  if (mediaType === 'video' && data.heroVideo) {
    const autoplay = data.videoAutoplay !== false;
    const muted = data.videoMuted !== false;
    
    container.innerHTML = `
      <div class="relative w-full h-full">
        <!-- Video Loading Skeleton -->
        <div 
          id="video-skeleton" 
          class="absolute inset-0 bg-stone-200 animate-pulse flex items-center justify-center"
        >
          <div class="w-16 h-16 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin"></div>
        </div>
        
        <!-- Video Element -->
        <video
          src="${imgSrc(data.heroVideo || 'defaults/demo-video.mp4')}"
          ${autoplay ? 'autoplay' : ''}
          ${muted ? 'muted' : ''}
          loop
          playsinline
          class="w-full h-full object-cover opacity-0 transition-opacity duration-500"
          data-dr-field="heroVideo"
          onloadeddata="this.style.opacity='1'; document.getElementById('video-skeleton').style.display='none';"
          oncanplay="this.style.opacity='1'; document.getElementById('video-skeleton').style.display='none';"
        ></video>
      </div>
      <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
    `;
  } else if (mediaType === 'video') {
    // Video mode but no video - use default
    const autoplay = data.videoAutoplay !== false;
    const muted = data.videoMuted !== false;
    
    container.innerHTML = `
      <div class="relative w-full h-full">
        <!-- Video Loading Skeleton -->
        <div 
          id="video-skeleton" 
          class="absolute inset-0 bg-stone-200 animate-pulse flex items-center justify-center"
        >
          <div class="w-16 h-16 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin"></div>
        </div>
        
        <!-- Video Element -->
        <video
          src="${imgSrc('defaults/demo-video.mp4')}"
          ${autoplay ? 'autoplay' : ''}
          ${muted ? 'muted' : ''}
          loop
          playsinline
          class="w-full h-full object-cover opacity-0 transition-opacity duration-500"
          data-dr-field="heroVideo"
          onloadeddata="this.style.opacity='1'; document.getElementById('video-skeleton').style.display='none';"
          oncanplay="this.style.opacity='1'; document.getElementById('video-skeleton').style.display='none';"
        ></video>
      </div>
      <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
    `;
  } else if (mediaType === 'carousel' && data.backgroundImageCarousel?.length > 0) {
    // Filter out empty/invalid images
    const images = data.backgroundImageCarousel.filter((img: string) => img && img.trim() !== '');
    const alt = data.backgroundImageAlt || '';
    
    // If no valid images after filtering, show placeholder
    if (images.length === 0) {
      container.innerHTML = `
        <div class="w-full h-full flex items-center justify-center bg-muted/20">
          <p class="text-muted-foreground text-sm">Add carousel images to display</p>
        </div>
        <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
      `;
      return;
    }
    
    // If only 1 image, render as static image (no carousel needed)
    if (images.length === 1) {
      container.innerHTML = `
        <img
          src="${imgSrc(images[0])}"
          alt="${alt}"
          width="1920"
          height="1080"
          class="w-full h-full object-cover grayscale opacity-90"
          loading="eager"
          fetchpriority="high"
          data-dr-field="backgroundImageCarousel"
          data-dr-type="array"
        />
        <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
      `;
      return;
    }
    
    const imagesHtml = images.map((img: string, index: number) => `
      <img
        src="${imgSrc(img)}"
        alt="${alt} ${index + 1}"
        width="1920"
        height="1080"
        class="absolute inset-0 w-full h-full object-cover grayscale opacity-90 transition-opacity duration-1000 ${index === 0 ? 'carousel-active' : 'opacity-0'}"
        loading="${index === 0 ? 'eager' : 'lazy'}"
        fetchpriority="${index === 0 ? 'high' : 'auto'}"
        data-dr-index="${index}"
        data-dr-type="array-item"
      />
    `).join('');
    
    container.innerHTML = `
      <div class="hero-carousel w-full h-full relative" data-dr-field="backgroundImageCarousel" data-dr-type="array">
        ${imagesHtml}
      </div>
      <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
    `;
    
    // Initialize carousel
    initHeroCarousel();
  } else if (mediaType === 'carousel') {
    // Carousel mode but no images - show placeholder
    container.innerHTML = `
      <div class="w-full h-full flex items-center justify-center bg-muted/20">
        <p class="text-muted-foreground text-sm">Add carousel images to display</p>
      </div>
      <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
    `;
  } else {
    // Default to image
    const src = data.backgroundImage || 'defaults/default-hero.jpg';
    const alt = data.backgroundImageAlt || '';
    
    container.innerHTML = `
      <img
        src="${imgSrc(src)}"
        alt="${alt}"
        width="1920"
        height="1080"
        class="w-full h-full object-cover grayscale opacity-90"
        loading="eager"
        fetchpriority="high"
        data-dr-field="backgroundImage"
      />
      <div class="absolute inset-0 bg-black/40 pointer-events-none"></div>
    `;
  }
}

function renderMediaShowcaseMedia(container: Element, mediaType: string, data: Record<string, any>): void {
  const imgSrc = (path: string) => path?.startsWith('http') ? path : `/${path}`;
  const mediaFile = data.mediaFile || (mediaType === 'video' ? 'defaults/demo-video.mp4' : 'defaults/default-hero.jpg');
  const mediaAlt = data.mediaAlt || 'Media showcase';
  const is3D = mediaType === '3d-image' || mediaType === '3d-video';
  
  if (mediaType === 'video') {
    const autoplay = data.videoAutoplay === true;
    const muted = data.videoMuted !== false;
    
    container.innerHTML = `
      <div class="relative w-full h-full">
        <!-- Video Loading Skeleton -->
        <div 
          id="media-video-skeleton" 
          class="absolute inset-0 bg-stone-200 animate-pulse flex items-center justify-center"
        >
          <div class="w-12 h-12 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin"></div>
        </div>
        
        <!-- Video Element -->
        <video
          src="${imgSrc(mediaFile)}"
          ${autoplay ? 'autoplay' : ''}
          ${muted ? 'muted' : ''}
          controls
          class="w-full h-full object-cover opacity-0 transition-opacity duration-500"
          data-dr-field="mediaFile"
          onloadeddata="this.style.opacity='1'; document.getElementById('media-video-skeleton').style.display='none';"
          oncanplay="this.style.opacity='1'; document.getElementById('media-video-skeleton').style.display='none';"
        >
          Your browser does not support the video tag.
        </video>
      </div>
    `;
  } else if (is3D) {
    container.innerHTML = `
      <model-viewer
        src="${imgSrc(mediaFile)}"
        alt="${mediaAlt}"
        auto-rotate
        camera-controls
        class="w-full h-full"
        data-dr-field="mediaFile"
      ></model-viewer>
    `;
    
    // Load model-viewer script if not already loaded
    if (!document.querySelector('script[src*="model-viewer"]')) {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/3.3.0/model-viewer.min.js';
      document.head.appendChild(script);
    }
  } else {
    // Default to image
    container.innerHTML = `
      <img
        src="${imgSrc(mediaFile)}"
        alt="${mediaAlt}"
        class="w-full h-full object-cover"
        data-dr-field="mediaFile"
      />
    `;
  }
}

function initHeroCarousel(): void {
  const carousel = document.querySelector('.hero-carousel');
  if (!carousel) return;

  const images = carousel.querySelectorAll('img');
  if (images.length <= 1) return;

  // Clear any existing interval
  if ((window as any)._heroCarouselInterval) {
    clearInterval((window as any)._heroCarouselInterval);
  }

  let currentIndex = 0;
  
  (window as any)._heroCarouselInterval = setInterval(() => {
    images[currentIndex].classList.remove('carousel-active');
    images[currentIndex].classList.add('opacity-0');
    
    currentIndex = (currentIndex + 1) % images.length;
    
    images[currentIndex].classList.add('carousel-active');
    images[currentIndex].classList.remove('opacity-0');
  }, 5000); // Change image every 5 seconds
}

// ─── Unlock Price Preview State Switching ────────────────────────────

function handleUnlockPreviewStateChange(previewState: string): void {
  console.log('[minimal-luxury] handleUnlockPreviewStateChange called:', previewState);
  
  const isUnlocked = previewState === 'unlocked';
  
  // Toggle price blur
  const priceDisplay = document.getElementById('price-display');
  const priceNote = document.getElementById('price-note');
  if (priceDisplay) {
    if (isUnlocked) {
      priceDisplay.style.filter = 'none';
      priceDisplay.style.userSelect = '';
      priceDisplay.style.pointerEvents = '';
    } else {
      priceDisplay.style.filter = 'blur(14px)';
      priceDisplay.style.userSelect = 'none';
      priceDisplay.style.pointerEvents = 'none';
    }
  }
  if (priceNote) {
    priceNote.style.filter = isUnlocked ? 'none' : 'blur(8px)';
  }
  
  // Toggle unlock button
  const unlockBtnWrapper = document.getElementById('unlock-btn-wrapper');
  if (unlockBtnWrapper) {
    unlockBtnWrapper.style.display = isUnlocked ? 'none' : '';
  }
  
  // Toggle success message
  const successMsg = document.getElementById('price-success-msg');
  if (successMsg) {
    successMsg.style.display = isUnlocked ? '' : 'none';
  }
  
  // Toggle modal
  const modal = document.getElementById('contact-modal');
  if (modal) {
    modal.style.display = isUnlocked ? 'flex' : 'none';
  }
}

// ─── Section Toggle ──────────────────────────────────────────────────

function handleSectionToggle(sectionId: string, enabled: boolean): void {
  const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`) as HTMLElement | null;
  if (!sectionEl) return;

  sectionEl.style.display = enabled ? '' : 'none';
}

// ─── Style Update ────────────────────────────────────────────────────

function handleStyleUpdate(sectionId: string, field: string, styles: Record<string, any>): void {
  const sectionEl = document.querySelector(`[data-dr-section="${sectionId}"]`);
  if (!sectionEl) return;

  // For __section styles, apply to the section container itself
  const el = field === '__section'
    ? sectionEl as HTMLElement
    : sectionEl.querySelector(`[data-dr-style="${field}"]`) as HTMLElement | null;
  if (!el) return;

  for (const [prop, value] of Object.entries(styles)) {
    if (!_allowedStyleProps.includes(prop)) continue;

    // Check if value is responsive (object with breakpoints)
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && value.mobile) {
      applyResponsiveStyle(el, sectionId, field, prop, value);
    } else {
      // Simple value - apply directly
      (el.style as any)[prop] = value;
    }
  }
}

// ─── Apply Responsive Style ──────────────────────────────────────────

function applyResponsiveStyle(
  element: HTMLElement,
  sectionId: string,
  field: string,
  property: string,
  value: { mobile: string; tablet: string; desktop: string }
): void {
  // Apply mobile (base) style directly
  (element.style as any)[property] = value.mobile;

  // Create or update style tag with media queries
  const styleId = `responsive-${sectionId}-${field}-${property}`;
  let styleTag = document.getElementById(styleId) as HTMLStyleElement;
  
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = styleId;
    document.head.appendChild(styleTag);
  }

  // Generate CSS with media queries
  const selector = field === '__section'
    ? `[data-dr-section="${sectionId}"]`
    : `[data-dr-section="${sectionId}"] [data-dr-style="${field}"]`;
  
  styleTag.textContent = `
    ${selector} {
      ${property}: ${value.mobile} !important;
    }
    @media (min-width: 768px) {
      ${selector} {
        ${property}: ${value.tablet} !important;
      }
    }
    @media (min-width: 1440px) {
      ${selector} {
        ${property}: ${value.desktop} !important;
      }
    }
  `;
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
  // Skip all inline editing in view-only mode
  if (_isViewOnly) return;

  // Make all text fields with data-dr-field editable (except images)
  const fields = document.querySelectorAll('[data-dr-field]');

  fields.forEach((el) => {
    const htmlEl = el as HTMLElement;
    const tagName = htmlEl.tagName.toLowerCase();

    // Skip images — they use the image replace flow
    if (tagName === 'img') return;

    // Skip elements inside data-dr-list-item (array items are managed by the panel)
    if (htmlEl.closest('[data-dr-list-item]')) return;

    // Check editability from map
    const sectionId = getSectionId(htmlEl);
    const field = htmlEl.getAttribute('data-dr-field');
    if (sectionId && field && _editabilityMap[sectionId]?.[field] === false) {
      // Field is locked — skip making it editable
      return;
    }

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
  // Skip all image click handlers in view-only mode
  if (_isViewOnly) return;

  const images = document.querySelectorAll('img[data-dr-field]');

  images.forEach((img) => {
    const htmlImg = img as HTMLImageElement;

    // Check editability from map
    const sectionId = getSectionId(htmlImg);
    const field = htmlImg.getAttribute('data-dr-field');
    if (sectionId && field && _editabilityMap[sectionId]?.[field] === false) {
      // Image is locked — skip click handler
      return;
    }

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
