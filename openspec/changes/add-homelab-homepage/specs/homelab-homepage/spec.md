## ADDED Requirements

### Requirement: Private homelab homepage
The homelab platform SHALL provide a private homepage for quick access to project, application, infrastructure, and admin links.

#### Scenario: User opens homepage
- **WHEN** the authenticated owner opens the homelab homepage
- **THEN** the homepage displays grouped links for configured projects, applications, infrastructure tools, admin tools, and documentation

#### Scenario: Unauthenticated request opens homepage
- **WHEN** a request without valid private access attempts to open the homepage
- **THEN** the platform denies access before exposing service names, admin links, or status details

### Requirement: Homepage dashboard implementation
The homelab homepage SHALL use `gethomepage/homepage` as the first dashboard implementation without requiring a custom React application.

#### Scenario: Homepage is deployed
- **WHEN** the homepage is deployed for the first release
- **THEN** its service groups, links, labels, widgets, and status sources are configured through Homepage configuration owned by this repo

#### Scenario: Custom UI is deferred
- **WHEN** the first homepage release only needs links, grouping, status cards, and resource summaries
- **THEN** the implementation avoids a custom React single-page app

### Requirement: Curated catalog plus widgets
The homelab homepage SHALL use a curated repo-owned catalog for service grouping and Homepage widgets for useful status display.

#### Scenario: Service groups are configured
- **WHEN** services are added to the homepage
- **THEN** repo-owned Homepage configuration defines their groups, names, links, descriptions, icons, sensitivity labels, and optional service widgets

#### Scenario: Header status is configured
- **WHEN** the homepage needs system-level context
- **THEN** Homepage information widgets display configured VPS, search, date/time, resource, or monitoring summary data where available

### Requirement: Kubernetes status integration
The homelab homepage SHALL use Kubernetes integration as a read-only status aid rather than the only source of service catalog truth.

#### Scenario: Kubernetes integration is enabled
- **WHEN** Homepage runs inside the k3s cluster
- **THEN** it uses in-cluster read-only service account access for pod, service, ingress, or metrics status required by the dashboard

#### Scenario: Kubernetes auto-discovery is enabled
- **WHEN** a service is discovered from Kubernetes annotations
- **THEN** the discovered service still follows the homepage grouping, sensitivity, and admin-only labeling conventions

### Requirement: Service catalog metadata
The homelab homepage SHALL use structured service metadata for every displayed service.

#### Scenario: Service is registered
- **WHEN** a service is added to the homepage catalog
- **THEN** its metadata includes name, group, description, primary URL, sensitivity label, owner or project, and optional documentation link

#### Scenario: Admin service is registered
- **WHEN** a database, deployment, observability, or cluster-admin service is added to the homepage catalog
- **THEN** the service is marked admin-only and is not displayed as a normal public application link

### Requirement: Service health status
The homelab homepage SHALL display lightweight health status for configured services when health data is available.

#### Scenario: Service exposes health endpoint
- **WHEN** a registered service exposes a configured health endpoint
- **THEN** the homepage displays the service as healthy, degraded, down, or unknown based on the health result

#### Scenario: Service has no health endpoint
- **WHEN** a registered service does not expose health data
- **THEN** the homepage displays the service status as unknown rather than assuming it is healthy

### Requirement: VPS and k3s status visibility
The homelab homepage SHALL provide a compact view of VPS and k3s status when metrics or read-only cluster data are available.

#### Scenario: Cluster metrics are available
- **WHEN** read-only VPS or k3s metrics are available to the homepage
- **THEN** the homepage displays concise CPU, memory, node, pod, or namespace status without exposing write-capable cluster credentials

#### Scenario: Cluster metrics are unavailable
- **WHEN** VPS or k3s metrics are unavailable
- **THEN** the homepage remains usable as a service catalog and clearly marks resource status as unavailable

### Requirement: App metadata integration boundary
Application-specific changes SHALL publish metadata and health endpoints for the homepage without implementing homepage behavior themselves.

#### Scenario: FinOps is added to homepage
- **WHEN** the FinOps service is deployed and ready to appear on the homepage
- **THEN** FinOps provides service metadata and health status for the homepage to consume

#### Scenario: App is removed from homepage
- **WHEN** an application is disabled or no longer deployed
- **THEN** the homepage catalog can remove or mark the app unavailable without changing that application's core product code

### Requirement: Optional monitoring integration
The homelab homepage SHALL allow integration with a monitoring backend without making monitoring history or alerting part of the homepage core.

#### Scenario: Monitoring backend is configured
- **WHEN** a monitoring backend such as Gatus, Uptime Kuma, Prometheus, or Grafana is configured
- **THEN** the homepage can link to it or display summarized status from it

#### Scenario: Monitoring backend is not configured
- **WHEN** no monitoring backend is configured
- **THEN** the homepage still provides service links and direct health status for configured endpoints
