-- Owner edit requests (release plan §3).
--
-- product_drafts doubles as the edit-request inbox: target_sku set means the
-- payload is a diff against that catalog SKU (kind: "edit"); null keeps
-- today's meaning of a brand-new product draft.
--
-- Whether target_sku actually belongs to the submitting store cannot be
-- checked in SQL — the catalog is static and lives outside the database —
-- so the admin approval flow enforces it, and tests attack that flow.

alter table product_drafts add column target_sku text;
