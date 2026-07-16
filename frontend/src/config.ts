// ============================================================
// THE ONLY COUPLING POINT BETWEEN FRONTEND AND BACKEND.
// Set VITE_API_URL in frontend/.env — that is the ONE line you
// change when the backend is hosted somewhere else.
// ============================================================
export const API_URL: string = import.meta.env.VITE_API_URL || "http://localhost:4000";

export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
