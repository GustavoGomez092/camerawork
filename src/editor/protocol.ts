import type { Look } from "../schema.js";

/** The files the editor page is built into (dist/editor/), served by the editor server at `/<name>`. */
export const EDITOR_ASSETS = ["index.html", "editor.js", "editor.css"] as const;

/** GET /look: the starting look and the window the preview shows. */
export interface LookInfo {
  look: Look;
  /** The master's size and duration, or the neutral placeholder's (1920×1080, 10 s) without --master. */
  window: { width: number; height: number; duration: number };
  hasMaster: boolean;
  /** The absolute path Save writes. */
  out: string;
}

/** POST /save (body: a Look as JSON, Content-Type application/json): 200 with `{ saved }`, or 400 with `{ error }`. */
export type SaveReply = { saved: string } | { error: string };

/** The page posts a heartbeat this often; the server ends an unsaved session after `idleMs` without one. */
export const HEARTBEAT_MS = 5000;
