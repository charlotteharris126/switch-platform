// Retired 2026-05-11. Provider sign-in moved to email + password +
// email 6-digit code on /provider-login. The passkey login page kept
// only as a redirect so any old bookmarks still land somewhere useful.

import { redirect } from "next/navigation";

export default async function RetiredPasskeyLoginPage() {
  redirect("/provider-login");
}
