/**
 * DAV-7074: record how each /mcp request reached this server, so an audit can
 * count public Tailscale Funnel calls separately from tailnet and local calls
 * (`mcp_request_log.params->>'ingress'`).
 *
 * Tailscale serve proxies from loopback. On public Funnel traffic it sets
 * `Tailscale-Funnel-Request`; on traffic from a tailnet user device it sets
 * `Tailscale-User-Login`. Those headers are honored only when the TCP peer is
 * loopback, because a non-loopback peer did not come through the local
 * Tailscale proxy and can send any header it likes.
 *
 * Classes:
 *   - funnel:   loopback peer carrying Tailscale-Funnel-Request
 *   - tailnet:  loopback peer carrying Tailscale-User-Login (user devices;
 *               tagged tailnet nodes carry no identity header and log as loopback)
 *   - loopback: loopback peer without Tailscale headers (local clients)
 *   - network:  any non-loopback peer (server bound beyond 127.0.0.1)
 *
 * This is an audit signal only. Never use it for authorization: any local
 * process can set these headers on a loopback request.
 */

export type RequestIngress = 'funnel' | 'tailnet' | 'loopback' | 'network';

export const TAILSCALE_FUNNEL_HEADER = 'tailscale-funnel-request';
export const TAILSCALE_USER_LOGIN_HEADER = 'tailscale-user-login';

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function requestIngress(
  header: (name: string) => string | undefined,
  peerAddress: string | undefined,
): RequestIngress {
  if (!isLoopbackPeer(peerAddress)) return 'network';
  if (header(TAILSCALE_FUNNEL_HEADER) !== undefined) return 'funnel';
  if (header(TAILSCALE_USER_LOGIN_HEADER)) return 'tailnet';
  return 'loopback';
}

/**
 * Attach the server-derived ingress class to a request-log params object.
 * The server value is written last, so a tool argument named `ingress`
 * (full-params logging mode) cannot overwrite it.
 */
export function withIngress(params: unknown, ingress: RequestIngress): Record<string, unknown> {
  const base = params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  return { ...base, ingress };
}
