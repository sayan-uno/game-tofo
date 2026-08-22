import { API_URL } from "../config";
import type { User } from "../types";

const TOKEN_KEY = "tofo_token";
const USER_KEY = "tofo_user";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function loadUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as User) : null;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  /** The machine-readable reason, when the server gave one — "BANNED",
   *  "MAINTENANCE". A message is for a person; this is for the code. */
  code?: string;
  /** When a sanction lifts. A ban with no end reads as forever, and most of
   *  them are not. */
  until?: string | null;
  constructor(status: number, message: string, code?: string, until?: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.until = until;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; until?: string | null };
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code, data.until);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};
