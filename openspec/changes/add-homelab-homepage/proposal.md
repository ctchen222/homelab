## Why

The homelab needs a small private homepage for quick project access and operational visibility. This is a platform entry surface, not part of the FinOps product scope, so it should be tracked as a separate OpenSpec change.

## What Changes

- Add a private homelab homepage capability for service links, project links, VPS status, and service health.
- Prefer a configuration-driven dashboard over a custom React application for the first release.
- Show public-facing app links, private admin links, and documentation/runbook links with clear grouping and access labels.
- Display lightweight status for the VPS, k3s cluster, and registered services using health endpoints, Kubernetes metadata, or a small monitoring backend.
- Keep sensitive admin surfaces such as pgAdmin, Argo CD, Grafana, and database links behind the private access boundary.
- Define a service metadata contract that app changes such as FinOps can publish without owning the homepage implementation.

## Capabilities

### New Capabilities

- `homelab-homepage`: Private platform homepage covering service catalog links, status display, VPS/k3s visibility, admin-only link labeling, and service metadata integration.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec requirements for a homelab platform homepage independent from FinOps.
- Future implementation will likely add dashboard configuration, Kubernetes or Helm deployment values, service metadata conventions, health check aggregation, and private access documentation.
- App-specific projects such as FinOps should only expose health and metadata for the homepage to consume; they should not implement the homepage itself.
