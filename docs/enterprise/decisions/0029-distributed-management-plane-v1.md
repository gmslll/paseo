# ADR-0029: Distributed management plane v1

- Status: Accepted
- Date: 2026-09-12
- Decision owner: Enterprise integration owner

## Decision

P2 uses a separate `@getpaseo/enterprise-management` service and the W8-owned daemon adapter in
`packages/server/src/server/enterprise/managed-node/`. The service is the only authority for
organization Principals, Grants, node relationships, Placement, cross-node leases, revocation
epochs, and the global audit index. A Paseo daemon remains the authority for local Workspace,
Agent, file, Browser Profile, and Provider state.

The first deployment is one management-plane process backed by one Node 22 SQLite database in WAL
mode. Every authority mutation uses `BEGIN IMMEDIATE`, durable commits, foreign keys, and monotonic
versions. This meets the first two-node deployment without consuming the existing server's
PostgreSQL or Redis instances. Running more than one management-plane replica requires a later ADR
and a transactional shared database; copying the SQLite file between live replicas is forbidden.

The public listener is HTTPS on TCP port `17443`. The process requires an explicit certificate and
private key. Plain HTTP is limited to loopback health checks and is never accepted for credentials,
enrollment, tickets, leases, or audit upload.

## Trust and authentication

- Employees and administrators authenticate to the management plane with one-time-displayed
  personal access tokens. Only a memory-hard digest and credential metadata are stored.
- An administrator creates a short-lived, one-use enrollment token. The node generates an Ed25519
  key pair locally and submits only its public key during enrollment.
- Every later node request signs method, path, timestamp, nonce, and body digest. The plane verifies
  the enrolled public key and rejects replay, stale timestamps, revoked nodes, and a concurrent
  second boot identity.
- The plane signs short-lived Session Tickets with an Ed25519 key kept only by the plane. A ticket
  binds organization, Principal, credential, Grant version, revocation epoch, `nodeId`,
  `paseoServerId`, expiry, and a unique ticket ID. Nodes reject a ticket for another node or server.
- Browser/App write leases are keyed by `businessIdentityId`. Acquisition and fencing-token
  increment occur in one database transaction. A disconnected node cannot renew after expiry.

## Data flow

Clients authenticate once to the plane, resolve a Workspace or request placement, receive the
selected node endpoint plus a node-bound Session Ticket, then connect directly to that daemon.
Prompt bodies, files, Provider credentials, Browser cookies, and raw Timeline data stay on the
node. The plane stores only global resource references, node health/capacity, redacted session
summaries, lease state, and an idempotent audit index. Content access uses a separate one-time,
short-lived ticket and is audited at the target node.

## Workstream integration

W8 owns the service and managed-node adapter. The integration owner authorizes the minimum W0/W1,
W2/W3, and W6 call sites required to select `managementMode: "managed"`, authenticate a Session
Ticket, install remote Port adapters, and let a client obtain a route. These call sites must retain
the existing local authorization checks and feature gates. Standalone mode remains the default and
must behave exactly as before.

## Deployment and recovery

The first server deployment is a single container with a private persistent volume for the
database and signing key. Backups use SQLite's online backup mechanism or a stopped consistent
copy. Restore never decreases Grant versions, revocation epochs, audit sequence state, or lease
fencing counters. The service binds `17443`; firewall exposure happens only after the TLS
certificate, bootstrap administrator, and health checks are ready.

## Acceptance

Release requires the P2 cases in the master specification, including two real nodes, cross-node
ticket rejection, Drain, duplicate-node quarantine, global lease fencing, audit gap detection, and
Boss metadata without implicit content access. Unit-only evidence does not qualify as the final P2
release.
