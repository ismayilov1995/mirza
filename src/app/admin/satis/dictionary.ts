/*
 * Ekranın üç dili: AZ / RU / EN.
 *
 * NİYƏ STATİK LÜĞƏT, MODEL YOX. Sütun adı hər səhifə açılışında modeldən
 * keçməməlidir — pul, gecikmə və qeyri-sabitlik, üçü də lazımsız. Yalnız
 * AI-nin yazdığı faktlar tərcümə olunur (sales-insight.ts), çünki onlar hər
 * həftə dəyişir və əvvəlcədən yazıla bilməz.
 *
 * NİYƏ TİPLƏ BAĞLIDIR. `Dict` AZ variantından çıxarılır, ona görə RU və ya
 * EN-də unudulan açar RUNTIME-da boş mətn yox, KOMPİLYASİYA XƏTASI verir.
 * Yarımçıq tərcümə ilə yaşayan ekran ən pis haldır: nə işləyir, nə də
 * pozulduğu görünür.
 *
 * Türk və ərəb dili burada yoxdur (söhbət tərcüməsində var) — seçicidə
 * lüğəti olmayan dili göstərmək boş vəddir.
 */

export const SALES_LANGS = { az: "AZ", ru: "RU", en: "EN" } as const;
export type SalesLang = keyof typeof SALES_LANGS;

export function isSalesLang(v: unknown): v is SalesLang {
  return typeof v === "string" && v in SALES_LANGS;
}

const az = {
  section: "Admin",
  title: "Satıcılar",
  subtitle: (d: number) => `Cavab sürəti və cavabsızlıq · son ${d} gün · müştəri yazışmaları`,
  window: (d: number) => `${d} gün`,
  loadingTitle: "Statistika hesablanır…",
  loadingBody: (d: number) =>
    `Son ${d} günün yazışmaları hər dəfə yenidən ölçülür — heç bir rəqəm saxlanmır, ona görə də köhnəlmir.`,
  emptyTitle: "Bu aralıqda ölçüləcək yazışma yoxdur",
  emptyBody: (d: number) =>
    `Son ${d} gündə heç bir satıcının müştəri yazışması qeydə alınmayıb. Pəncərəni genişləndirin, ya da instans təyinatlarını yoxlayın.`,
  emptyAction: "90 günə bax",

  compare: "Müqayisə",
  compareHint: (d: number) => `son ${d} gün · müştəri yazışmaları · fərqlər komanda medianına görə`,
  colSales: "Satıcı",
  colOpportunities: "Cavab borcu",
  colFrt: "İlk cavab",
  colArt: "Cavab arası",
  colP90: "Ən yavaş 10%",
  colUnanswered: "Cavabsız qalan",
  colSla: "Hədəfi keçən",
  colUncovered: "Hədəfsiz",
  subOpportunities: "müştəri gözləyir",
  subFrt: "müştəri yazandan ilk cavaba (FRT)",
  subArt: "söhbətin içində hər cavab (ART)",
  subP90: "hər 10 cavabdan biri bundan da gec",
  subUnanswered: "24 saat ərzində cavab getməyib",
  subSla: "SLA hədəfinə çatmayanlar",
  subUncovered: "SLA qaydası olmayan",
  none: "yoxdur",
  noInstance: "Nömrə təyin olunmayıb",
  noInstanceHelp: "Admin səhifəsindən instans bağlana bilər.",
  uncoveredTitle:
    "Bu gözləmələr üçün həmin an qüvvədə olan SLA qaydası yoxdur, ona görə hədəf faizinin məxrəcinə girmirlər.",
  teamSame: "= komanda medianı",
  teamSameTitle: (label: string) => `${label}: komanda medianı ilə eyni`,
  teamDiffTitle: (label: string, size: string, worse: boolean) =>
    `${label}: komanda medianından ${size} ${worse ? "yuxarı" : "aşağı"}`,
  points: (n: string) => `${n} bənd`,

  glossary: "Bu rəqəmlər nə deməkdir?",
  glossaryItems: [
    ["Cavab borcu", "Müştəri yazıb və cavab bizdən gözlənilir. Ardıcıl beş mesaj bir borcdur, beş yox."],
    ["İlk cavab", "Müştəri yazandan bizim ilk cavabımıza qədər. Nümunə: 14:00-da yazdı, 14:08-də cavab getdi → 8 dəqiqə."],
    ["Cavab arası", "Söhbət başlayandan sonra hər cavabın gecikməsi. İlk cavab tez, sonrakılar gec ola bilər — bu sütun onu göstərir."],
    ["Ən yavaş 10%", "Cavabların ən gec gedən onda biri. Median yaxşı görünəndə də bu sütun pis ola bilər."],
    ["Cavabsız qalan", "24 saat ərzində heç bir cavab getməyib. Hələ də gözləyirsə, vaxt indiyə qədər sayılır."],
    ["Hədəfi keçən", "SLA qaydasının verdiyi vaxta çatmayan cavablar. Hədəf mesajın gəldiyi ana görə seçilir: iş saatı, iş saatından kənar, həftə sonu."],
    ["Hədəfsiz", "Həmin anda qüvvədə SLA qaydası olmayan gözləmələr. Onlar faizin məxrəcində sayılmır — yoxsa qayda təyin olunmamış dövr yaxşı nəticə kimi görünərdi."],
  ] as [string, string][],

  hourly: "Gün × saat",
  hourlySpeed: (d: number) => `müştəri mesajının gəldiyi saata görə cavab vaxtı · son ${d} gün`,
  hourlyVolume: (d: number) => `yazılan cavabların sayı · son ${d} gün`,
  modeSpeed: "Sürət",
  modeVolume: "Həcm",
  everyone: "Hamısı",
  scale: "Şkala:",
  slower: "daha yavaş",
  thinCell: (n: number) => `zolaqlı xana = ${n} gözləmədən az, rənglənmir`,
  darkest: (n: number) => `ən tünd xana = ${n} cavab`,
  days: ["B.e", "Ç.a", "Ç", "C.a", "C", "Şən", "Baz"],
  hourlyNote:
    "Saat və gün Asia/Baku zonasındadır. Sürət rejimində xana müştəri mesajının GƏLDİYİ saata yazılır — cavabın yazıldığı saata yox, yoxsa gecə gələn və səhər cavablanan mesaj səhərin rəqəmini korlayardı.",
  hourlyAvgNote:
    " Bir neçə satıcı seçiləndə xanada gözləmə sayına görə çəkilmiş orta göstərilir, median yox — medianlar toplana bilmir.",

  dayType: "Gün növünə görə",
  dayTypeHint: "müştəri mesajının gəldiyi günə görə · Asia/Baku",
  week: "İş günləri",
  weekHint: "B.e–Cümə",
  sat: "Şənbə",
  sun: "Bazar",
  slaWeekend: "SLA-da həftə sonu",
  colMedianReply: "Median cavab",
  dayTypeNote:
    "Median cavab cavablanmış gözləmələrin medianıdır — cavabsız qalanlar bura girmir, onlar yanındakı sütundadır. Şənbə SLA qaydasında həftə sonu sayılır (hədəf 180 dəq), ona görə şənbənin hədəf rəqəmi daha yumşaqdır; cavabsızlıq isə hər üç sütunda eyni qayda ilə (24 saat) ölçülür.",

  insights: "Nə görünür",
  insightsHint: (a: string, b: string) => `${a} — ${b} həftəsi · rəqəmlər koddan, cümlə modeldən`,
  insightsEmpty: "Hələ fakt yazılmayıb",
  insightsEmptyBody:
    "Faktlar həftədə bir dəfə, bazar ertəsi yazılır. «Yenilə» düyməsi ilə indi də işlədilə bilər.",
  refresh: "Yenilə",
  better: "yaxşılaşıb",
  worse: "pisləşib",
  flat: "dəyişməyib",
  fresh: "ilk dəfə",
  basis: "nədən çıxdı",
};

type Dict = typeof az;

const ru: Dict = {
  section: "Админ",
  title: "Продавцы",
  subtitle: (d) => `Скорость ответа и пропуски · последние ${d} дн. · переписка с клиентами`,
  window: (d) => `${d} дн.`,
  loadingTitle: "Считаем статистику…",
  loadingBody: (d) =>
    `Переписка за последние ${d} дней пересчитывается каждый раз — ничего не хранится, поэтому не устаревает.`,
  emptyTitle: "За этот период нечего измерять",
  emptyBody: (d) =>
    `За последние ${d} дней ни у одного продавца нет клиентской переписки. Расширьте период или проверьте привязку номеров.`,
  emptyAction: "Показать 90 дней",

  compare: "Сравнение",
  compareHint: (d) => `последние ${d} дн. · переписка с клиентами · отклонение от медианы команды`,
  colSales: "Продавец",
  colOpportunities: "Ждут ответа",
  colFrt: "Первый ответ",
  colArt: "Между ответами",
  colP90: "Самые медленные 10%",
  colUnanswered: "Без ответа",
  colSla: "Просрочено",
  colUncovered: "Без норматива",
  subOpportunities: "клиент ждёт",
  subFrt: "от сообщения клиента до первого ответа (FRT)",
  subArt: "каждый ответ внутри диалога (ART)",
  subP90: "каждый десятый ответ ещё медленнее",
  subUnanswered: "за 24 часа ответа не было",
  subSla: "не уложились в норматив SLA",
  subUncovered: "правило SLA не действовало",
  none: "нет",
  noInstance: "Номер не назначен",
  noInstanceHelp: "Привязать номер можно на странице администратора.",
  uncoveredTitle:
    "На тот момент не действовало ни одно правило SLA, поэтому эти ожидания не входят в знаменатель.",
  teamSame: "= медиана команды",
  teamSameTitle: (label) => `${label}: как медиана команды`,
  teamDiffTitle: (label, size, worse) =>
    `${label}: ${worse ? "выше" : "ниже"} медианы команды на ${size}`,
  points: (n) => `${n} п.п.`,

  glossary: "Что означают эти цифры?",
  glossaryItems: [
    ["Ждут ответа", "Клиент написал, ответ за нами. Пять сообщений подряд — это один долг, а не пять."],
    ["Первый ответ", "От сообщения клиента до нашего первого ответа. Пример: написал в 14:00, ответ ушёл в 14:08 → 8 минут."],
    ["Между ответами", "Задержка каждого ответа после начала диалога. Первый ответ может быть быстрым, а последующие — нет; этот столбец про них."],
    ["Самые медленные 10%", "Десятая часть самых поздних ответов. Медиана может выглядеть хорошо, а этот столбец — плохо."],
    ["Без ответа", "За 24 часа не ушло ни одного ответа. Если ждут до сих пор, время считается до сейчас."],
    ["Просрочено", "Ответы, не уложившиеся в норматив SLA. Норматив выбирается по моменту прихода сообщения: рабочее время, нерабочее, выходной."],
    ["Без норматива", "Ожидания, для которых в тот момент не действовало правило SLA. В знаменатель они не входят — иначе период без правила выглядел бы хорошим результатом."],
  ],

  hourly: "День × час",
  hourlySpeed: (d) => `время ответа по часу прихода сообщения · последние ${d} дн.`,
  hourlyVolume: (d) => `количество отправленных ответов · последние ${d} дн.`,
  modeSpeed: "Скорость",
  modeVolume: "Объём",
  everyone: "Все",
  scale: "Шкала:",
  slower: "медленнее",
  thinCell: (n) => `штриховка = меньше ${n} ожиданий, не окрашивается`,
  darkest: (n) => `самая тёмная ячейка = ${n} ответов`,
  days: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
  hourlyNote:
    "Часы и дни — в зоне Asia/Baku. В режиме скорости ячейка относится к часу, когда сообщение ПРИШЛО, а не когда был написан ответ: иначе ночное сообщение, отвеченное утром, портило бы утренние цифры.",
  hourlyAvgNote:
    " Когда выбрано несколько продавцов, в ячейке показано среднее, взвешенное по числу ожиданий, а не медиана — медианы не складываются.",

  dayType: "По типу дня",
  dayTypeHint: "по дню прихода сообщения клиента · Asia/Baku",
  week: "Будни",
  weekHint: "Пн–Пт",
  sat: "Суббота",
  sun: "Воскресенье",
  slaWeekend: "в SLA — выходной",
  colMedianReply: "Медианный ответ",
  dayTypeNote:
    "Медианный ответ считается только по отвеченным ожиданиям — оставшиеся без ответа в соседнем столбце. Суббота в правиле SLA считается выходным (норматив 180 мин), поэтому её показатель мягче; а «без ответа» во всех трёх столбцах измеряется одинаково (24 часа).",

  insights: "Что видно",
  insightsHint: (a, b) => `неделя ${a} — ${b} · цифры из кода, формулировка от модели`,
  insightsEmpty: "Выводы ещё не записаны",
  insightsEmptyBody:
    "Выводы формируются раз в неделю, по понедельникам. Кнопка «Обновить» запускает их сейчас.",
  refresh: "Обновить",
  better: "улучшилось",
  worse: "ухудшилось",
  flat: "без изменений",
  fresh: "впервые",
  basis: "на основании",
};

const en: Dict = {
  section: "Admin",
  title: "Salespeople",
  subtitle: (d) => `Reply speed and misses · last ${d} days · customer conversations`,
  window: (d) => `${d} days`,
  loadingTitle: "Calculating…",
  loadingBody: (d) =>
    `The last ${d} days are measured from scratch every time — nothing is stored, so nothing goes stale.`,
  emptyTitle: "Nothing to measure in this window",
  emptyBody: (d) =>
    `No salesperson has customer conversations in the last ${d} days. Widen the window, or check the number assignments.`,
  emptyAction: "Show 90 days",

  compare: "Comparison",
  compareHint: (d) => `last ${d} days · customer conversations · differences against the team median`,
  colSales: "Salesperson",
  colOpportunities: "Awaiting reply",
  colFrt: "First reply",
  colArt: "Between replies",
  colP90: "Slowest 10%",
  colUnanswered: "Left unanswered",
  colSla: "Missed target",
  colUncovered: "No target",
  subOpportunities: "customer is waiting",
  subFrt: "customer message to our first reply (FRT)",
  subArt: "each reply inside the conversation (ART)",
  subP90: "one reply in ten is slower than this",
  subUnanswered: "no reply within 24 hours",
  subSla: "did not meet the SLA target",
  subUncovered: "no SLA rule in force",
  none: "none",
  noInstance: "No number assigned",
  noInstanceHelp: "A number can be attached from the admin page.",
  uncoveredTitle:
    "No SLA rule was in force at that moment, so these waits are not in the denominator.",
  teamSame: "= team median",
  teamSameTitle: (label) => `${label}: same as the team median`,
  teamDiffTitle: (label, size, worse) =>
    `${label}: ${size} ${worse ? "above" : "below"} the team median`,
  points: (n) => `${n} pp`,

  glossary: "What do these numbers mean?",
  glossaryItems: [
    ["Awaiting reply", "The customer wrote and the reply is owed by us. Five messages in a row are one debt, not five."],
    ["First reply", "From the customer's message to our first reply. Example: they wrote at 14:00, the reply went out at 14:08 → 8 minutes."],
    ["Between replies", "The delay on every reply once the conversation is running. The first reply can be fast and the rest slow; this column is about the rest."],
    ["Slowest 10%", "The latest tenth of all replies. The median can look fine while this column does not."],
    ["Left unanswered", "No reply went out within 24 hours. If they are still waiting, the clock runs to now."],
    ["Missed target", "Replies that did not meet the SLA target. The target is chosen by when the message arrived: business hours, after hours, weekend."],
    ["No target", "Waits with no SLA rule in force at that moment. They stay out of the denominator — otherwise a period with no rule would look like a good result."],
  ],

  hourly: "Day × hour",
  hourlySpeed: (d) => `reply time by the hour the message arrived · last ${d} days`,
  hourlyVolume: (d) => `number of replies sent · last ${d} days`,
  modeSpeed: "Speed",
  modeVolume: "Volume",
  everyone: "Everyone",
  scale: "Scale:",
  slower: "slower",
  thinCell: (n) => `hatched cell = fewer than ${n} waits, left uncoloured`,
  darkest: (n) => `darkest cell = ${n} replies`,
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  hourlyNote:
    "Hours and days are in Asia/Baku. In speed mode a cell belongs to the hour the message ARRIVED, not the hour the reply was written — otherwise a message that came at night and was answered in the morning would spoil the morning's figure.",
  hourlyAvgNote:
    " With several salespeople selected the cell shows an average weighted by waits, not a median — medians do not add up.",

  dayType: "By type of day",
  dayTypeHint: "by the day the customer's message arrived · Asia/Baku",
  week: "Weekdays",
  weekHint: "Mon–Fri",
  sat: "Saturday",
  sun: "Sunday",
  slaWeekend: "weekend under SLA",
  colMedianReply: "Median reply",
  dayTypeNote:
    "The median reply covers answered waits only — the unanswered ones are in the column beside it. Saturday counts as a weekend in the SLA rule (180 min target), so its target figure is the lenient one; the unanswered share is measured the same way (24 hours) in all three columns.",

  insights: "What stands out",
  insightsHint: (a, b) => `week of ${a} — ${b} · numbers from code, wording from the model`,
  insightsEmpty: "No findings written yet",
  insightsEmptyBody:
    "Findings are written once a week, on Monday. The Refresh button runs them now.",
  refresh: "Refresh",
  better: "improved",
  worse: "got worse",
  flat: "unchanged",
  fresh: "first time",
  basis: "based on",
};

const DICTS: Record<SalesLang, Dict> = { az, ru, en };

export function dict(lang: SalesLang): Dict {
  return DICTS[lang];
}
