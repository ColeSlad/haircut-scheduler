ALTER TABLE bookings ADD COLUMN payment_method TEXT
  CHECK(payment_method IN ('online', 'in_person'));
UPDATE bookings SET payment_method = 'online' WHERE checkout_params IS NOT NULL;
