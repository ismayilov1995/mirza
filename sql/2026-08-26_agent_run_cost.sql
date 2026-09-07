-- Gedişatın əsl hesabı: cost_usd.
--
-- Xərc indiyə qədər yalnız loga yazılırdı, bazada isə token sayları qalırdı.
-- Lentdəki "indi işlət" düyməsinin yanında keçən gedişatın qiymətini
-- göstərmək lazım oldu — tokendən geri hesablamaq isə yanlış rəqəm verir:
-- bir gedişatda Haiku da, Sonnet də çağırılır, hansının neçə token yediyi
-- sətirdə yoxdur. (Sonnet qiyməti ilə hesablayanda $0.16-lıq gedişat $0.38
-- görünürdü.) Rəqəmi gedişatın özü yazsın.
--
-- Yalnız katibe sxeminə yazır. Təkrar işlətmək təhlükəsizdir; köhnə sətirlərdə
-- NULL qalır və göstərici onları "hesab yoxdur" kimi qəbul edir.

ALTER TABLE katibe.agent_runs ADD COLUMN IF NOT EXISTS cost_usd numeric(10, 4);
