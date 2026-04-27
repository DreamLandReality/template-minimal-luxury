/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Window {
  __DLR?: {
    stateTypes?: Record<string, unknown>;
    sectionData?: Record<string, unknown>;
    sectionId?: string;
    token?: string | null;
    endpoint?: string | null;
    anonKey?: string | null;
  };
  dlrGate?: {
    open: () => void;
    unlock: () => void;
    isUnlocked: () => boolean;
  };
}
