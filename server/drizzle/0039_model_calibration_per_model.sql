-- 0039_model_calibration_per_model
--
-- A calibration method can evaluate more than one model. The original key
-- omitted the model component, so the first model to claim a provider/speed/
-- rating slice prevented every later model from recording its own evidence.

set local role forma_migrator
--> statement-breakpoint
alter table analysis.model_calibration_slices
  drop constraint if exists model_calibration_slices_unique
--> statement-breakpoint
alter table analysis.model_calibration_slices
  add constraint model_calibration_slices_unique unique
    (calibration_component_version_id, model_component_version_id,
     provider, speed, rating_band_low)
--> statement-breakpoint
comment on constraint model_calibration_slices_unique on analysis.model_calibration_slices is
  'One measured slice per calibration method and model. Different model versions must retain distinct calibration evidence.'
