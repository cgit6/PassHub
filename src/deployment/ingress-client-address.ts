import { isIP } from 'node:net';

export interface IngressClientAddress {
  readonly peerAddress: string | null;
  readonly clientAddress: string | null;
  readonly trustedProxy: boolean;
}

function normalize(address: string | undefined): string | null {
  if (address === undefined) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function resolveIngressClientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trustedProxyIp: string,
): IngressClientAddress {
  const peerAddress = normalize(socketAddress);
  const trustedProxy = peerAddress === trustedProxyIp;
  const candidate = typeof forwardedFor === 'string' && !forwardedFor.includes(',') ? forwardedFor : null;
  const clientAddress = trustedProxy && candidate !== null && isIP(candidate) !== 0 ? candidate : peerAddress;
  return Object.freeze({ peerAddress, clientAddress, trustedProxy });
}
