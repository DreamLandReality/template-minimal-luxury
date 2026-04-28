/**
 * Manifest Loader for minimal-luxury template
 * 
 * Wraps the shared @dreamlr/manifest-loader package with template-specific configuration.
 */

// @ts-ignore - JSON import handled by Astro/Vite
import manifest from '../../template.manifest.json';
// Inlined from @dreamlr/manifest-loader
export interface ManifestSection {
    id: string;
    name?: string;
    enabled?: boolean;
    showInNav?: boolean;
    dataType?: 'object' | 'array';
    data?: any;
    schema?: any;
    [key: string]: any;
}

export interface CollectionItem {
    id: string;
    [key: string]: any;
}

export interface ManifestCollection {
    id: string;
    name: string;
    slug: string;
    schema?: any;
    data: CollectionItem[];
}

export interface ThemeConfig {
    colors: {
        primary: string;
        primaryForeground: string;
        background: string;
        surface: string;
        muted: string;
        border: string;
        accent?: string;
    };
    typography: {
        fontSans: string;
        fontSerif: string;
    };
    radius: {
        base: string;
    };
}

export interface GateConfig {
    id: string;
    statePath: string;
    storageKey: string;
    defaultState: string;
    formState?: string;
    successState: string;
    failureState?: string;
    expiredState?: string;
    persistStates?: string[];
    persist: boolean;
    formSectionId?: string;
    siteToken: string | null;
    submissionEndpoint: string | null;
    supabaseAnonKey: string | null;
    actions: Array<{
        id: string;
        mode: 'reveal' | 'download' | 'custom';
    }>;
}

export interface NavItem {
    sectionId: string;
    label: string;
    href: string;
    visible: boolean;
}

export interface ManifestLoaderConfig {
    manifest: any;
    defaultTheme?: ThemeConfig;
}

const DEFAULT_LIGHT_THEME: ThemeConfig = {
    colors: {
        primary: '#1c1917',
        primaryForeground: '#ffffff',
        background: '#fafaf9',
        surface: '#ffffff',
        muted: '#a8a29e',
        border: '#e7e5e4'
    },
    typography: {
        fontSans: "'Inter', sans-serif",
        fontSerif: "'Cinzel', serif"
    },
    radius: {
        base: '0px'
    }
};

/**
 * Create a manifest loader instance with template-specific configuration.
 */
export function createManifestLoader(config: ManifestLoaderConfig) {
    const { manifest, defaultTheme = DEFAULT_LIGHT_THEME } = config;

    // Build a lookup map of sections by id
    const sectionsMap = new Map<string, ManifestSection>(
        (manifest as any).sections.map((s: ManifestSection) => [s.id, s])
    );

    // Build a lookup map of collections by id + a flat item index by item id
    const collections: ManifestCollection[] = (manifest as any).collections ?? [];
    const collectionsMap = new Map<string, ManifestCollection>(
        collections.map((c) => [c.id, c])
    );
    const collectionItemIndex = new Map<string, CollectionItem>();
    for (const col of collections) {
        for (const item of col.data) {
            collectionItemIndex.set(item.id, item);
        }
    }

    /**
     * Get section data by ID.
     * Returns the defaultData for the section, or an empty object/array.
     */
    function getSectionData<T = Record<string, any>>(sectionId: string): T {
        const section = sectionsMap.get(sectionId);
        if (!section) {
            console.warn(`[manifest-loader] Section "${sectionId}" not found`);
            return {} as T;
        }
        const data = section.data ?? {};
        if (typeof data !== 'object' || !section.schema?.properties) return data as T;

        // Resolve collection references: replace string ID arrays with full objects
        const resolved = { ...data };
        for (const [key, fieldSchema] of Object.entries(section.schema.properties) as [string, any][]) {
            if (fieldSchema.uiWidget === 'collectionPicker' && Array.isArray(resolved[key])) {
                const refs = resolved[key];
                if (refs.length > 0 && typeof refs[0] === 'string') {
                    resolved[key] = refs
                        .map((id: string) => collectionItemIndex.get(id))
                        .filter((item: any): item is CollectionItem => !!item);
                }
            }
        }
        return resolved as T;
    }

    /**
     * Get collection data by collection ID.
     * Returns the full array of collection items.
     */
    function getCollectionData<T = CollectionItem[]>(collectionId: string): T {
        const col = collectionsMap.get(collectionId);
        if (!col) {
            console.warn(`[manifest-loader] Collection "${collectionId}" not found`);
            return [] as T;
        }
        return col.data as T;
    }

    /**
     * Check if a section is enabled.
     * Defaults to true if the enabled flag is not set.
     */
    function isSectionEnabled(sectionId: string): boolean {
        const section = sectionsMap.get(sectionId);
        return section?.enabled !== false;
    }

    function isNavEligibleSection(sectionId: string, pageSectionIds: string[]): boolean {
        const firstPageSectionId = pageSectionIds[0];
        return sectionId !== firstPageSectionId && pageSectionIds.includes(sectionId);
    }

    function getNavItems(pageId?: string): NavItem[] {
        const pages = (manifest as any).pages;
        const page = Array.isArray(pages)
            ? (pageId ? pages.find((item: any) => item.id === pageId) : null) ?? pages.find((item: any) => item.path === '/') ?? pages[0]
            : null;
        const pageSectionIds = Array.isArray(page?.sections) ? page.sections : [];

        return pageSectionIds
            .map((sectionId: string) => sectionsMap.get(sectionId))
            .filter((section: ManifestSection | undefined): section is ManifestSection => Boolean(section?.id && isNavEligibleSection(section.id, pageSectionIds)))
            .map((section: ManifestSection) => ({
                sectionId: section.id,
                label: section.name ?? section.id,
                href: `#${section.id}`,
                visible: section.enabled !== false && section.showInNav === true
            }));
    }

    /**
     * Get the theme configuration with actual values.
     * Checks the theme section in sections[] first (admin-editable),
     * then falls back to manifest.theme for backwards compatibility,
     * then uses the template-specific defaultTheme from config.
     */
    function getTheme(): ThemeConfig {
        // Prefer the theme section (admin panel edits flow through here)
        const themeSection = sectionsMap.get('theme');
        if (themeSection?.data) {
            return themeSection.data as ThemeConfig;
        }

        // Legacy: read from manifest.theme top-level key
        const theme = (manifest as any).theme;
        if (!theme) {
            return defaultTheme;
        }

        if (theme.data) {
            return theme.data as ThemeConfig;
        }

        // Extract defaults from schema-style definitions
        const extractDefaults = (obj: Record<string, any>): Record<string, any> => {
            const result: Record<string, any> = {};
            for (const [key, value] of Object.entries(obj)) {
                if (value && typeof value === 'object' && 'default' in value) {
                    result[key] = value.default;
                } else if (value && typeof value === 'object' && !('type' in value)) {
                    result[key] = extractDefaults(value);
                }
            }
            return result;
        };

        const extracted = extractDefaults(theme);
        return Object.keys(extracted).length > 0 ? extracted as ThemeConfig : defaultTheme;
    }

    /**
     * Generate a CSS string from the styleOverrides block in the manifest.
     *
     * styleOverrides is structured as:
     *   { sectionId: { fieldName: { cssProp: value } } }
     * where value is either a flat string ("0.5em") or a responsive object
     * { mobile: "3rem", tablet: "4rem", desktop: "7rem" }.
     *
     * Returns a single CSS string ready to inject into a <style> tag.
     * Responsive values produce media-query rules:
     *   Mobile:  base rule (no query)
     *   Tablet:  @media (min-width: 768px) and (max-width: 1199px)
     *   Desktop: @media (min-width: 1200px)
     */
    function getStyleOverridesCSS(): string {
        const overrides = (manifest as any).styleOverrides as
            Record<string, Record<string, Record<string, unknown>>> | undefined;
        if (!overrides) return '';

        const rules: string[] = [];

        for (const [sectionId, fields] of Object.entries(overrides)) {
            for (const [field, props] of Object.entries(fields)) {
                const selector = field === '__section'
                    ? `[data-dr-section="${sectionId}"]`
                    : `[data-dr-section="${sectionId}"] [data-dr-style="${field}"]`;

                for (const [cssProp, value] of Object.entries(props)) {
                    const kebab = cssProp.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                    const isResponsive = typeof value === 'object' && value !== null
                        && ('mobile' in value || 'tablet' in value || 'desktop' in value);

                    if (isResponsive) {
                        const rv = value as { mobile?: string; tablet?: string; desktop?: string };
                        if (rv.mobile) {
                            rules.push(`${selector} { ${kebab}: ${rv.mobile}; }`);
                        }
                        if (rv.tablet) {
                            rules.push(`@media (min-width: 768px) and (max-width: 1199px) { ${selector} { ${kebab}: ${rv.tablet}; } }`);
                        }
                        if (rv.desktop) {
                            rules.push(`@media (min-width: 1200px) { ${selector} { ${kebab}: ${rv.desktop}; } }`);
                        }
                    } else if (typeof value === 'string' && value) {
                        rules.push(`${selector} { ${kebab}: ${value}; }`);
                    }
                }
            }
        }

        return rules.join('\n');
    }

    /**
     * Get all sections (for iteration/enumeration).
     */
    function getAllSections(): ManifestSection[] {
        return (manifest as any).sections;
    }

    /**
     * Get the raw manifest object.
     */
    function getManifest() {
        return manifest;
    }

    /**
     * Get reusable gate configurations for shared gate runtime.
     * gates[] is the canonical contract for all gated template actions.
     */
    function getGateConfigs(): GateConfig[] {
        const gates = (manifest as any).gates;
        if (!Array.isArray(gates)) return [];
        return gates.map((gate: any) => ({
            id: gate.id ?? 'lead-capture',
            statePath: gate.statePath,
            storageKey: gate.storageKey ?? `dlr_gate_${(manifest as any).templateId ?? 'template'}_${gate.id ?? 'lead-capture'}_${String(gate.statePath ?? gate.id ?? 'gate').replace(/\./g, '_')}`,
            defaultState: gate.defaultState,
            formState: gate.formState,
            successState: gate.successState,
            failureState: gate.failureState,
            expiredState: gate.expiredState,
            persistStates: gate.persistStates,
            persist: gate.persist !== false,
            formSectionId: gate.formSectionId,
            siteToken: gate.siteToken ?? null,
            submissionEndpoint: gate.submissionEndpoint ?? null,
            supabaseAnonKey: gate.supabaseAnonKey ?? null,
            actions: gate.actions ?? []
        }));
    }

    /**
     * Get state type definitions for universal state management (T-TL-34).
     * Returns empty object if stateTypes block doesn't exist in manifest.
     * State types declare the structure and validation rules for dynamic state.
     */
    function getStateTypes(): Record<string, any> {
        const stateTypes = (manifest as any).stateTypes;
        if (!stateTypes || typeof stateTypes !== 'object') {
            return {};
        }
        return stateTypes;
    }

    function getAllSectionData(): Record<string, Record<string, any>> {
        const result: Record<string, Record<string, any>> = {};
        const sections = (manifest as any).sections as ManifestSection[];
        if (!Array.isArray(sections)) return result;
        for (const section of sections) {
            if (section.data && typeof section.data === 'object') {
                result[section.id] = section.data as Record<string, any>;
            }
        }
        return result;
    }

    return {
        getSectionData,
        getCollectionData,
        isSectionEnabled,
        getNavItems,
        getTheme,
        getStyleOverridesCSS,
        getAllSections,
        getManifest,
        getGateConfigs,
        getStateTypes,
        getAllSectionData
    };
}


// Light theme fallback for minimal-luxury
const { 
    getSectionData, 
    getCollectionData, 
    isSectionEnabled, 
    getNavItems,
    getTheme, 
    getStyleOverridesCSS, 
    getAllSections, 
    getManifest,
    getGateConfigs,
    getStateTypes,
    getAllSectionData
} = createManifestLoader({
    manifest,
    defaultTheme: {
        colors: {
            primary: '#1c1917',
            primaryForeground: '#ffffff',
            background: '#fafaf9',
            surface: '#ffffff',
            muted: '#a8a29e',
            border: '#e7e5e4'
        },
        typography: {
            fontSans: "'Inter', sans-serif",
            fontSerif: "'Cinzel', serif"
        },
        radius: {
            base: '0px'
        }
    }
});

export {
    getSectionData,
    getCollectionData,
    isSectionEnabled,
    getNavItems,
    getTheme,
    getStyleOverridesCSS,
    getAllSections,
    getManifest,
    getGateConfigs,
    getStateTypes,
    getAllSectionData
};
