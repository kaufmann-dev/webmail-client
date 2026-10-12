-- Signatures are HTML now; existing plain-text signatures keep their line breaks.
UPDATE "mail_account" SET "signature" = '<div>' || replace(replace(replace(replace("signature", '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\n', '<br>') || '</div>' WHERE "signature" IS NOT NULL;
