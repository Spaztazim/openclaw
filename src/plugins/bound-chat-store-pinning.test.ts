import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareBoundChatStartup } from "../config/bound-chat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
let root: string;
const grant = {
  allow: true as const,
  path: "/bound",
  profile: "bound-chat-v1" as const,
  agentId: "fixed",
};
const config = (store: string): OpenClawConfig => ({
  session: { store },
  agents: { list: [{ id: "fixed" }, { id: "other" }] },
  plugins: { entries: { example: { grants: { boundChat: [grant] } } } },
});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bound-pin-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
it.each(["parent", "file"])("pins physical %s symlink target and identity", (kind) => {
  const a = path.join(root, "a"),
    b = path.join(root, "b"),
    link = path.join(root, "link");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "sessions.json"), "A");
  fs.writeFileSync(path.join(b, "sessions.json"), "B");
  const target = (dir: string) => (kind === "parent" ? dir : path.join(dir, "sessions.json"));
  fs.symlinkSync(target(a), link, kind === "parent" ? "junction" : "file");
  const store = kind === "parent" ? path.join(link, "sessions.json") : link;
  const startup = prepareBoundChatStartup(config(store));
  expect(startup.invalid).toBe(false);
  expect(startup.grants[0]?.identity).toBe(
    prepareBoundChatStartup(config(path.join(a, "sessions.json"))).grants[0]?.identity,
  );
  fs.unlinkSync(link);
  fs.symlinkSync(target(b), link, kind === "parent" ? "junction" : "file");
  expect(fs.readFileSync(startup.grants[0]!.config.session!.store!, "utf8")).toBe("A");
  expect(prepareBoundChatStartup(config(store)).grants[0]?.identity).not.toBe(
    startup.grants[0]?.identity,
  );
});
it("pins existing parent when the store file is absent", () => {
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link, "junction");
  const startup = prepareBoundChatStartup(config(path.join(link, "sessions.json")));
  expect(startup.grants[0]?.config.session?.store).toBe(path.join(real, "sessions.json"));
});
it.each(["missing-parent", "dangling-file", "directory-file", "io-error"])(
  "fails closed without paths: %s",
  (kind) => {
    const file = path.join(root, "sessions.json");
    let store = file;
    if (kind === "missing-parent") {
      store = path.join(root, "missing", "sessions.json");
    }
    if (kind === "dangling-file") {
      fs.symlinkSync(path.join(root, "absent"), file, "file");
    }
    if (kind === "directory-file") {
      fs.mkdirSync(file);
    }
    if (kind === "io-error") {
      vi.spyOn(fs, "realpathSync").mockImplementation(() => {
        throw new Error(`EACCES ${root}`);
      });
    }
    const startup = prepareBoundChatStartup(config(store));
    expect(startup).toEqual({ invalid: true, grants: [] });
    expect(JSON.stringify(startup)).not.toContain(root);
  },
);
it.each([false, true])(
  "rejects duplicate/conflicting same-slot grants: conflict=%s",
  (conflict) => {
    const cfg = config(path.join(root, "sessions.json"));
    cfg.plugins!.entries!.example.grants!.boundChat!.push({
      ...grant,
      agentId: conflict ? "other" : "fixed",
    });
    expect(prepareBoundChatStartup(cfg)).toEqual({ invalid: true, grants: [] });
  },
);
