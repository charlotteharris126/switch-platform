// /admin/data-ops — kept as a redirect to /errors after the consolidation
// pass on 2026-05-11. All the one-shot panels (024 Brevo URLs, 025
// client_nonce, sheet ID backfill) now live on Data health (/errors)
// under "Data ops — one-shot fixes", below the live drift reconcile.
//
// This redirect exists so existing bookmarks, deep-links from emails,
// and any code referencing /data-ops still resolve.

import { redirect } from "next/navigation";

export default function DataOpsPage(): never {
  redirect("/errors");
}
