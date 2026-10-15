# Product board setup specification

One product Kanban for both repositories. Inspect the existing 0x board before repurposing; do not automatically copy/delete old cards. Actual creation and edits require separate approval.

Fields: Outcome association, Approval, Delivery, Horizon, owning repository, dependencies. Approval/Delivery/Horizon are independent. Delivery: Backlog → Ready → In progress → Review → Verification → Done. Default delivery views group by Outcome. No fabricated deadlines/priorities.

| Outcome             | Acceptance                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- |
| O1 — Foundations    | Two projects, OpenAPI, threat model, CI, local setup and isolated environment contract |
| O2 — Payment engine | Authenticated USD quote through correctly attributed, idempotent Devnet settlement     |
| O3 — Integration    | Input/Pay example, hosted checkout, four agreed notifications, signed webhooks         |
| O4 — Operations     | Manual dev acceptance, enforceable production gate, monitoring, rollback and restore   |
| O5 — Retirement     | Useful work preserved, old consumers inventoried, authorized Shopify retirement        |

Use the delivery issue template for bounded tasks with dependencies, checks and evidence. Merged is not deployed; deployed is not verified. Keep actual delivery evidence on the board/release records rather than duplicating a task diary here.
