// Shared types for the whole package. These document the shapes the page
// reads and CLI outputs produce; the runtime behavior is unchanged from the
// single-file prototype.

/** One conversation turn as read from the rendered thread. */
export interface ChatMessage {
  role: string;
  text: string;
}

/** Result of sendChat / sendProjectChat. `status` is 'done' | 'timeout'. */
export interface SendResult {
  url: string;
  status: 'done' | 'timeout';
  /** Latest round [{role, text}] (partial text included on timeout). */
  messages: ChatMessage[];
}

/** Sidebar project row: id is null when the project has no chats rendered. */
export interface ProjectEntry {
  name: string;
  id: string | null;
}

/** Sidebar search result row. */
export interface SearchHit {
  title: string;
  url: string;
}

/** One discovered AdsPower SunBrowser CDP endpoint. */
export interface SunBrowserInstance {
  envId: string;
  port: number;
  browser: string;
  hasChatGptTab: boolean;
}

/** A CDP /json/list target entry (a browser tab). */
export interface CdpTarget {
  id?: string;
  targetId?: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/** enterProject result. */
export interface ProjectHome {
  url: string;
  projectId: string | null;
  projectName: string | null;
}

/** newProjectChat result (project entered, composer ready). */
export interface NewProjectChatResult extends ProjectHome {
  composer: string;
}

/** setEffort result. */
export interface EffortResult {
  effort: string;
  changed: boolean;
}

/**
 * Port as accepted by every entry point: an explicit port (number or string),
 * or null/undefined to fall back to CDP_PORT / auto-discovery.
 */
export type PortSpec = string | number | null | undefined;

/** Options for sendChat. */
export interface SendOptions {
  chatUrl?: string;
  timeoutMs?: number;
  effort?: string;
}

/** Options for sendProjectChat (adds projectId). */
export interface SendProjectOptions extends SendOptions {
  projectId?: string;
}
