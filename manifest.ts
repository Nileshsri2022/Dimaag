import type { ManifestV3Export } from "@crxjs/vite-plugin";

/**
 * The plain manifest object member of @crxjs/vite-plugin's ManifestV3Export
 * union (its exported interface is not guaranteed stable to name directly).
 */
type Manifest = Extract<ManifestV3Export, { manifest_version: number }>;

const manifest: Manifest = {
  manifest_version: 3,
  name: "Dimaag",
  version: "1.0.0",
  permissions: ["sidePanel", "storage", "unlimitedStorage", "activeTab", "scripting", "tabs"],
  host_permissions: ["https://*/*", "http://*/*"],
  background: {
    service_worker: "src/background/serviceWorker.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  action: {
    default_title: "Dimaag",
  },
};

export default manifest;
