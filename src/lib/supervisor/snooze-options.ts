/*
 * Möhlətin müddət seçimləri — həm serverdə (ratings.ts), həm brauzerdə
 * (SnoozeFlagButton) lazımdır.
 *
 * Ayrı fayl olmasının səbəbi texnikidir və vacibdir: ratings.ts `pg` pool-unu
 * import edir, ona görə ondan bir sabit götürmək client komponentə bütün
 * verilənlər bazası qatını dartardı. Siyahının iki yerdə yazılması isə
 * daha pis olardı — server bir gün 5 günü qəbul edər, düymələr onu heç vaxt
 * göstərməz.
 */

/**
 * Dörd rəqəm, sərbəst xana yox: «neçə gün?» sualı boş qutu qarşısında qərara
 * çevrilmir, seçim qarşısında çevrilir. 1 = «sabah səhər bax», 2 = «həftəsonu
 * keçsin», 3 = «bu həftə», 7 = «gələn həftə».
 */
export const SNOOZE_DAY_OPTIONS = [1, 2, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAY_OPTIONS)[number];
