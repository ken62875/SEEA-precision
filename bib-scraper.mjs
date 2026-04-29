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

// ── 게임 페이지에서 이벤트 목록 + 일정 추출 ─────────────
function parseGameLinks(html) {
  const seen    = new Set();
  const results = [];

  // tr 행 단위로 스캔: 종목명 · URL · 날짜 · 시간 동시 추출
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];

    // 이 행에 player URL 있는지 확인
    const urlMatches = [
      ...rowHtml.matchAll(/["']([^"']*score_2015_player\.asp\?[^"']+)["']/gi),
    ];
    if (urlMatches.length === 0) continue;

    // 이 행의 모든 td 텍스트
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => stripTags(m[1]).trim());
    const rowText = tds.join(' ');

    // 날짜 패턴 (2026.04.30, 2026-04-30, 4월30일, 04/30 등)
    const dateM = rowText.match(
      /(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})|(\d{1,2}월\s*\d{1,2}일)|(\d{1,2}\/\d{1,2})/
    );
    // 시간 패턴 (09:00, 14:30 등)
    const timeM = rowText.match(/\b(\d{1,2}:\d{2})\b/);
    const scheduleDate = dateM ? dateM[0].replace(/\s/g, '') : '';
    const scheduleTime = timeM ? timeM[1] : '';

    for (const urlM of urlMatches) {
      let href = urlM[1];
      if (!href.startsWith('http')) {
        href = `${KSF_BASE}${href.startsWith('/') ? '' : '/score/'}${href}`;
      }
      if (seen.has(href)) continue;
      seen.add(href);

      // 앵커 텍스트에서 종목명 추출 시도
      const escaped = urlM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const anchorM  = rowHtml.match(
        new RegExp(`href=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/a>`, 'i')
      );
      const anchorText = anchorM ? stripTags(anchorM[1]).trim() : '';
      // KSF 링크 텍스트는 보통 "출전자정보", "선수명단" 등 비종목명 → 제외
      const SKIP_TEXTS = ['선수명단','보기','클릭','확인','명단','출전자정보','출전자 정보','정보'];
      const isUseful   = anchorText.length >= 4
        && /[가-힣]/.test(anchorText)
        && !SKIP_TEXTS.includes(anchorText)
        && /(소총|권총|트랩|스키트|공기|복사|3자세|장애|권)/.test(anchorText);

      // td 중 KSF 종목 키워드 포함 셀 (한글 종목명)
      const eventKw = /(소총|권총|트랩|스키트|공기|복사|3자세|장애)/;
      const rowHint = tds.find(t => eventKw.test(t) && /[가-힣]{2,}/.test(t)) || '';

      const eventLabel = isUseful ? anchorText
        : (rowHint || generateLabel(href));

      results.push({ eventLabel, playerUrl: href, scheduleDate, scheduleTime });
    }
  }

  // 폴백: <tr> 바깥에 있는 URL
  for (const m of html.matchAll(/["']([^"']*score_2015_player\.asp\?[^"']+)["']/gi)) {
    let href = m[1];
    if (!href.startsWith('http')) {
      href = `${KSF_BASE}${href.startsWith('/') ? '' : '/score/'}${href}`;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({
      eventLabel: generateLabel(href),
      playerUrl:  href,
      scheduleDate: '',
      scheduleTime: '',
    });
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

  const BIB_RE = /^\d{1,3}\s*[-–]\s*\d{1,4}$/;

  for (let i = 0; i < allTds.length; i++) {
    const bib = allTds[i];
    if (!BIB_RE.test(bib)) continue;

    const rowCells = [];
    for (let j = i + 1; j < allTds.length && j <= i + 6; j++) {
      if (BIB_RE.test(allTds[j])) break;
      rowCells.push(allTds[j]);
    }

    const nonEmpty = rowCells.filter(v => v !== '');
    let teamType = '', affiliation = '', name = '';

    if (nonEmpty.length >= 3) {
      teamType    = nonEmpty[0];
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
    players.push({ event: eventLabel, bib: bibNorm, group, lane, name, affiliation, teamType });
  }

  console.log(`    [parse] td수=${allTds.length}, 선수=${players.length}명` +
    (players.length > 0 ? `, 샘플: ${players[0].name}(${players[0].bib})` : ''));
  return players;
}

// ── 메인: 대회코드 + 이름으로 사대번호 검색 ─────────────
export async function searchBib(compCode, searchName) {
  console.log(`\n[BIB] ▶ 검색 시작 — 대회: ${compCode}, 이름: "${searchName}"`);

  const gameUrl  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const gameHtml = await fetchHtml(gameUrl);
  const events   = parseGameLinks(gameHtml);

  console.log(`[BIB] 종목 ${events.length}개 발견`);
  if (events.length === 0) {
    return { ok: false, error: '종목 링크를 찾을 수 없습니다. 사대배정표가 아직 게시되지 않았을 수 있습니다.' };
  }

  // 병렬 fetch
  const fetched = await Promise.allSettled(
    events.map(async ({ eventLabel, playerUrl, scheduleDate, scheduleTime }) => {
      try {
        const html      = await fetchHtml(playerUrl);
        // 선수 페이지 자체에 종목명이 있으면 우선 사용
        const pageTitle = extractPageTitle(html);
        const label     = pageTitle || eventLabel;
        const players   = parsePlayerTable(html, label);
        console.log(`[BIB]   ${label} → ${players.length}명` +
          (scheduleDate ? ` (${scheduleDate} ${scheduleTime})` : ''));
        return players.map(p => ({ ...p, scheduleDate, scheduleTime }));
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

  const matched = allPlayers.filter(p => p.name.includes(searchName));
  console.log(`[BIB] "${searchName}" 검색 결과: ${matched.length}건`);

  return { ok: true, total: allPlayers.length, matched };
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
