# ADR 0013: Relay encrypted authentication preface

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Relay outer headers, subprotocol values, and Relay IDs are visible outside the end-to-end encrypted
channel and cannot authenticate an enterprise Principal. A sealed reusable credential envelope
would be replayable across physical connections.

## Decision

`e2ee_hello` advertises the `encryptedAuthPrefaceV1` capability. The old name
`authPrefaceV1` is not accepted or advertised.

For every physical connection, the daemon creates at least 32 random bytes of challenge material.
Only after capability negotiation succeeds does `ready` include optional
`encryptedAuthPrefaceV1: true` and `admissionChallenge` fields.

After the secure channel is established, the client sends a private encrypted authentication
preface bound to that challenge. The daemon replies with encrypted `auth_ok`. Before `auth_ok`, the
client does not emit open state or send the Session hello. Before authentication succeeds, the
daemon performs no attachment, Session construction, or Owner admission.

Replaying an old hello and encrypted preface fails against the new per-connection challenge. The
sealed-envelope alternative is rejected because it permits replay.

These fields belong to the Relay encrypted-channel handshake, not the ordinary Session schema.

## Ownership

- W0 owns this ADR only.
- W1 owns the Relay encrypted-channel and server Relay transport/runtime implementation.
- W3 owns the client Relay wrapper and daemon client implementation.
- W7 owns real replay and pre-authentication adversarial tests.
