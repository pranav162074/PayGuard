/** Reads the payment id and client secret from a checkout link: /pay/{id}?client_secret=... */
export function parseCheckoutLink(
  location: Pick<Location, "pathname" | "search">,
): { paymentId: string; clientSecret: string } | null {
  const match = /^\/pay\/(pi_[0-9a-f]+)\/?$/.exec(location.pathname);
  const clientSecret = new URLSearchParams(location.search).get("client_secret");
  if (!match?.[1] || !clientSecret) return null;
  return { paymentId: match[1], clientSecret };
}
