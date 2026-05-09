// WebAuthn relying-party config.
//
// RP_ID  = the registrable domain the passkey is bound to. localhost for dev,
//          app.switchleads.co.uk for prod. A passkey enrolled against
//          localhost will not work for app.switchleads.co.uk and vice versa
//          (origin-bound by construction, which is what makes WebAuthn
//          phishing-resistant).
// ORIGIN = full origin (scheme + host + port). Used for verifying the
//          assertion's clientDataJSON.origin field.
//
// PORTAL_URL env var drives both. Defaults to http://localhost:3000 for
// dev convenience.

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
}

const RP_NAME = "SwitchLeads";

export function getWebAuthnConfig(): WebAuthnConfig {
  const portalUrl = process.env.PORTAL_BASE_URL ?? process.env.NEXT_PUBLIC_PORTAL_BASE_URL ?? "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(portalUrl);
  } catch {
    throw new Error(`PORTAL_BASE_URL is not a valid URL: ${portalUrl}`);
  }
  return {
    rpId: url.hostname,
    rpName: RP_NAME,
    origin: url.origin,
  };
}
