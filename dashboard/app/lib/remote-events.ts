export const REMOTE_DRAFTS_CHANGED = "bd:remote-drafts-changed";

export function notifyRemoteDraftsChanged() {
  window.dispatchEvent(new Event(REMOTE_DRAFTS_CHANGED));
}
