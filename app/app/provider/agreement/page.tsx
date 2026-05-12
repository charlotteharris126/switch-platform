// /provider/agreement — kept as a redirect to /provider/account after the
// agreement nav tab was folded into Account on 2026-05-12. Bookmarks and
// any old links (email signatures, PDFs etc.) still resolve.

import { redirect } from "next/navigation";

export default function ProviderAgreementPage(): never {
  redirect("/provider/account");
}
