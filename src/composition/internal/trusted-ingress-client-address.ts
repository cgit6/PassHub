const clientAddresses = new WeakMap<object, string | null>();

/** Private outer-ingress binding; request headers cannot supply this provenance. */
export function bindTrustedIngressClientAddress(request: object, clientAddress: string | null): void {
  if (clientAddresses.has(request)) throw new TypeError('ingress client address is already bound');
  clientAddresses.set(request, clientAddress);
}

/** Standalone admission retains its direct socket-peer fallback. */
export function readTrustedIngressClientAddress(request: object): string | undefined {
  return clientAddresses.get(request) ?? undefined;
}
