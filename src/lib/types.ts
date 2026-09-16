export type ChatMessage = {
  id: string;
  room: string;
  username: string;
  text: string;
  createdAt: number;
};

/** Events the server pushes down to a connected client. */
export interface ServerToClientEvents {
  history: (messages: ChatMessage[]) => void;
  message: (message: ChatMessage) => void;
  presence: (users: string[]) => void;
  typing: (users: string[]) => void;
  joined: (payload: { room: string; username: string }) => void;
  rejected: (reason: string) => void;
}

/** Events a client sends up to the server. */
export interface ClientToServerEvents {
  join: (payload: { room: string; username: string }) => void;
  message: (payload: { text: string }) => void;
  typing: (payload: { isTyping: boolean }) => void;
}

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_USERNAME_LENGTH = 24;
export const MAX_ROOM_LENGTH = 32;
export const HISTORY_LIMIT = 100;

// Control characters, minus tab/newline which we handle as ordinary whitespace.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strip control characters and collapse horizontal whitespace so rendering stays predictable. */
export function cleanText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";
  return input
    .replace(CONTROL_CHARS, "")
    .replace(/[^\S\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Rooms appear in the URL, so restrict them to a slug that round-trips safely. */
export function normalizeRoom(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_ROOM_LENGTH);
}
