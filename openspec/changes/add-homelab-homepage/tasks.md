## 1. Scope and Dashboard Selection

- [ ] 1.1 Confirm the homepage is a homelab platform entry surface, not a FinOps feature.
- [ ] 1.2 Use `gethomepage/homepage` as the first dashboard implementation.
- [ ] 1.3 Document why a custom React app is deferred for the first homepage release.
- [ ] 1.4 Define the first private access boundary for the homepage.

## 2. Service Catalog Metadata

- [ ] 2.1 Define repo-owned service metadata fields for name, group, description, URL, sensitivity, owner or project, docs link, health endpoint, and optional widget configuration.
- [ ] 2.2 Add initial catalog entries for existing services, planned FinOps, infrastructure tools, observability tools, and admin-only links.
- [ ] 2.3 Group homepage entries into applications, infrastructure, observability, databases, admin tools, and documentation.
- [ ] 2.4 Ensure admin-only entries are labeled separately from normal application links.
- [ ] 2.5 Configure Homepage service widgets only for services where credentials and status data are safe to expose behind private access.

## 3. Health and Status Sources

- [ ] 3.1 Define the health status contract consumed by the homepage: healthy, degraded, down, and unknown.
- [ ] 3.2 Add service health checks for services that already expose health endpoints.
- [ ] 3.3 Mark services without health endpoints as unknown until app-owned health endpoints exist.
- [ ] 3.4 Decide whether Gatus, Uptime Kuma, Prometheus, or direct health checks should provide the first monitoring summary.

## 4. VPS and k3s Visibility

- [ ] 4.1 Verify whether metrics-server or another read-only metrics source is available in the k3s cluster.
- [ ] 4.2 Add a compact VPS/k3s status view for CPU, memory, nodes, pods, and namespaces when metrics are available.
- [ ] 4.3 Limit homepage Kubernetes access to read-only permissions required for dashboard status.
- [ ] 4.4 Decide which services, if any, should use Kubernetes annotation-based auto-discovery after the manual catalog is working.
- [ ] 4.5 Document behavior when cluster metrics are unavailable.

## 5. Deployment and Operations

- [ ] 5.1 Add Kubernetes or Helm deployment configuration for `gethomepage/homepage`.
- [ ] 5.2 Add private ingress configuration for the homepage.
- [ ] 5.3 Document how apps publish metadata and health endpoints for homepage consumption.
- [ ] 5.4 Verify the homepage renders links, admin labels, service status, and unavailable metrics states correctly.
- [ ] 5.5 Add Docker Compose smoke-test instructions for checking Homepage configuration locally.
- [ ] 5.6 Add k3d deployment test instructions for Kubernetes service account, ingress, metrics, and ConfigMap behavior.
- [ ] 5.7 Add runbook notes for adding, disabling, or removing homepage services.
