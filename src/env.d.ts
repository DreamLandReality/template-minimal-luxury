/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Window {
  __DLR?: {
    gates?: Array<Record<string, unknown>>;
    stateTypes?: Record<string, unknown>;
    sectionData?: Record<string, unknown>;
  };
  dlrGate?: {
    open: (actionId?: string, gateId?: string) => void;
    close: (gateId?: string) => void;
    unlock: (gateId?: string) => void;
    isUnlocked: (gateId?: string) => boolean;
    performAction: (actionId: string, gateId?: string) => void;
  };
}
