-- The verdict on a photo: which collection piece it is, or that it is not one.
--
-- WHY A SECOND STAGE AT ALL. The vector index alone cannot answer this. It was
-- measured: a screenshot of the company's own website matched its catalogue
-- item at 0.92 and was right, while a runway photo of somebody else's gown
-- matched at 0.89 and was wrong, and a collage screenshot matched at 0.84 and
-- was wrong. Three hundredths of cosine distance separate a correct answer
-- from a confident wrong one, because two different ivory lace gowns are
-- genuinely alike to CLIP — it is a near-duplicate detector here, not a
-- garment recogniser.
--
-- Acting on the score alone would therefore label bespoke work with a
-- catalogue code, which is worse than saying nothing: someone would believe
-- it. So a model that can see both the photo and the shortlist makes the call,
-- and `customized` is a first-class answer rather than a fallback.
ALTER TABLE katibe.message_image
  -- The collection code when the verdict is `catalog`, otherwise NULL.
  ADD COLUMN IF NOT EXISTS matched_code text REFERENCES katibe.catalog_item(code),
  -- catalog   : one of ours, matched_code says which
  -- customized: a dress, but not from the collection — bespoke or another house
  -- not_dress : no garment to match (paperwork, fabric, logistics, a collage)
  -- unsure    : the model declined to choose; left for a person
  ADD COLUMN IF NOT EXISTS verdict text
    CHECK (verdict IS NULL OR verdict IN ('catalog','customized','not_dress','unsure')),
  -- One short sentence, in Azerbaijani, for whoever reads the chat later.
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS verdict_model text,
  ADD COLUMN IF NOT EXISTS verdict_at timestamptz;

CREATE INDEX IF NOT EXISTS message_image_verdict_idx
  ON katibe.message_image (verdict, matched_code);
