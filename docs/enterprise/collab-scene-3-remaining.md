# Remaining: Lody scene 3 on a signed-in phone

Delete this file when an employee can sign in on a USB debug App, open the shared
Workspace, send a plane turn, and see revoke. Until then this is the pickup note
for the next session. Date: 2026-09-18. Branch: `enterprise/lody-m0-contracts`.
HEAD when this was written: `a1fe633f1`.

Read `ENTERPRISE_IMPLEMENTATION_MASTER.md` and [contracts.md](contracts.md) before
editing. Product bar is Lody plan E2E scene 3, not a same-daemon agent-stream
shortcut. Collaboration stays opt-in (`config.collaboration.enabled`, ADR-0031).

## Do first

1. Keep the uncommitted login/gate/proxy tree in this checkout. It is the work
   that makes the phone show 「使用企业账号登录」. Do not discard it.
2. Do not commit `2-workspace-dispatcher.patch`.
3. Sign in on the USB phone as `admin` or `employee1`. Passwords live under
   `~/.paseo-enterprise/operator/159.75.105.5/*.password` (32 characters; the
   form requires ≥12). Do not print them. The login button is green; a short
   password shows 「密码至少 12 个字符」 instead of staying disabled.
4. After `signed_in`, prove scene 3: owner share writable → member catalog shows
   the Workspace → member sends a turn through `collab.turn.send` → both see
   authored messages → queued turns while another turn runs → presence includes
   people and the node → revoke arrives on `collab.subscription.poll` → replica
   drops. Shared session body is the plane CRDT, not the local agent stream.
5. Hand [ADR-0055](decisions/0055-phone-password-session-via-node.md) to the
   integration owner. Do not expand or revert the node password forwarder until
   that lands.

## Uncommitted tree (keep)

Login and unsigned-access work that is not in `a1fe633f1`:

- `packages/app/src/runtime/enterprise-management-bootstrap.ts` — ADR-0030 HTTP
  bootstrap fetch, kept out of `host-runtime.ts` so the directory-sync require
  cycle cannot TDZ it on Hermes (`Property 'fetchEnterpriseManagementBootstrap'
doesn't exist`).
- `packages/app/src/runtime/unsigned-enterprise-access.ts` — gate decision:
  pending discovery must not render host children (those Redirect to global
  `/open-project` and unmount the form).
- `packages/app/src/runtime/enterprise-workbench-host.tsx` —
  `EnterpriseUnsignedAccessGate` on the host stack; first registered host also
  wraps global `/open-project`.
- `packages/app/src/app/h/[serverId]/_layout.tsx`,
  `packages/app/src/app/open-project.tsx` — mount the gate.
- `packages/app/src/utils/test-daemon-connection.ts` —
  `isEnterpriseAuthenticationRequired`.
- `packages/app/src/runtime/host-runtime.ts` — probe falls back to HTTP
  bootstrap; password ticket POST goes to the node, not the plane.
- `packages/app/src/components/enterprise/enterprise-identity-ui.tsx` — login
  button stays pressable; validate on submit (W6 exclusive file; already opened).
- `packages/server/src/server/enterprise-password-session.ts` and the
  `POST /api/enterprise/password-session` route in `bootstrap.ts` — node
  CA-pins and forwards `/v1/auth/password/session`. Rebuild server dist and
  restart 6767 after editing this path (`collaboration.enabled` is not
  reloadable either).

`npm run format` before any commit. Dual-push remotes `personal`
(`gmslll/paseo`) and `infinite` (`InfiniteStatesInc/infinite-paseo`); compare
SHAs. Ignore pre-existing failures in
`bootstrap.enterprise-construction.test.ts` and
`enterprise/audit/production-ownership-crossflow.test.ts`. Never run the full
test suite.

Targeted evidence already green on this tree:

```bash
cd packages/app && npx vitest run --project unit \
  src/runtime/host-runtime.test.ts \
  src/runtime/enterprise-workbench-host.test.ts \
  src/runtime/enterprise-management-bootstrap.test.ts
cd packages/server && npx vitest run src/server/enterprise-password-session.test.ts
```

The app Vitest browser project currently fails in this checkout while optimizing
`expo-router` JSX. Do not treat that as a regression of this work. Prefer
`--project unit`.

## Live environment (2026-09-18, stale after reboot)

- Daemon home `~/.paseo-enterprise-node`, listen `0.0.0.0:6767`, hostnames
  `192.168.1.42,localhost`, no relay. Restarted from this checkout with
  `node packages/cli/bin/paseo daemon start --home /Users/gms/.paseo-enterprise-node --listen 0.0.0.0:6767 --hostnames 192.168.1.42,localhost --no-relay --foreground`.
  Packaged LaunchAgent still waits for Paseo.app `0.8.1-beta.11` and is not this
  process. Ask before killing a long-lived 6767 you did not start.
- Local management plane `https://192.168.1.42:17443`, self-signed certs under
  `~/.paseo-enterprise/operator/local-plane/`. Ticket issuer must equal
  `relationship.managementBaseUrl` (`127.0.0.1` vs `192.168.1.42` fails auth).
  Do not point collab at remote `159.75.105.5:17443`; it has no
  `/v1/node/collab/*`.
- Node `nod_978490516bb9e883`, org `org_ab4b767d9b162370`, server
  `srv_788yExdAgSGZ`. `qa-workspace-fixed` is enabled as
  `cws_5b8af9f5546d3838` (admin owner, employee1 editor).
- USB device Urovo DT50S serial `01992612006807` (`arm64-v8a`). Package
  `sh.paseo.debug`. Metro `8081` with
  `EXPO_PUBLIC_LOCAL_DAEMON=localhost:6767`. Keep `adb reverse` for
  `8081`, `6767`, and `17443`. Deep link:
  `exp+voice-mobile://expo-development-client/?url=http://127.0.0.1:8081`.
- Full-ABI debug assemble fails on `armeabi-v7a` reanimated. Arm64-only:
  `./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a`.
- Packaged `/Applications/Paseo.app` 0.8.0 has no collab UI. Personal
  `~/.paseo` workspaces are not on this daemon.

## Gotchas the code will not tell you

- Managed nodes refuse anonymous WebSocket hello (ADR-0030). Discovery is HTTP
  `GET /api/enterprise/bootstrap`. Putting that fetch inside `host-runtime.ts`
  dies on Hermes because of
  `host-runtime.ts → directory-sync → use-archive-agent → host-runtime.ts`.
- Host index Redirects to global `/open-project`. If the unsigned gate renders
  children while discovery is pending, that Redirect unmounts the login form.
  Keep pending off the host stack.
- `EXPO_PUBLIC_LOCAL_DAEMON` is inlined at Metro bundle time. Changing it
  without restarting Metro leaves the phone talking to the old endpoint.
- `runConfiguredOverrideBootstrap` keeps retrying anonymous hello after the
  host is already in the registry and logs `Enterprise authentication required`
  forever. Stop that loop when you touch host bootstrap; it is not required
  for scene 3.
- Enable session mutations authorize as `workspace.write` even though inventory
  says `workspace.manage`.
- Hermes still reads plane-materialized JSON. Do not wait on native Loro.
  Presence/SSE stay client-only (ADR-0032); the App uses
  `collab.subscription.poll` through the node.

## Out of scope until scene 3 is proven on the phone

- ADR-0054 Boss `turn_diff` content-read.
- M8 task board / review / PR (ADR-0040, 0046–0049).
- ADR-0051 invite links.
- ADR-0052 cancel audit durability and `ManagedNodeLifecycle.onError`.
- Installing a management CA on the phone so the App can POST to the plane
  itself (that is option 2 in ADR-0055, not a silent rewrite).
