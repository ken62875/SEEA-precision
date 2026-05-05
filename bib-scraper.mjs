/**
 * KSF (대한사격연맹) 사대번호 스크래퍼
 * 출처: https://www.shooting.or.kr/score/score_2015_game.asp?jname=N01H
 *
 * 실제 컬럼 순서 (score_2015_player.asp):
 *   사대번호(X-Y) | 단체여부 | 소속 | 이름
 */

const KSF_BASE = 'https://www.shooting.or.kr';
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Referer':    'https://www.shooting.or.kr',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// ── HTML fetch (EUC-KR 우선 처리) ─────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

  const buf = await res.arrayBuffer();

  const ct      = res.headers.get('content-type') || '';
  let   charset = (ct.match(/charset=([^\s;]+)/i) || [])[1] || '';

  if (!charset) {
    try {
      const latin = Buffer.from(buf).toString('latin1');
      const metaM = latin.match(/charset=["']?([a-zA-Z0-9_-]+)/i);
      if (metaM) charset = metaM[1];
    } catch { /* */ }
  }
  if (!charset) charset = 'euc-kr';
  charset = charset.toLowerCase().replace('ks_c_5601-1987', 'euc-kr');

  let html = '';
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    html = Buffer.from(buf).toString('binary');
  }
  return html;
}

// ── HTML에서 텍스트만 추출 ──────────────────────────────
function stripTags(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ' ')  // <br> → 공백 (없애면 "12:153조" 같은 연결 발생)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&#\d+;/g,  '')
    .replace(/\s+/g,     ' ')
    .trim();
}

// ── URL 파라미터 → 이벤트 라벨 (게임페이지 추출 실패 시 폴백) ──
function generateLabel(href) {
  const qs  = href.includes('?') ? href.split('?')[1] : '';
  const p   = new URLSearchParams(qs);
  const sex = p.get('sex') || '';
  const bb  = p.get('bb')  || '';
  const i1  = p.get('i1')  || '';

  const sexLabel = sex === '2' ? '여자' : '남자';
  const bbMap = {
    '1':'초등부','2':'중등부','3':'고등부',
    '4':'대학부','5':'일반부','6':'중급부','7':'초급부',
  };
  const bbLabel = bbMap[bb] || (bb ? `bb${bb}` : '');

  // KSF 공식 종목명 (괄호 없이)
  const i1Map = {
    '11':'10m 공기소총','12':'10m 공기권총',
    '13':'50m 소총 3자세','14':'50m 소총 복사','15':'50m 소총 3자세',
    '21':'50m 소총 복사','22':'50m 소총 복사',
    '23':'10m 공기소총',
    '24':'50m 소총 복사','25':'50m 소총 3자세',
    '26':'25m 권총','27':'25m 스포츠 권총',
    '31':'트랩','32':'스키트','33':'더블트랩',
    '41':'10m 공기소총 장애인','42':'10m 공기권총 장애인',
    '81':'10m 공기소총','82':'10m 공기권총',
  };
  const i1Label = i1Map[i1] || `종목${i1}`;
  return [i1Label, sexLabel, bbLabel].filter(Boolean).join(' ');
}

// ── 날짜 문자열 정규화 + 요일 포함 ──────────────────────────
const DOW_KR = ['일','월','화','수','목','금','토'];

function normalizeDate(raw, year) {
  const m = raw.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) return '';
  const month = parseInt(m[1]);
  const day   = parseInt(m[2]);
  if (!month || !day || month > 12 || day > 31) return '';
  if (year) {
    const d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return '';
    return `${month}월 ${day}일 (${DOW_KR[d.getDay()]})`;
  }
  return `${month}월 ${day}일`;
}

// ── 게임 페이지에서 이벤트 목록 + 일정 추출 ─────────────
// 행(TR) 기반: 각 <tr>에 종목명·시간·선수URL이 함께 있으므로 같은 행 텍스트를 사용
function parseGameLinks(html) {
  const seen = new Set();
  const results = [];

  // 연도 추출 (요일 계산용) — ISO 날짜 형식에서 추출
  const yearM    = html.match(/\b(20\d{2})[.\-]\d{1,2}[.\-]\d{1,2}/);
  const compYear = yearM ? parseInt(yearM[1]) : new Date().getFullYear();

  // 날짜 위치 수집 (한국어 "N월N일" 형식만 — 아코디언 헤더의 정확한 날짜)
  const dateHits = [];
  for (const m of html.matchAll(/\d{1,2}월\s*\d{1,2}일/g)) {
    const text = normalizeDate(m[0], compYear);
    if (text) dateHits.push({ pos: m.index, text });
  }

  // 선수 URL이 포함된 <tr> 행 단위로 파싱
  for (const rowM of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowM[1];
    if (!rowHtml.includes('score_2015_player.asp')) continue;

    // 행 전체 텍스트 (태그 제거)
    const rowText = stripTags(rowHtml).replace(/\s+/g, ' ').trim();

    // "출전자정보" 앞 부분 = 종목 정보 영역
    const infoText = rowText.split(/출전자\s*정보/)[0].trim();

    // 시작 시간: 전반/후반이 있으면 각 시작 시간, 조별 시간이 있으면 조별 맵, 없으면 첫 번째 시간
    let scheduleTime = '';
    const scheduleTimes = {};  // 조번호 → 시작 시간 (또는 "전반 HH:MM / 후반 HH:MM")
    if (/전반|후반/.test(infoText)) {
      // "전반 1조 09:00 2조 10:00 후반 1조 11:00 2조 11:30" 형태 처리
      // 전반/후반 섹션을 분리해서 각각의 N조 시간 추출
      const jePart = infoText.match(/전반([\s\S]*?)(?=후반|$)/)?.[1] || '';
      const huPart = infoText.match(/후반([\s\S]*?)$/)?.[1] || '';
      const jeTimes = {}, huTimes = {};
      for (const m of jePart.matchAll(/(\d+)\s*조\s*(\d{1,2}:\d{2})/g)) jeTimes[m[1]] = m[2];
      for (const m of huPart.matchAll(/(\d+)\s*조\s*(\d{1,2}:\d{2})/g)) huTimes[m[1]] = m[2];
      const joNums = [...new Set([...Object.keys(jeTimes), ...Object.keys(huTimes)])];
      if (joNums.length > 1) {
        for (const jo of joNums) {
          const je = jeTimes[jo], hu = huTimes[jo];
          if (je && hu) scheduleTimes[jo] = `전반 ${je} / 후반 ${hu}`;
          else if (je)  scheduleTimes[jo] = `전반 ${je}`;
          else if (hu)  scheduleTimes[jo] = `후반 ${hu}`;
        }
      }
      // 폴백: 가장 낮은 조번호(또는 전체) 시간
      const joSorted = joNums.sort((a, b) => +a - +b);
      const jo1 = joSorted[0];
      const jeFirst = jeTimes[jo1], huFirst = huTimes[jo1];
      if (jeFirst && huFirst) scheduleTime = `전반 ${jeFirst} / 후반 ${huFirst}`;
      else {
        const jeM = infoText.match(/전반\S*\s*(\d{1,2}:\d{2})/);
        const huM = infoText.match(/후반\S*\s*(\d{1,2}:\d{2})/);
        if (jeM && huM)    scheduleTime = `전반 ${jeM[1]} / 후반 ${huM[1]}`;
        else if (jeM)      scheduleTime = `전반 ${jeM[1]}`;
        else if (huM)      scheduleTime = `후반 ${huM[1]}`;
      }
    } else {
      // N조 HH:MM 패턴 추출 (예: "1조 09:00~10:15 2조 11:00~12:15")
      for (const m of infoText.matchAll(/(\d+)\s*조\s*(\d{1,2}:\d{2})/g)) {
        scheduleTimes[m[1]] = m[2];
      }
      const timeM = infoText.match(/(\d{1,2}:\d{2})/);
      scheduleTime = timeM ? timeM[1] : '';
    }

    // 종목명: infoText에서 불필요한 요소 제거
    let eventLabel = infoText
      .replace(/\d{1,2}:\d{2}(?:[-~]\d{1,2}:\d{2})?/g, '') // 시간 범위 제거
      .replace(/(?:전반|후반)\s*\d*\s*조?/g, '')              // 전반[N조], 후반[N조] — 공백 포함 모두 제거
      .replace(/\d+조/g, '')                                  // 나머지 N조 제거
      .replace(/산탄총\s*/g, '')                               // 산탄총 접두어 제거
      .replace(/(\d+)M\b/g, '$1m')                           // 50M → 50m 정규화
      .replace(/(\d+m)\s+\1/g, '$1')                         // 50m 50m → 50m 중복 제거
      .replace(/\s+/g, ' ').trim();

    if (eventLabel.length < 3) eventLabel = '';

    // 행 내 personUrl, groupUrl 추출 (행당 하나씩)
    const personRaw = rowHtml.match(/["']([^"']*score_2015_person[^"']*\.asp\?[^"']+)["']/);
    let personUrl = '';
    if (personRaw) {
      personUrl = personRaw[1];
      if (!personUrl.startsWith('http')) personUrl = `${KSF_BASE}${personUrl.startsWith('/') ? '' : '/score/'}${personUrl}`;
    }
    const groupRaw = rowHtml.match(/["']([^"']*score_2015_group\.asp\?[^"']+)["']/);
    let groupUrl = '';
    if (groupRaw) {
      groupUrl = groupRaw[1];
      if (!groupUrl.startsWith('http')) groupUrl = `${KSF_BASE}${groupUrl.startsWith('/') ? '' : '/score/'}${groupUrl}`;
    }

    // 행 내 선수 URL 추출
    for (const urlM of rowHtml.matchAll(/["']([^"']*score_2015_player\.asp\?[^"']+)["']/g)) {
      let href = urlM[1];
      if (!href.startsWith('http')) {
        href = `${KSF_BASE}${href.startsWith('/') ? '' : '/score/'}${href}`;
      }
      if (seen.has(href)) continue;
      seen.add(href);

      const nearDate = dateHits.filter(d => d.pos <= rowM.index).at(-1);

      results.push({
        eventLabel:   eventLabel || generateLabel(href),
        playerUrl:    href,
        personUrl,
        groupUrl,
        scheduleDate: nearDate?.text || '',
        scheduleTime,
        scheduleTimes,
      });
    }
  }

  return results;
}

// ── 선수목록 페이지에서 이벤트 제목 추출 (선택) ────────────
function extractPageTitle(html) {
  // caption 또는 heading 에서 종목명 힌트 추출
  for (const pat of [
    /<caption[^>]*>([\s\S]*?)<\/caption>/gi,
    /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi,
  ]) {
    for (const m of html.matchAll(pat)) {
      const t = stripTags(m[1]).trim();
      if (t.length > 3 && /[가-힣]/.test(t) && /(소총|권총|트랩|스키트|공기|m\s*공기|장애)/.test(t)) {
        return t;
      }
    }
  }
  return '';
}

// ── 선수목록 페이지 파싱 ────────────────────────────────
function parsePlayerTable(html, eventLabel) {
  const players = [];

  const allTds = [];
  for (const m of html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    allTds.push(stripTags(m[1]).trim());
  }

  const BIB_RE = /^\d{1,3}\s*[-–]\s*[\dA-Za-z]{1,4}$/;

  for (let i = 0; i < allTds.length; i++) {
    const bib = allTds[i];
    if (!BIB_RE.test(bib)) continue;

    const rowCells = [];
    for (let j = i + 1; j < allTds.length && j <= i + 6; j++) {
      if (BIB_RE.test(allTds[j])) break;
      rowCells.push(allTds[j]);
    }

    const nonEmpty = rowCells.filter(v => v !== '');
    let teamType = '', affiliation = '', name = '', birthYear = '';

    // 생년 셀 패턴: 2자리(95), 4자리(1995), 6자리(950101) 숫자
    const BIRTH_RE = /^(\d{4}|\d{2}|\d{6})$/;
    const isBirth = v => BIRTH_RE.test(v) && !BIB_RE.test(v);

    if (nonEmpty.length >= 3) {
      teamType = nonEmpty[0];
      // 중간에 생년 셀이 있으면 추출
      const mid = nonEmpty.slice(1, -2);
      const bIdx = mid.findIndex(isBirth);
      if (bIdx !== -1) {
        const raw = mid[bIdx];
        birthYear = raw.length === 2 ? (parseInt(raw) > 30 ? '19' + raw : '20' + raw) : raw.slice(0, 4);
      }
      affiliation = nonEmpty[nonEmpty.length - 2];
      name        = nonEmpty[nonEmpty.length - 1];
    } else if (nonEmpty.length === 2) {
      affiliation = nonEmpty[0];
      name        = nonEmpty[1];
    } else if (nonEmpty.length === 1) {
      name = nonEmpty[0];
    }

    if (!name || /^\d+$/.test(name) || BIB_RE.test(name)) continue;

    const bibNorm = bib.replace(/\s+/g, '').replace(/[–—]/g, '-');
    const [group = '', lane = ''] = bibNorm.split('-');
    players.push({ event: eventLabel, bib: bibNorm, group, lane, name, affiliation, teamType, birthYear });
  }

  console.log(`    [parse] td수=${allTds.length}, 선수=${players.length}명` +
    (players.length > 0 ? `, 샘플: ${players[0].name}(${players[0].bib})` : ''));
  return players;
}

// ── 메인: 대회코드 + 이름으로 사대번호 검색 ─────────────
// searchMode: 'name' (기본) | 'team' (소속 검색)
export async function searchBib(compCode, searchName, searchMode = 'name') {
  console.log(`\n[BIB] ▶ 검색 시작 — 대회: ${compCode}, ${searchMode === 'team' ? '소속' : '이름'}: "${searchName}"`);

  const gameUrl  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const gameHtml = await fetchHtml(gameUrl);
  const events   = parseGameLinks(gameHtml);

  console.log(`[BIB] 종목 ${events.length}개 발견`);
  if (events.length === 0) {
    return { ok: false, error: '종목 링크를 찾을 수 없습니다. 사대배정표가 아직 게시되지 않았을 수 있습니다.' };
  }

  // 병렬 fetch — td 10개 미만이면 빈 페이지(미사용 종목)로 간주하고 스킵
  const fetched = await Promise.allSettled(
    events.map(async ({ eventLabel, playerUrl, personUrl, groupUrl, scheduleDate, scheduleTime, scheduleTimes }) => {
      try {
        const html      = await fetchHtml(playerUrl);
        const tdCount   = (html.match(/<td/gi) || []).length;
        if (tdCount < 10) {
          console.log(`[BIB]   ${eventLabel} → 빈 페이지 (td ${tdCount}개) 스킵`);
          return [];
        }
        const players   = parsePlayerTable(html, eventLabel);
        console.log(`[BIB]   ${eventLabel} → ${players.length}명` +
          (scheduleDate ? ` (${scheduleDate} ${scheduleTime})` : scheduleTime ? ` (${scheduleTime})` : ''));
        return players.map(p => ({
          ...p,
          scheduleDate,
          scheduleTime: (scheduleTimes && scheduleTimes[p.group]) ? scheduleTimes[p.group] : scheduleTime,
          personUrl: personUrl || '',
          groupUrl: groupUrl || '',
        }));
      } catch (e) {
        console.log(`[BIB]   ${eventLabel} → 오류: ${e.message}`);
        return [];
      }
    })
  );

  const allPlayers = fetched
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  console.log(`[BIB] 총 ${allPlayers.length}명 파싱 완료`);

  const searchLower = searchName.toLowerCase();
  const matched = searchMode === 'team'
    ? allPlayers.filter(p => p.affiliation && p.affiliation.toLowerCase().includes(searchLower))
    : allPlayers.filter(p => p.name.includes(searchName));
  console.log(`[BIB] "${searchName}" (${searchMode}) 검색 결과: ${matched.length}건`);

  return { ok: true, total: allPlayers.length, matched, allPlayers, searchMode };
}

export async function getCompInfo(compCode) {
  const gameUrl  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const gameHtml = await fetchHtml(gameUrl);
  const title    = (gameHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '';
  const events   = parseGameLinks(gameHtml);
  return { compCode, title, eventCount: events.length };
}

// ── 게임 페이지 원본 반환 (디버그용) ─────────────────────
export async function getGamePageHtml(compCode) {
  const url  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const html = await fetchHtml(url);
  const events = parseGameLinks(html);
  return { html, events };
}

// ── 대회 목록 + 상태 분류 ─────────────────────────────────
function parseDateRange(dateStr, year) {
  const s = (dateStr || '').replace(/\s/g, '');

  // "4.30~5.6" 또는 "4.30-5.6" (월 다름)
  let m = s.match(/^(\d{1,2})\.(\d{1,2})[~\-](\d{1,2})\.(\d{1,2})$/);
  if (m) {
    const startDate = new Date(year, +m[1] - 1, +m[2]);
    const endYear   = +m[3] < +m[1] ? year + 1 : year;
    return { startDate, endDate: new Date(endYear, +m[3] - 1, +m[4]) };
  }

  // "3.25~31" (같은 월)
  m = s.match(/^(\d{1,2})\.(\d{1,2})[~\-](\d{1,2})$/);
  if (m) {
    return {
      startDate: new Date(year, +m[1] - 1, +m[2]),
      endDate:   new Date(year, +m[1] - 1, +m[3]),
    };
  }

  // "5.6" (단일)
  m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (m) {
    const d = new Date(year, +m[1] - 1, +m[2]);
    return { startDate: d, endDate: d };
  }

  return { startDate: null, endDate: null };
}

export async function getCompList() {
  const html  = await fetchHtml(`${KSF_BASE}/score/score_2015_list.asp`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const year  = today.getFullYear();
  const comps = [];

  for (const rowM of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row   = rowM[1];
    const linkM = row.match(/href=["']([^"']*score_2015_game\.asp\?jname=([^"'&\s]+))[^"']*/i);
    if (!linkM) continue;

    const jname = linkM[2].trim();
    if (!jname) continue;

    const nameM   = row.match(/<td[^>]*class="title"[^>]*>([\s\S]*?)<\/td>/i);
    const name    = nameM ? stripTags(nameM[1]).trim() : jname;

    const dateM   = row.match(/<td[^>]*class="date"[^>]*>([\s\S]*?)<\/td>/i);
    const dateStr = dateM ? stripTags(dateM[1]).trim() : '';

    const venueM  = row.match(/<td[^>]*class="(?:local|venue|location)"[^>]*>([\s\S]*?)<\/td>/i);
    let venue     = venueM ? stripTags(venueM[1]).trim() : '';
    if (!venue) {
      const allTds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m2 => stripTags(m2[1]).trim()).filter(Boolean);
      for (let i = allTds.length - 1; i >= 0; i--) {
        const t = allTds[i];
        if (/[가-힣]/.test(t) && !t.includes('~') && !t.match(/^\d/) && t !== name) {
          venue = t; break;
        }
      }
    }

    const { startDate, endDate } = parseDateRange(dateStr, year);

    let status = 'past';
    if (startDate && endDate) {
      const now = today.getTime();
      if (now >= startDate.getTime() && now <= endDate.getTime()) status = 'ongoing';
      else if (now < startDate.getTime())                          status = 'upcoming';
    }

    comps.push({
      jname, name, dateStr, venue,
      startDate: startDate ? `${startDate.getMonth()+1}.${startDate.getDate()}` : null,
      endDate:   endDate   ? `${endDate.getMonth()+1}.${endDate.getDate()}`     : null,
      status,
    });
  }

  return comps;
}

// ── 순위 페이지 파싱 (개인 / 단체 공통) ──────────────────
export async function getEventRankings(url) {
  const html    = await fetchHtml(url);
  const headers = [];
  const rows    = [];
  let   headerFound = false;

  for (const rowM of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowM[1];

    if (!headerFound) {
      const ths = [...rowHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)];
      if (ths.length > 0) {
        ths.forEach(t => headers.push(stripTags(t[1]).replace(/\s+/g, ' ').trim()));
        headerFound = true;
        continue;
      }
    }

    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m2 => stripTags(m2[1]).replace(/\s+/g, ' ').trim());

    if (cells.length < 3) continue;
    if (cells.filter(c => c && c !== '-' && c !== '–').length < 2) continue;

    rows.push(cells);
  }

  return { headers, rows };
}
