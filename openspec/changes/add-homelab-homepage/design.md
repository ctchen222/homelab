## Context

The homelab platform is expected to host multiple projects and operator tools on one private VPS-backed k3s cluster. FinOps is one project that can appear on this page, but the homepage itself is a platform entry surface:

- quick links to user-interest projects
- service groups for apps, infrastructure, and admin tools
- simple VPS and k3s status visibility
- per-service health status
- private/admin-only access labeling

The homepage should stay lightweight. Its first release should not become a custom application platform or a second observability stack.

## Goals / Non-Goals

**Goals:**

- Provide a private, fast landing page for homelab services and project links.
- Show simple service status from health endpoints or monitoring data.
- Show VPS/k3s resource context such as CPU, memory, and pod/service health when available.
- Keep admin-only links clearly labeled and protected by the private access boundary.
- Allow app changes such as FinOps to publish service metadata without owning homepage code.
- Use `gethomepage/homepage` as the first dashboard implementation before considering custom UI work.

**Non-Goals:**

- Do not implement FinOps workflows inside the homepage.
- Do not build a custom React single-page app for the first homepage release.
- Do not expose Kubernetes API credentials or database credentials through the homepage.
- Do not make the homepage the source of truth for monitoring history or alerting.
- Do not expose admin links publicly just because they are listed on the homepage.

## Decisions

### Decision 1: Split homepage from app-specific products

The homepage will be tracked as its own platform capability. FinOps, FurFriend-Finder, and future apps only provide URLs, health endpoints, labels, and runbook links for the homepage to display.

Rationale:

- The homepage answers "what is running and where do I go?"
- FinOps answers "how do I capture and review personal finance data?"
- Splitting the specs keeps app scope from drifting into platform navigation work.

Alternatives considered:

- Keep homepage integration inside FinOps: convenient for the first app, but it would make every future platform link look like FinOps work.
- Make each app own its own homepage section: simple locally, but produces inconsistent metadata and access labeling.

### Decision 2: Use gethomepage/homepage, not custom React

The first implementation will use `gethomepage/homepage`. A custom React app is not required for the MVP.

Rationale:

- The homepage is primarily links, groups, and status cards.
- Homepage already supports YAML-style configuration, service widgets, information widgets, and Kubernetes-aware metadata.
- Avoiding custom React reduces build, dependency, styling, and maintenance cost.

Alternatives considered:

- Custom React/Vite dashboard: flexible, but unnecessary until the homepage needs custom workflows.
- Astro/static site: a reasonable fallback if the desired page is mostly static and the status data can be fetched from a small JSON endpoint.
- Gatus or Uptime Kuma as the homepage: useful for monitoring, but less ideal as the primary project/service navigation page.

### Decision 3: Keep status shallow and composable

The homepage will show current state from health endpoints, service metadata, service widgets, information widgets, and optional Kubernetes resource summaries. Long-term history, alert rules, and incident timelines belong in a monitoring tool such as Gatus, Uptime Kuma, Prometheus, or Grafana.

Rationale:

- A homepage should quickly show "healthy, degraded, down, unknown" and link to the right tool.
- Deeper observability has different storage, alerting, and retention needs.
- This keeps the homepage low-resource and easy to replace.

Alternatives considered:

- Build a custom monitoring backend into the homepage: too much scope for a link/status page.
- Only link to Grafana: too little context for a daily entry page.

### Decision 4: Use manual service catalog plus Kubernetes status integration

The MVP should use repo-owned Homepage configuration as the source of truth for groups, labels, admin-only classification, and links. Kubernetes integration should be enabled for read-only cluster/resource status and, later, limited service discovery through annotations.

Rationale:

- Manual `services.yaml` configuration keeps sensitive grouping and admin-only labels intentional.
- Homepage Kubernetes mode is useful for cluster context, pod/service metadata, and future annotation-based discovery.
- Relying only on Kubernetes auto-discovery can make ordering and grouping less predictable, and not every interesting link is a Kubernetes Ingress.

Alternatives considered:

- Kubernetes auto-discovery as the only catalog source: lower maintenance, but weaker for curated links, external docs, and admin-only labeling.
- Manual links only with Kubernetes disabled: simplest, but misses the desired VPS/k3s status view.

### Decision 5: Use metadata as the integration boundary

Services should be registered with structured metadata: name, group, description, URLs, health endpoint, namespace, owner, sensitivity, documentation link, and optional dashboard widget configuration.

Rationale:

- Apps can publish metadata without knowing homepage internals.
- The homelab repo can own the platform catalog and access labels.
- The same metadata can support Homepage, static HTML, or a future custom dashboard.

### Decision 6: Treat private access as a hard requirement

The homepage may be visually simple, but it can reveal sensitive topology, admin links, and service names. It must sit behind the same private access boundary used for sensitive homelab tooling.

Rationale:

- A service catalog leaks useful operational information.
- Admin links should be convenient for the owner, not public discovery points.
- Access control belongs at both the network/reverse-proxy layer and, where appropriate, the backing service.

## Risks / Trade-offs

- [Risk] Homepage becomes a dumping ground for every tool link. -> Mitigation: require group, sensitivity, owner, and doc/runbook metadata for each service.
- [Risk] Status cards give false confidence if they only check HTTP 200. -> Mitigation: prefer app-owned `/health` responses that include datastore or dependency state where relevant.
- [Risk] Kubernetes integration requires service account permissions. -> Mitigation: grant read-only permissions limited to the resources needed for dashboard status.
- [Risk] Admin links are accidentally treated as public links. -> Mitigation: require explicit admin-only labels and private access documentation.
- [Risk] Existing dashboard tooling is not flexible enough. -> Mitigation: keep the metadata contract tool-agnostic so the frontend can later move to Astro/static HTML or a custom app.

## Migration Plan

1. Create homepage service catalog metadata with grouped links and sensitivity labels.
2. Deploy `gethomepage/homepage` as the first dashboard implementation.
3. Configure Homepage service widgets and information widgets for the first useful status view.
4. Add Kubernetes integration in cluster mode with read-only permissions if metrics are available.
5. Add private ingress and access protection.
6. Add health checks for existing services and mark unsupported services as unknown rather than healthy.
7. Add VPS/k3s resource summary if metrics are available with read-only access.
8. Link FinOps through metadata after the FinOps service exists.
9. Add optional monitoring integration only if shallow health status is not enough.

Local testing strategy:

- Use Docker Compose only for checking Homepage configuration renders correctly.
- Use k3d for Kubernetes-specific behavior such as service account permissions, ingress discovery, metrics availability, and mounted ConfigMaps.
- Use the same Helm chart or manifests with local and production values so the VPS deployment is not a separate snowflake.

Rollback strategy:

- Disable the homepage ingress or deployment.
- Keep service metadata in the repo for later reuse.
- Continue accessing services directly through their existing private URLs.

## Open Questions

- Which private access method should protect the homepage first: IP allowlist, reverse-proxy basic auth, VPN-only access, or another existing boundary?
- Should status history and alerting be added through Gatus/Uptime Kuma immediately, or deferred until basic links and health status are working?
