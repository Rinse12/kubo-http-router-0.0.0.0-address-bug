# Kubo sends raw `0.0.0.0` listen addresses to HTTP routers

Reproduction for https://github.com/ipfs/kubo/issues/10087

## Bug

When Kubo announces provider records to an HTTP router via `PUT /routing/v1/providers`, the `Addrs` field contains the raw `Addresses.Swarm` listen addresses (e.g. `/ip4/0.0.0.0/tcp/4001`) instead of the resolved interface addresses.

`ipfs id` correctly resolves `0.0.0.0` to actual interface addresses (e.g. `x.x.x.x`), but the HTTP Routing V1 code path does not use these resolved addresses.

This means any client that discovers a provider via an HTTP router gets useless `0.0.0.0` addresses and must fall back to a DHT `FIND_PEER` to find the actual peer, defeating the purpose of the HTTP router.

## Tested on

- Kubo **0.40.0**

## Reproduce

```bash
npm install
node index.mjs
```

## Expected output

Addresses sent to the HTTP router should be resolved interface addresses (same as `ipfs id` reports):

```
=== Addresses sent to HTTP router ===
  /ip4/x.x.x.x/tcp/24199
  /ip4/x.x.x.x/udp/24200/quic-v1
  ...
```

## Actual output

```
=== Addresses reported by `ipfs id` ===
  /ip4/x.x.x.x/tcp/24199/p2p/12D3KooW...
  /ip4/x.x.x.x/tcp/24199/p2p/12D3KooW...
  /ip4/127.0.0.1/tcp/24199/p2p/12D3KooW...
  ...

=== Addresses sent to HTTP router (3 PUT requests) ===
  /ip4/0.0.0.0/tcp/24199  <-- BUG: raw listen address
  /ip4/0.0.0.0/udp/24200/quic-v1  <-- BUG: raw listen address
```

## How the script works

1. Starts a minimal HTTP Routing V1 server that records incoming PUT requests
2. Initializes a fresh Kubo node configured with `Addresses.Swarm = ["/ip4/0.0.0.0/tcp/...", "/ip4/0.0.0.0/udp/.../quic-v1"]` and `Routing` pointing directly at the mock router
3. Adds content and triggers `ipfs routing provide`
4. Compares the addresses in the provider records received by the HTTP router against what `ipfs id` reports
