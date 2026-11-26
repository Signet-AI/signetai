---
title: Organization dashboard
description: Teams, administration, and classified material in a shared Signet instance.
---

In a claimed team instance, Settings includes **My teams**, **Organization**, and **Compliance**. These sections do not appear in local mode. The daemon checks every operation; hiding a control does not grant or remove access.

## Teams

Open **My teams** to see your memberships, the team's agents, and its members. Team owners can add or remove members. Memberships managed by an identity provider are read-only. Owners can issue expiring shared-agent keys for bots and CI. Copy a new key immediately; it is never displayed again.

## People and agents

Administrators can search **Users**, filter by status, role, or team name, invite people, change roles through a confirmed row action, and reactivate accounts. At narrow widths, each person is a stacked card with the same actions. **Offboard…** opens a three-step dialog: choose material handling, review readable impact and agent destinations, then type the person's displayed name exactly and confirm. Transferring ownership preserves authorship.

Offboarding and bulk key revocation return tracked jobs. Pending or running is not complete. If tracking becomes unavailable, retry to read the durable status; do not assume the operation failed or submit it again.

**Agents** shows ownership and who may act as each agent. Administrators can create team agents, transfer ownership, and archive them. Archiving prevents anyone from acting as that agent.

## Access and authentication

**Roles and permissions** is a read-only matrix. Compliance adds classification and audit permissions, but does not bypass an audience. **Effective access** explains a user's role, teams, agent access, and readable classifications.

**All API keys** supports user, device, harness, and agent filters, bulk revocation, and scoped shared-agent issuing. **Authentication** configures OIDC, allowed email domains, group mappings, password policy, and session and connector-key lifetimes. Store an OIDC client secret in **Secrets**, then enter its secret name, never its value, in authentication settings. Copy the redirect URI into the identity provider.

**Audit log** filters events by actor, action, target, and UTC time range. Export downloads NDJSON for the selected filters. Administrators can set retention; saving retention does not mean cleanup has already finished. **Instance health** displays daemon-reported signals, including hybrid-proxy warnings when available. Unreported capacity is unavailable, not healthy.

## Reading shared memory

Home and Memory follow the agent switcher. Text, author, and team filters narrow the current page; choosing a classification opens its readable material pages, narrowed to the selected agent. **Open knowledge graph** keeps the graph available from Memory. Classification item lists have Previous and Next controls and use the same material rows as Memory and Sessions.

Dreams shows passes and logs that the current credential may read. Being an administrator does not bypass a classification audience. Per-pass classification filtering is not available yet.

Home's System section reports readable sources, your own device connectors, and agents you may act as. Secrets are hidden from non-administrators; an instance-local secret store is labeled **Stored on this instance**, never on the browser's device.

## Classifications

Compliance users can create classifications, edit names and descriptions, and archive definitions. Audience and applier editing requires the daemon to return the current principals; the dashboard never replaces unknown membership with an empty list. Audience members can inspect the items carrying a classification.

**Classify…** previews the readable evidence and derived rows affected before applying a classification. Follow the returned job to completion. Administrative privileges do not reveal material outside your audience. Signet does not offer break-glass access.
