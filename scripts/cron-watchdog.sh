#!/bin/bash
#
# Cron işlərinin SAKİTCƏ DAYANMADIĞINI yoxlayır.
#
# Niyə var: 2026-09-06-da mirror-evolution.ts sonsuz döngəyə düşdü, cron isə onu
# hər 5 dəqiqədən bir yenidən açdı — kilid yox idi. 4 saatda 243 proses yığıldı,
# 2 nüvəli maşında load average 37-yə qalxdı, swap doldu və bütün panel dayandı.
# Həmin gün hər cron sətrinə `flock -n` qoyuldu.
#
# ANCAQ FLOCK PROBLEMİ YOX, SƏSİNİ DƏYİŞİR. Əvvəl asılıb qalan skript prosesləri
# yığır və serveri çökdürürdü — yəni dərhal bilinirdi. İndi asılan skript öz
# kilidini tutub saxlayır, hər növbəti təkan sakitcə buraxılır: server sağlamdır,
# panel sürətlidir, amma O İŞ ARTIQ GÖRÜLMÜR və heç nə bunu demir. Bu skript məhz
# o sükutu tutur.
#
# İKİ NÖV NASAZLIQ AXTARILIR:
#
#   İLİŞİB   — kilid canlı prosesin əlindədir və o proses cədvəl periodunun
#              iki mislindən çoxdur işləyir. Bu, «asılıb qalıb» deməkdir:
#              period 5 dəqiqədirsə, 10 dəqiqədən uzun gediş normal deyil.
#              Kilid tutulu qaldıqca hər növbəti təkan buraxılır, yəni bu
#              yoxlama həm də «sakitcə buraxılır» halını tutur.
#   İŞLƏMİR  — cron sətri ÜMUMİYYƏTLƏ işə düşməyib (crontab pozulub, sətir
#              silinib, cədvəl səhvdir).
#
# «İŞLƏDİMİ» SUALINA LOG YOX, SYSLOG CAVAB VERİR. Əvvəlcə crontab-dakı `>>`
# faylının vaxt damğasına baxırdı — və dərhal yalan siqnal verdi:
# daily_report.sh uğurlu gedişdə stdout-a heç nə yazmır, öz hesabatını
# logs/<tarix>.log faylına yazır, ona görə cron.log 13 gün toxunulmamış qalır
# HALBUKİ iş hər gün 05:00-da işləyir. Log faylı skriptin nə yazmağı seçdiyindən
# asılıdır; syslog isə cron-un öz qeydidir və bütün işlər üçün eyni formadadır:
#   CRON[789051]: (root) CMD (… flock -n /var/lock/katibe-mirror.lock …)
# Yalan siqnal verən gözətçiyə baxmağı dayandırırlar — bu, gözətçinin olmamasından
# da pisdir, çünki qorunduğunu düşünürsən.
#
# KONFİQURASİYA YOXDUR — HƏR ŞEY CRONTAB-DAN OXUNUR. Burada işlərin ikinci
# siyahısını saxlamaq ən adi səhv olardı: crontab dəyişəndə siyahı köhnəlir və
# gözətçi artıq mövcud olmayan işi gözləyər, yeni işi isə heç görməz
# (docs/rules.md §8). Ona görə kilid faylı və cədvəl elə `crontab -l` sətrinin
# özündən çıxarılır: yeni cron sətri əlavə edən kimi avtomatik nəzarətə düşür,
# silinən sətir isə özü-özünə nəzarətdən çıxır.
#
# Əl ilə:  bash scripts/cron-watchdog.sh
#   WATCHDOG_VERBOSE=1   qaydasında olan işləri də yaz
#
# Çıxış kodu: problem varsa 1, yoxsa 0.

set -uo pipefail

LOG=/var/www/katibe-dashboard/logs/watchdog.log
STATE=/var/www/katibe-dashboard/logs/watchdog-state.json
VERBOSE="${WATCHDOG_VERBOSE:-0}"
NOW_H="$(date '+%Y-%m-%d %H:%M:%S')"

problems=()
ok_jobs=()

# Cədvəlin təxmini periodu, DƏQİQƏ ilə.
#
# Dəqiq növbəti-təkan hesablaması lazım deyil: bizə yalnız «bu iş nə qədər tez-tez
# olmalıdır» lazımdır. Saat sahəsi ulduz deyilsə (məsələn `*/15 4-18`), gecə
# boşluğu var — onda köhnəlik həddi üçün period sutka sayılır, yoxsa hər səhər
# yalan xəbərdarlıq verərdi. İLİŞİB yoxlaması bundan asılı deyil: o, canlı
# prosesin yaşını ölçür.
period_minutes() {
  local min="$1" hour="$2" dom="$3" mon="$4" dow="$5"
  if [[ "$min" == \*/* ]]; then
    echo "${min#*/}"
  elif [[ "$min" == "*" ]]; then
    echo 1
  elif [[ "$hour" == "*" ]]; then
    echo 60
  elif [[ "$dow" != "*" || "$dom" != "*" || "$mon" != "*" ]]; then
    echo 10080   # həftəlik və ya daha seyrək
  else
    echo 1440    # gündəlik
  fi
}

# Log köhnəliyi üçün hədd: gecə boşluğu olan cədvəllərdə period sutkadır.
staleness_limit() {
  local period="$1" hour="$2"
  if [[ "$hour" != "*" && "$period" -lt 1440 ]]; then
    echo 1440
  else
    echo "$period"
  fi
}

human_age() {
  local s="$1"
  if   [ "$s" -lt 3600 ];   then echo "$((s / 60)) dəqiqə"
  elif [ "$s" -lt 86400 ];  then echo "$((s / 3600)) saat"
  else echo "$((s / 86400)) gün"
  fi
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

while IFS= read -r line; do
  # Yalnız kilidli sətirlər. Kilidsiz sətir varsa, o onsuz da bu gözətçinin
  # qoruduğu problemə düşə bilməz — amma qeyd edilir ki, gözdən qaçmasın.
  case "$line" in
    \#*|"") continue ;;
  esac
  if [[ "$line" != *"flock -n /var/lock/"* ]]; then
    problems+=("KİLİDSİZ|$(printf '%s' "$line" | cut -c1-60)|cron sətrində flock yoxdur — üst-üstə yığıla bilər")
    continue
  fi

  read -r c_min c_hour c_dom c_mon c_dow _rest <<<"$line"

  lock="/var/lock/$(printf '%s' "$line" | sed -n 's#.*flock -n /var/lock/\([A-Za-z0-9._-]*\).*#\1#p')"
  # İşin adı: skript faylının adı, yoxsa kilidin adı.
  job="$(printf '%s' "$line" | sed -n 's#.*/\([A-Za-z0-9._-]*\.\(ts\|sh\)\).*#\1#p')"
  [ -n "$job" ] || job="$(basename "$lock" .lock)"

  period="$(period_minutes "$c_min" "$c_hour" "$c_dom" "$c_mon" "$c_dow")"
  limit="$(staleness_limit "$period" "$c_hour")"

  # --- İLİŞİB? Kilid tutulubsa, tutan prosesin yaşına bax. ---

  if [ -e "$lock" ] && ! flock -n "$lock" -c true 2>/dev/null; then

    holder="$(fuser "$lock" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1)"
    if [ -n "${holder:-}" ]; then
      age="$(ps -o etimes= -p "$holder" 2>/dev/null | tr -d ' ')"
      if [ -n "${age:-}" ] && [ "$age" -gt $((period * 60 * 2)) ]; then
        problems+=("İLİŞİB|$job|kilidi $(human_age "$age") tutub (pid $holder), period ${period} dəqiqə")
        continue
      fi
    fi
  fi

  # --- İŞLƏMİR? Cron bu sətri sonuncu dəfə nə vaxt işə salıb? ---
  #
  # SKRİPTİN ADI İLƏ axtarılır, kilidin adı ilə YOX.
  #
  # Kilid adı ilk yazılışda açar seçilmişdi və dərhal 9 yalan siqnal verdi:
  # kilidlər 16:48-də əlavə olunmuşdu, ona görə hələ işə düşməmiş işlərin
  # syslog qeydlərində o ad ümumiyyətlə yox idi. Ümumi qayda budur — crontab
  # sətrində NƏ dəyişsə (kilid adı, yol, env dəyişəni), o mətnə bağlı açar
  # bütün işləri «pozulub» göstərir. Skriptin faylı isə sətir dəyişəndə də
  # yerində qalır.
  #
  # Əvvəl cari syslog, tapılmasa dünənki: cron gündəlik fırlanır, yəni ikisi
  # birlikdə ~2 sutkadır.
  last_run=""
  for sl in /var/log/syslog /var/log/syslog.1; do
    [ -r "$sl" ] || continue
    last_run="$(grep -F "$job" "$sl" 2>/dev/null | grep -F 'CMD (' | tail -1 | cut -d' ' -f1)"
    [ -n "$last_run" ] && break
  done

  if [ -n "$last_run" ]; then
    last_epoch="$(date -d "$last_run" +%s 2>/dev/null)"
    if [ -n "${last_epoch:-}" ]; then
      age=$(( $(date +%s) - last_epoch ))
      if [ "$age" -gt $((limit * 60 * 2)) ]; then
        problems+=("İŞLƏMİR|$job|cron $(human_age "$age") işə salmayıb, gözlənilən aralıq ${limit} dəqiqə")
        continue
      fi
    fi
  elif [ "$limit" -le 1440 ]; then
    # HEÇ VAXT GÖRÜNMƏYİB ≠ DAYANIB. Ayrı ad qəsdəndir.
    #
    # Cron sətri işə salanda CMD qeydini HƏMİŞƏ yazır — əmr uğursuz olsa da.
    # Deməli qeydin ümumiyyətlə olmaması «sətir hələ növbəsinə çatmayıb»
    # deməkdir; sətrin özü isə buradadır, çünki crontab-dan oxunub. Yəni bu,
    # demək olar həmişə YENİ ƏLAVƏ EDİLMİŞ işdir.
    #
    # Bunu «İŞLƏMİR» adlandırmaq üçüncü yalan siqnal olardı: gözətçinin özü
    # cron-a əlavə ediləndə dərhal özünü «pozulub» kimi göstərdi. Yeni sətir
    # ilk dəfə işləyənə qədər belə görünür — bu, xəbərdarlıq deyil, qeyddir.
    # Əgər bir neçə saatdan sonra da qalırsa, ONDA həqiqi problemdir.
    problems+=("İŞLƏMƏYİB|$job|hələ bir dəfə də işə düşməyib — yeni əlavə olunubsa normaldır, qalırsa cədvəli yoxla")
    continue
  fi
  # Həftəlik iş üçün qeyd tapılmaması nəticə deyil — syslog o qədər saxlanmır.

  ok_jobs+=("$job")
done < <(crontab -l 2>/dev/null)

# --- Nəticə ---
{
  if [ "${#problems[@]}" -eq 0 ]; then
    if [ "$VERBOSE" = "1" ]; then
      echo "[$NOW_H] qaydasındadır — ${#ok_jobs[@]} iş: ${ok_jobs[*]}"
    else
      echo "[$NOW_H] qaydasındadır — ${#ok_jobs[@]} iş yoxlanıldı."
    fi
  else
    echo "[$NOW_H] ${#problems[@]} PROBLEM (${#ok_jobs[@]} iş qaydasında):"
    for p in "${problems[@]}"; do
      IFS='|' read -r kind name detail <<<"$p"
      printf '  %-9s %-28s %s\n' "$kind" "$name" "$detail"
    done
  fi
} >> "$LOG"

# Maşın üçün oxunan vəziyyət — panelə və ya başqa yoxlamaya bağlamaq üçün.
{
  printf '{"checked_at":"%s","ok_count":%d,"problem_count":%d,"problems":[' \
    "$(date -Is)" "${#ok_jobs[@]}" "${#problems[@]}"
  first=1
  for p in "${problems[@]:-}"; do
    [ -n "$p" ] || continue
    IFS='|' read -r kind name detail <<<"$p"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"kind":"%s","job":"%s","detail":"%s"}' \
      "$(json_escape "$kind")" "$(json_escape "$name")" "$(json_escape "$detail")"
  done
  printf ']}\n'
} > "$STATE"

if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do
    IFS='|' read -r kind name detail <<<"$p"
    printf '%-9s %-28s %s\n' "$kind" "$name" "$detail"
  done
  exit 1
fi

[ "$VERBOSE" = "1" ] && echo "qaydasındadır — ${#ok_jobs[@]} iş: ${ok_jobs[*]}"
exit 0
