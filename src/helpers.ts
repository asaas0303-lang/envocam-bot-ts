export function getAdminIds(): string[] {
  const raw = process.env["ADMIN_IDS"] || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdmin(userId: number | string): boolean {
  return getAdminIds().includes(String(userId));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
