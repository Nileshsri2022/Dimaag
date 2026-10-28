import manifest from "../manifest";

it("has the exact v1 permission posture", () => {
  expect(manifest.name).toBe("Dimaag");
  expect(manifest.permissions).toEqual([
    "sidePanel",
    "storage",
    "unlimitedStorage",
    "activeTab",
    "scripting",
  ]);
  expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.options_ui).toEqual({
    page: "src/options/index.html",
    open_in_tab: true,
  });
});
