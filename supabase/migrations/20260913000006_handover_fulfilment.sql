-- Two-step fulfilment with a handover code.
--
--   confirmed -> ready_for_pickup -> completed   (customer collects)
--   confirmed -> shipped          -> completed   (delivered)
--
-- Completion requires a 6-character code the customer shows and the store
-- owner keys in. Only a bcrypt hash is stored: store owners have RLS read
-- access to their store's orders, so a plaintext code would let them mark
-- orders completed that never actually changed hands.

alter type order_status add value if not exists 'ready_for_pickup' after 'confirmed';
alter type order_status add value if not exists 'shipped'          after 'ready_for_pickup';
alter type order_status add value if not exists 'completed'        after 'shipped';

-- (columns, functions and the updated guard trigger follow in the
--  companion migrations; enum values must be committed before use)
