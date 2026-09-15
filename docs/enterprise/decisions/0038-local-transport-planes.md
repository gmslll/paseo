# ADR-0038: Local transport planes

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The daemon adds four local planes next to the existing WebSocket listener. The WebSocket and relay
paths stay unchanged for every existing client.

| Plane    | Socket              | Framing                                                                                                                  | Admission                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| probe    | `run/probe.sock`    | HTTP `GET /healthz`, `GET /state`                                                                                        | socket permissions; no Principal data                                        |
| control  | `run/control.sock`  | HTTP upgrade `paseo-ndjson/1` carrying existing WS JSON, plus `POST /v1/rpc`                                             | `x-paseo-local-token`; enterprise mode also requires a PAT or Session Ticket |
| terminal | `run/terminal.sock` | upgrade `paseo-terminal/1`; `[u32 BE length][payload]` with existing terminal opcodes, `0x40` for JSON terminal messages | local token plus a one-use attach token                                      |
| data     | `run/data.sock`     | upgrade `paseo-data/1`; `[u32 BE length][data frame]`                                                                    | local token plus a one-use attach token                                      |

- `run/` is mode 0700; sockets and `run/local-token` are 0600. On Windows the planes are named
  pipes `\\.\pipe\paseo-<sha256(home)[:12]>-<plane>` and the token is mandatory.
- When a macOS socket path exceeds 104 bytes, the planes move to `$TMPDIR/paseo-<sha256(home)[:12]>/`.
- `run/daemon.json` is written after every listener is ready and lists each plane path and protocol
  version. `paseo.pid` remains the lock file.
- Terminal and data connections are secondary channels of an admitted Session. The Session issues a
  60-second, one-use attach token bound to Session, Principal, Grant version, and plane. Sessions
  that arrived through the relay cannot issue one. Closing or invalidating the Session closes its
  channels.
- In enterprise mode the local token alone is admitted only as break-glass Owner when explicitly
  enabled, and always writes a high-priority audit event.
- The data frame is `[u8 opcode 0x20–0x2F][u16 BE docId length][docId UTF-8][payload]`. Over an
  existing WebSocket the same bytes travel as a binary frame when the daemon advertises `dataPlane`
  and the client declares the matching capability.

Feature flags: `localPlanes`, `terminalPlane`, `dataPlane`.

## Amends

- Master spec §16 transport surfaces.
- W1 admission and W3 Session ownership: plane adapters reuse `admission.authenticateEvidence` and
  the Session authorized emit path.

## Acceptance

End-to-end tests against `createPaseoDaemon` cover file modes, missing-token denial, enterprise
admission on the control plane, attach-token expiry and reuse, relay denial, channel teardown on
revocation, and terminal echo parity with the WebSocket path.
